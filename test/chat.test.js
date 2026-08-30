'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const EMBED_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'embed.js'), 'utf8');

/**
 * Load embed.js in a jsdom environment with chat-supporting config.
 */
function loadEmbedWithChat(scriptAttrs, extraWindow) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'dangerously',
    });
    const window = dom.window;

    window.fetch = function (url, init) {
        return Promise.resolve({ ok: true });
    };
    window.navigator.sendBeacon = function () { return true; };

    if (extraWindow) {
        Object.assign(window, extraWindow);
    }

    const scriptEl = window.document.createElement('script');
    for (const [key, value] of Object.entries(scriptAttrs || {})) {
        scriptEl.setAttribute('data-' + key, value);
    }
    scriptEl.setAttribute('src', 'https://zeroaiboss.com/v1/embed.js');
    window.document.body.appendChild(scriptEl);
    Object.defineProperty(window.document, 'currentScript', { value: scriptEl, configurable: true });

    window.eval(EMBED_SRC);

    return new Promise((resolve) => {
        if (window.document.readyState !== 'loading') {
            resolve(window);
            return;
        }
        window.document.addEventListener('DOMContentLoaded', () => resolve(window));
    });
}

test('chat module is exposed as sdk.chat when client-id is set', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    assert.ok(window.ZeroAI.chat, 'sdk.chat should be defined');
    assert.equal(typeof window.ZeroAI.chat.open,   'function');
    assert.equal(typeof window.ZeroAI.chat.close,  'function');
    assert.equal(typeof window.ZeroAI.chat.toggle, 'function');
    assert.equal(typeof window.ZeroAI.chat.mount,  'function');
});

test('sdk.chat is absent when no client-id is configured', async () => {
    const window = await loadEmbedWithChat({});
    assert.equal(window.ZeroAI.chat, undefined, 'no sdk.chat without a client-id');
});

test('sdk.chat is absent when modules explicitly excludes chat', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client', modules: 'tracking' });
    assert.equal(window.ZeroAI.chat, undefined, 'chat module not loaded when not in modules list');
});

test('launcher button is mounted in document.body', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    const launcher = window.document.getElementById('zeroai-chat-launcher');
    assert.ok(launcher, 'launcher button should exist in the DOM');
    assert.equal(launcher.tagName, 'BUTTON');
    assert.equal(launcher.getAttribute('aria-expanded'), 'false');
});

test('chat overlay is hidden initially', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    const overlay = window.document.getElementById('zeroai-chat-overlay');
    assert.ok(overlay, 'overlay should exist in the DOM');
    assert.equal(overlay.style.display, 'none');
});

test('chat iframe points to /widget/chat.php with correct params', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'shop-1', 'org-id': 'org-99', locale: 'fr' });
    const iframe = window.document.querySelector('#zeroai-chat-overlay iframe');
    assert.ok(iframe, 'iframe should exist inside overlay');
    assert.ok(iframe.src.includes('/widget/chat.php'), 'iframe src should point to /widget/chat.php');
    assert.ok(iframe.src.includes('client_id=shop-1'), 'client_id param present');
    assert.ok(iframe.src.includes('org_id='), 'org_id param present');
    assert.ok(iframe.src.includes('locale=fr'), 'locale param present');
});

test('chat iframe includes agent_id when data-chat-agent-id is set', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'shop-1', 'chat-agent-id': '42' });
    const iframe = window.document.querySelector('#zeroai-chat-overlay iframe');
    assert.ok(iframe.src.includes('agent_id=42'), 'agent_id param should be in iframe src');
});

test('sdk.chat.open() shows overlay and dispatches zeroai:chat-opened', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    let eventFired = false;
    let eventDetail = null;
    window.document.addEventListener('zeroai:chat-opened', (e) => {
        eventFired = true;
        eventDetail = e.detail;
    });
    window.ZeroAI.chat.open();
    const overlay = window.document.getElementById('zeroai-chat-overlay');
    assert.equal(overlay.style.display, 'block');
    assert.equal(window.document.getElementById('zeroai-chat-launcher').getAttribute('aria-expanded'), 'true');
    assert.equal(eventFired, true, 'zeroai:chat-opened should be dispatched');
    assert.ok(eventDetail && eventDetail.visitorId, 'detail should include visitorId');
});

