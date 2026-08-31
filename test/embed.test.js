'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const EMBED_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'embed.js'), 'utf8');

/**
 * Builds a fresh jsdom window with a <script data-client-id="..."> tag
 * (playing the role of document.currentScript) and evaluates embed.js in it,
 * with a mocked fetch/sendBeacon so no real network call happens. Resolves
 * once embed.js's own DOMContentLoaded-deferred init() has actually run.
 */
function loadEmbed(scriptAttrs) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://example-shop.test/checkout',
        runScripts: 'dangerously',
    });
    const window = dom.window;

    const fetchCalls = [];
    window.fetch = function (url, init) {
        fetchCalls.push({ url, init });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    };

    const beaconCalls = [];
    window.navigator.sendBeacon = function (url, blob) {
        beaconCalls.push({ url, blob });
        return true;
    };

    const scriptEl = window.document.createElement('script');
    for (const [key, value] of Object.entries(scriptAttrs || {})) {
        scriptEl.setAttribute('data-' + key, value);
    }
    scriptEl.setAttribute('src', 'https://zeroaiboss.com/v1/embed.js');
    window.document.body.appendChild(scriptEl);
    Object.defineProperty(window.document, 'currentScript', { value: scriptEl, configurable: true });

    window.eval(EMBED_SRC);

    // jsdom's initial document.readyState is 'loading' until it finishes its own
    // synthetic load sequence, so embed.js (correctly) defers init() to
    // DOMContentLoaded rather than running synchronously - wait for that same
    // event here instead of asserting before it has fired.
    return new Promise((resolve) => {
        if (window.document.readyState !== 'loading') {
            resolve({ window, fetchCalls, beaconCalls });
            return;
        }
        window.document.addEventListener('DOMContentLoaded', () => {
            resolve({ window, fetchCalls, beaconCalls });
        });
    });
}

test('reads config from data-* attributes on the script tag', async () => {
    const { window } = await loadEmbed({ 'client-id': 'abc123', environment: 'production', locale: 'fr' });
    assert.equal(window.ZeroAI.config.clientId, 'abc123');
    assert.equal(window.ZeroAI.config.orgId, 'abc123');
    assert.equal(window.ZeroAI.config.baseUrl, 'https://zeroaiboss.com/api/v2');
    assert.equal(window.ZeroAI.config.locale, 'fr');
});

test('warns but does not throw when data-client-id is missing', async () => {
    const { window } = await loadEmbed({});
    assert.equal(window.ZeroAI.config.orgId, '');
    assert.ok(window.ZeroAI.__bossEmbed, 'SDK still initializes without a client id');
});

test('generates a visitor id shaped like a UUID/hex string', async () => {
    const { window } = await loadEmbed({ 'client-id': 'abc123' });
    assert.match(window.ZeroAI.visitorId, /^[0-9a-f-]{20,}$/i);
});

test('exposes ready() which fires immediately once already initialized', async () => {
    const { window } = await loadEmbed({ 'client-id': 'abc123' });
    let calledWith = null;
    window.ZeroAI.ready((sdk) => { calledWith = sdk; });
    assert.equal(calledWith, window.ZeroAI);
});

test('track.visitor() posts to /track/visitor with org_id and page context', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42' });
    // The automatic page-view fire happens during init - assert on that instead
    // of calling track.visitor() again, to keep this aligned with real behavior.
    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.equal(fetchCalls[0].url, 'https://zeroaiboss.com/api/v2/track/visitor');
    assert.equal(body.org_id, 'org-42');
    assert.equal(body.page_url, 'https://example-shop.test/checkout');
    assert.equal(body.fingerprint_hash, window.ZeroAI.visitorId);
    assert.equal(fetchCalls[0].init.headers['X-Client-Name'], 'boss-js-sdk');
    assert.equal(fetchCalls[0].init.headers['X-Client-Version'], window.ZeroAI.version);
});

test('track.event() uses sendBeacon, not fetch, so it survives page unload', async () => {
    const { window, beaconCalls, fetchCalls } = await loadEmbed({ 'client-id': 'org-42' });
    const fetchCountBefore = fetchCalls.length;
    window.ZeroAI.track.event('add_to_cart', { sku: 'ABC-1' });
    assert.equal(beaconCalls.length, 1);
    assert.equal(fetchCalls.length, fetchCountBefore, 'did not fall back to fetch when sendBeacon succeeded');
    assert.equal(beaconCalls[0].url, 'https://zeroaiboss.com/api/v2/track/visitor-event');
});

