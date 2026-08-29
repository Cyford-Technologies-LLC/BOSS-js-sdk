/**
 * ZeroAI BOSS JS SDK - embeddable client for third-party websites.
 *
 * Loaded via a single script tag (async, deferred), reads config from the
 * tag's data-* attributes, and never requires a build step or npm install on
 * the consuming site - the same "drop a script tag in, done" model as GA4 or
 * a Meta Pixel:
 *
 *   <script async src="https://zeroaiboss.com/v1/embed.js"
 *           data-client-id="YOUR_CLIENT_ID"></script>
 *
 * Design constraints (project 43 planning, 2026-08-29):
 *  - Vanilla JS, no framework, no bundler required to consume this file -
 *    keeps the embed tiny, since it ships to every visitor's browser.
 *  - Public/origin-restricted routes only (visitor tracking) - this file
 *    never holds or transmits a private bearer token or client secret.
 *  - Tenant identity for tracking calls is org_id/company_id in the request
 *    body (matches TrackingHandler's public_system auth - see ad-pixels
 *    manifest), not a signed-client HMAC, since a page-embedded script can't
 *    keep a secret from the visitor viewing page source.
 *  - CustomEvents on `document` so a host page's own analytics/marketing
 *    code can react without polling anything.
 */
(function (window, document) {
    'use strict';

    if (window.ZeroAI && window.ZeroAI.__bossEmbed) {
        return; // Already loaded on this page - never double-init.
    }

    var STORAGE_KEY = 'zeroai_visitor_id';
    var readyCallbacks = [];
    var isReady = false;

    // ---- Config -------------------------------------------------------------

    function currentScriptTag() {
        // document.currentScript is null once this file runs asynchronously in
        // some browsers/timing conditions - fall back to the last <script> whose
        // src points at this file.
        if (document.currentScript) {
            return document.currentScript;
        }
        var scripts = document.getElementsByTagName('script');
        for (var i = scripts.length - 1; i >= 0; i--) {
            if (/embed\.js/.test(scripts[i].src || '')) {
                return scripts[i];
            }
        }
        return null;
    }

    function readConfig(tag) {
        var data = (tag && tag.dataset) || {};
        var environment = data.environment || 'production';
        var modulesRaw = data.modules || 'auto';
        return {
            clientId: data.clientId || '',
            orgId: data.orgId || data.clientId || '',
            environment: environment,
            baseUrl: data.baseUrl || defaultBaseUrl(environment),
            modules: modulesRaw === 'auto' ? ['auto'] : modulesRaw.split(',').map(trim),
            locale: data.locale || (navigator.language || 'en'),
            theme: parseThemeTokens(data),
        };
    }

    function defaultBaseUrl(environment) {
        // Production is the only fixed default - a sandbox/self-hosted BOSS has
        // no single fixed host, so data-base-url is required there (fails loud
        // via missingOrgId-style console warning below, not a guessed URL).
        return environment === 'production' ? 'https://zeroaiboss.com/api/v2' : '';
    }

    function parseThemeTokens(data) {
        var theme = {};
        for (var key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key) && key.indexOf('theme') === 0 && key !== 'theme') {
                var tokenName = key.slice('theme'.length);
                tokenName = tokenName.charAt(0).toLowerCase() + tokenName.slice(1);
                theme[tokenName] = data[key];
            }
        }
        return theme;
    }

    function trim(s) {
        return (s || '').replace(/^\s+|\s+$/g, '');
    }

    // ---- Visitor identity -----------------------------------------------------

    function getOrCreateVisitorId() {
        // A stable per-browser random id, not true device fingerprinting - no
        // fingerprinting library dependency, and arguably more privacy-respecting
        // while still letting the backend recognize a returning visitor across
        // page loads on the same site. Falls back to a cookie if localStorage is
        // unavailable (private browsing, storage blocked).
        try {
            var existing = window.localStorage.getItem(STORAGE_KEY);
            if (existing) {
                return existing;
            }
            var generated = generateId();
            window.localStorage.setItem(STORAGE_KEY, generated);
            return generated;
        } catch (e) {
            return getOrCreateVisitorIdCookie();
        }
    }

    function getOrCreateVisitorIdCookie() {
        var match = document.cookie.match(/(?:^|;\s*)zeroai_vid=([^;]+)/);
        if (match) {
            return match[1];
        }
        var generated = generateId();
        var oneYear = 365 * 24 * 60 * 60;
        document.cookie = 'zeroai_vid=' + generated + '; max-age=' + oneYear + '; path=/; SameSite=Lax';
        return generated;
    }

    function generateId() {
        if (window.crypto && window.crypto.randomUUID) {
            return window.crypto.randomUUID();
        }
        var id = '';
        for (var i = 0; i < 32; i++) {
            id += Math.floor(Math.random() * 16).toString(16);
        }
        return id;
    }

    // ---- Transport --------------------------------------------------------

    function sendTrackingRequest(config, path, payload, useBeacon) {
        var body = JSON.stringify(mergeTenantIdentity(config, payload));
        var url = config.baseUrl + path;

        if (useBeacon && navigator.sendBeacon) {
            var blob = new Blob([body], { type: 'application/json' });
            var sent = navigator.sendBeacon(url, blob);
            if (sent) {
                return Promise.resolve({ ok: true, beacon: true });
            }
            // Beacon queuing can fail (payload too large, browser limits) - fall
            // through to fetch rather than silently dropping the event.
        }

        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body,
            keepalive: true, // survives a page unload shortly after the call
        }).catch(function (err) {
            dispatchEvent(config, 'error', { source: 'track', path: path, message: String(err && err.message || err) });
            return null;
        });
    }

    function mergeTenantIdentity(config, payload) {
        var merged = {};
        for (var k in payload) {
            if (Object.prototype.hasOwnProperty.call(payload, k)) {
                merged[k] = payload[k];
            }
        }
        if (!merged.org_id) {
            merged.org_id = config.orgId;
        }
        if (!merged.page_url) {
            merged.page_url = window.location.href;
        }
        if (!merged.referrer) {
            merged.referrer = document.referrer || '';
        }
        return merged;
    }

    // ---- Events -------------------------------------------------------------

    function dispatchEvent(config, name, detail) {
        var event;
        var fullDetail = detail || {};
        try {
            event = new CustomEvent('zeroai:' + name, { detail: fullDetail, bubbles: true });
        } catch (e) {
            // Ancient browsers without CustomEvent constructor support - degrade
            // silently rather than throwing and breaking the host page.
            return;
        }
        document.dispatchEvent(event);
    }

    // ---- Public API -----------------------------------------------------------

    function buildSdk(config) {
        var visitorId = getOrCreateVisitorId();

        var sdk = {
            __bossEmbed: true,
            version: '0.1.0',
            config: config,
            visitorId: visitorId,

            ready: function (callback) {
                if (typeof callback !== 'function') {
                    return;
                }
                if (isReady) {
                    callback(sdk);
                } else {
                    readyCallbacks.push(callback);
                }
            },

            track: {
                visitor: function (data) {
                    return sendTrackingRequest(config, '/track/visitor', withVisitorId(data), false);
                },
                event: function (eventType, data) {
                    return sendTrackingRequest(config, '/track/visitor-event', withVisitorId(mergeInto({ event_type: eventType }, data)), true);
                },
                identify: function (data) {
                    return sendTrackingRequest(config, '/track/visitor-identity', withVisitorId(data), false).then(function (result) {
                        if (result) {
                            dispatchEvent(config, 'visitor-identified', data);
                        }
                        return result;
                    });
                },
                bindLead: function (data) {
                    return sendTrackingRequest(config, '/track/visitor-lead', withVisitorId(data), false).then(function (result) {
                        if (result) {
                            dispatchEvent(config, 'lead-captured', data);
                        }
                        return result;
                    });
                },
            },
        };

        function withVisitorId(data) {
            return mergeInto({ visitor_object_id: visitorId, fingerprint_hash: visitorId }, data);
        }

        return sdk;
    }

    function mergeInto(base, extra) {
        var out = {};
        for (var k in base) {
            if (Object.prototype.hasOwnProperty.call(base, k)) { out[k] = base[k]; }
        }
        for (var k2 in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k2)) { out[k2] = extra[k2]; }
        }
        return out;
    }

    // ---- Bootstrap ------------------------------------------------------------

    function init() {
        var config = readConfig(currentScriptTag());

        if (!config.orgId) {
            // Fail loud in the console (a silently-inert pixel is a worse debugging
            // experience for the integrator than a startup this loud), but never
            // throw - a misconfigured embed must not break the host page.
            if (window.console && console.warn) {
                console.warn('[ZeroAI BOSS] embed.js loaded without data-client-id - tracking calls will be dropped by the server.');
            }
        }
        if (config.environment !== 'production' && !config.baseUrl) {
            if (window.console && console.warn) {
                console.warn('[ZeroAI BOSS] environment="' + config.environment + '" requires data-base-url - there is no fixed sandbox host.');
            }
        }

        var sdk = buildSdk(config);
        window.ZeroAI = sdk;

        isReady = true;
        dispatchEvent(config, 'ready', { visitorId: sdk.visitorId });
        for (var i = 0; i < readyCallbacks.length; i++) {
            readyCallbacks[i](sdk);
        }
        readyCallbacks = [];

        // Fire-and-forget page-view capture on load - the common case for a
        // pixel-style embed. A page that wants to suppress this can do so by
        // setting data-modules to a list that excludes "auto" before loading.
        if (config.modules.indexOf('auto') !== -1 || config.modules.indexOf('tracking') !== -1) {
            sdk.track.visitor({});
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window, document);