test('sdk.chat.close() hides overlay and dispatches zeroai:chat-closed', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    window.ZeroAI.chat.open();
    let closeFired = false;
    window.document.addEventListener('zeroai:chat-closed', () => { closeFired = true; });
    window.ZeroAI.chat.close();
    const overlay = window.document.getElementById('zeroai-chat-overlay');
    assert.equal(overlay.style.display, 'none');
    assert.equal(window.document.getElementById('zeroai-chat-launcher').getAttribute('aria-expanded'), 'false');
    assert.equal(closeFired, true, 'zeroai:chat-closed should be dispatched');
});

test('sdk.chat.open() is idempotent — second call does not re-fire the event', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    let count = 0;
    window.document.addEventListener('zeroai:chat-opened', () => count++);
    window.ZeroAI.chat.open();
    window.ZeroAI.chat.open(); // second call should be a no-op
    assert.equal(count, 1);
});

test('sdk.chat.toggle() alternates between open and closed', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    const overlay = window.document.getElementById('zeroai-chat-overlay');
    window.ZeroAI.chat.toggle();
    assert.equal(overlay.style.display, 'block');
    window.ZeroAI.chat.toggle();
    assert.equal(overlay.style.display, 'none');
});

test('postMessage zeroai:close from iframe triggers close()', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    window.ZeroAI.chat.open();
    let closeFired = false;
    window.document.addEventListener('zeroai:chat-closed', () => { closeFired = true; });

    const iframe = window.document.querySelector('#zeroai-chat-overlay iframe');
    // Simulate iframe posting a close message to the parent window.
    const messageEvent = new window.MessageEvent('message', {
        data:   { type: 'zeroai:close' },
        source: iframe.contentWindow,
    });
    window.dispatchEvent(messageEvent);

    const overlay = window.document.getElementById('zeroai-chat-overlay');
    assert.equal(overlay.style.display, 'none');
    assert.equal(closeFired, true);
});

test('postMessage zeroai:lead-captured from iframe calls sdk.track.bindLead', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    const fetchCalls = [];
    window.fetch = function (url, init) {
        fetchCalls.push({ url, init });
        return Promise.resolve({ ok: true });
    };

    // Manually dispatch sdk.ready so sdk.visitorId exists (happens during loadEmbedWithChat).
    const iframe = window.document.querySelector('#zeroai-chat-overlay iframe');
    const messageEvent = new window.MessageEvent('message', {
        data:   { type: 'zeroai:lead-captured', payload: { lead_id: 77 } },
        source: iframe.contentWindow,
    });
    window.dispatchEvent(messageEvent);

    // sdk.track.bindLead calls /track/visitor-lead (via fetch or beacon).
    // Give the Promise a tick to resolve.
    await new Promise(r => setTimeout(r, 10));
    const bindCall = fetchCalls.find(c => c.url.includes('/track/visitor-lead'));
    assert.ok(bindCall, '/track/visitor-lead should have been called');
    const body = JSON.parse(bindCall.init.body);
    assert.equal(body.lead_id, 77);
});

test('messages from non-iframe sources are ignored', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    let closeFired = false;
    window.document.addEventListener('zeroai:chat-closed', () => { closeFired = true; });

    // A message from a different source (null / top-level) should be ignored.
    const messageEvent = new window.MessageEvent('message', {
        data:   { type: 'zeroai:close' },
        source: null,
    });
    window.dispatchEvent(messageEvent);
    assert.equal(closeFired, false, 'message from non-iframe source should be ignored');
});

test('mounting twice is a no-op (guard against double init)', async () => {
    const window = await loadEmbedWithChat({ 'client-id': 'test-client' });
    window.ZeroAI.chat.mount();
    window.ZeroAI.chat.mount();
    const launchers = window.document.querySelectorAll('#zeroai-chat-launcher');
    assert.equal(launchers.length, 1, 'only one launcher should exist after multiple mount() calls');
});