test('a sandbox environment without data-base-url does not crash init', async () => {
    const { window } = await loadEmbed({ 'client-id': 'org-42', environment: 'sandbox' });
    assert.equal(window.ZeroAI.config.baseUrl, '');
    assert.ok(window.ZeroAI.__bossEmbed);
});

test('track.identify() dispatches zeroai:visitor-identified after a successful call', async () => {
    const { window } = await loadEmbed({ 'client-id': 'org-42' });
    let detail = null;
    window.document.addEventListener('zeroai:visitor-identified', (e) => { detail = e.detail; });
    await window.ZeroAI.track.identify({ identity_type: 'email', identity_value: 'a@b.com' });
    assert.deepEqual(detail, { identity_type: 'email', identity_value: 'a@b.com' });
});

test('track.bindLead() dispatches zeroai:lead-captured after a successful call', async () => {
    const { window } = await loadEmbed({ 'client-id': 'org-42' });
    let fired = false;
    window.document.addEventListener('zeroai:lead-captured', () => { fired = true; });
    await window.ZeroAI.track.bindLead({ lead_id: 9 });
    assert.equal(fired, true);
});

test('a failed tracking fetch dispatches zeroai:error instead of throwing', async () => {
    const { window } = await loadEmbed({ 'client-id': 'org-42' });
    window.fetch = () => Promise.reject(new Error('network down'));
    let errorDetail = null;
    window.document.addEventListener('zeroai:error', (e) => { errorDetail = e.detail; });
    await window.ZeroAI.track.identify({ identity_type: 'email' });
    assert.equal(errorDetail.source, 'track');
    assert.equal(errorDetail.path, '/track/visitor-identity');
});

// BOSS project 43 feature #127 - forms module unifies lead_capture's public embed
// submission endpoint under the JS SDK's object/event vocabulary.
test('forms.submit() posts to the lead_capture endpoint with org_id and form_id in the URL', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42' });
    const fetchCountBefore = fetchCalls.length;
    await window.ZeroAI.forms.submit(7, { email: 'a@b.com' });
    assert.equal(fetchCalls.length, fetchCountBefore + 1);
    const call = fetchCalls[fetchCalls.length - 1];
    assert.equal(call.url, 'https://zeroaiboss.com/api/lead_capture/submit.php?org_id=org-42&form_id=7');
    assert.deepEqual(JSON.parse(call.init.body), { email: 'a@b.com' });
});

test('forms.submit() dispatches zeroai:lead-captured on success', async () => {
    const { window } = await loadEmbed({ 'client-id': 'org-42' });
    window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, lead_id: 99 }) });
    let detail = null;
    window.document.addEventListener('zeroai:lead-captured', (e) => { detail = e.detail; });
    await window.ZeroAI.forms.submit(7, { email: 'a@b.com' });
    assert.equal(detail.formId, 7);
    assert.equal(detail.leadId, 99);
    assert.equal(detail.source, 'form');
});

test('forms.submit() dispatches zeroai:error instead of throwing on a server-side rejection', async () => {
    const { window } = await loadEmbed({ 'client-id': 'org-42' });
    window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false, error: 'Field "Email" is required' }) });
    let errorDetail = null;
    window.document.addEventListener('zeroai:error', (e) => { errorDetail = e.detail; });
    await window.ZeroAI.forms.submit(7, {});
    assert.equal(errorDetail.source, 'forms');
    assert.equal(errorDetail.message, 'Field "Email" is required');
});

// BOSS project 43 feature #128 - push.getWebConfig() wraps the public
// firebase.web_config route. Actual FCM registration is out of scope for this
// SDK - see the comment above buildPush() in embed.js for why.
test('push.getWebConfig() gets /firebase/web-config with org_id', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42' });
    await window.ZeroAI.push.getWebConfig();
    const call = fetchCalls[fetchCalls.length - 1];
    assert.equal(call.url, 'https://zeroaiboss.com/api/v2/firebase/web-config?org_id=org-42');
});

test('push.getWebConfig() includes company_id when data-company-id is set', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42', 'company-id': '18' });
    await window.ZeroAI.push.getWebConfig();
    const call = fetchCalls[fetchCalls.length - 1];
    assert.equal(call.url, 'https://zeroaiboss.com/api/v2/firebase/web-config?org_id=org-42&company_id=18');
});

