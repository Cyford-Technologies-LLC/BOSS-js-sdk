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
        return Promise.resolve({ ok: true });
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

test('loading the script twice on the same page is a no-op the second time', async () => {
    const { window } = await loadEmbed({ 'client-id': 'org-1' });
    const firstInstance = window.ZeroAI;
    window.eval(EMBED_SRC);
    assert.equal(window.ZeroAI, firstInstance, 'second eval left the original SDK instance in place');
});