// BOSS project 43 feature #130 - errors module reports uncaught browser errors
// to the public POST /errors/browser route (org_id in body, no credential).
test('errors.report() posts to /errors/browser with title/message/context', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42' });
    const fetchCountBefore = fetchCalls.length;
    await window.ZeroAI.errors.report({ title: 'Boom', message: 'Boom', file: 'app.js', line: 10 });
    assert.equal(fetchCalls.length, fetchCountBefore + 1);
    const call = fetchCalls[fetchCalls.length - 1];
    assert.equal(call.url, 'https://zeroaiboss.com/api/v2/errors/browser');
    const body = JSON.parse(call.init.body);
    assert.equal(body.org_id, 'org-42');
    assert.equal(body.title, 'Boom');
    assert.equal(body.file, 'app.js');
    assert.equal(body.line, 10);
    assert.equal(body.severity, 'error');
});

test('window.onerror is auto-hooked under the default "auto" module', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42' });
    const fetchCountBefore = fetchCalls.length;
    window.dispatchEvent(new window.ErrorEvent('error', {
        message: 'Uncaught TypeError: x is not a function',
        filename: 'https://example-shop.test/app.js',
        lineno: 42,
    }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(fetchCalls.length, fetchCountBefore + 1);
    const body = JSON.parse(fetchCalls[fetchCalls.length - 1].init.body);
    assert.equal(body.title, 'Uncaught TypeError: x is not a function');
    assert.equal(body.file, 'https://example-shop.test/app.js');
    assert.equal(body.line, 42);
});

test('unhandledrejection is auto-hooked and reports the rejection reason', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42' });
    const fetchCountBefore = fetchCalls.length;
    const evt = new window.Event('unhandledrejection');
    evt.reason = new window.Error('promise blew up');
    window.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(fetchCalls.length, fetchCountBefore + 1);
    const body = JSON.parse(fetchCalls[fetchCalls.length - 1].init.body);
    assert.equal(body.title, 'promise blew up');
});

test('errors.install() does not double-hook when called an extra time', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42' });
    window.ZeroAI.errors.install();
    const fetchCountBefore = fetchCalls.length;
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'dup check' }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(fetchCalls.length, fetchCountBefore + 1, 'listener registered exactly once despite install() being called an extra time');
});

test('data-modules excluding auto/errors does not auto-hook window.onerror', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42', modules: 'tracking' });
    const fetchCountBefore = fetchCalls.length;
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'should not be reported' }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(fetchCalls.length, fetchCountBefore, 'no auto-hook installed when modules excludes errors/auto');
});

// BOSS project 43 feature #131 - funnels module fires funnel-step events to
// the public POST /funnels/event/browser route (org_id in body, no credential).
test('funnels.event() posts to /funnels/event/browser with event_type, fingerprint_hash, org_id', async () => {
    const { window, fetchCalls } = await loadEmbed({ 'client-id': 'org-42' });
    const fetchCountBefore = fetchCalls.length;
    await window.ZeroAI.funnels.event('page_visit', { metadata: { url: 'https://example-shop.test/pricing' } });
    assert.equal(fetchCalls.length, fetchCountBefore + 1);
    const call = fetchCalls[fetchCalls.length - 1];
    assert.equal(call.url, 'https://zeroaiboss.com/api/v2/funnels/event/browser');
    const body = JSON.parse(call.init.body);
    assert.equal(body.org_id, 'org-42');
    assert.equal(body.event_type, 'page_visit');
    assert.equal(body.fingerprint_hash, window.ZeroAI.visitorId);
    assert.deepEqual(body.metadata, { url: 'https://example-shop.test/pricing' });
});

test('funnels.event() dispatches zeroai:error instead of throwing on a network failure', async () => {
    const { window } = await loadEmbed({ 'client-id': 'org-42' });
    window.fetch = () => Promise.reject(new Error('network down'));
    let errorDetail = null;
    window.document.addEventListener('zeroai:error', (e) => { errorDetail = e.detail; });
    await window.ZeroAI.funnels.event('form_submit', {});
    assert.equal(errorDetail.source, 'funnels');
});

test('loading the script twice on the same page is a no-op the second time', async () => {
    const { window } = await loadEmbed({ 'client-id': 'org-1' });
    const firstInstance = window.ZeroAI;
    window.eval(EMBED_SRC);
    assert.equal(window.ZeroAI, firstInstance, 'second eval left the original SDK instance in place');
});
