# ZeroAI BOSS - JS SDK

Universal JS embed client for third-party websites - visitor tracking,
marketing widgets, and (planned) AI chat. Installable on a static HTML site, a
Shopify store, a React app, or WordPress with zero framework collisions.

```html
<script async src="https://zeroaiboss.com/v1/embed.js" data-client-id="YOUR_CLIENT_ID"></script>
```

That's it - no npm install, no build step on the consuming site. The whole
point of hosting this on a BOSS-controlled URL is that every embedded site
gets fixes instantly with zero re-deploy on their end (same model as
`gtag.js`/Segment's `analytics.js`).

Companion to the [PHP SDK](https://github.com/Cyford-Technologies-LLC/ZeroAI-CRM/tree/main/www/dev-clients/php-sdk)
in the main ZeroAI-CRM repo. Lives in its own repo (not `www/dev-clients/js-sdk/`
in that repo) because client-side JS ships to every visitor's browser
regardless of where the source lives, and there's little reason to gate it
behind the main repo's access - see `www/dev-clients/README.md` there for the
full cross-cutting decisions this was planned against.

## Status (2026-08-29)

`src/embed.js` - the loader/bootstrap, visitor tracking module, and
CustomEvents are built and tested (`npm test`, 11/11 passing). Not yet built:
the chat widget (`zeroai:chat-opened` is a reserved event name, not dispatched
by anything yet), marketing-capture UI, and Web-Components-based rendering
(nothing in this SDK renders UI onto the page yet - it's tracking-only so
far).

## Technology

- **Vanilla JS**, hand-written, zero runtime dependencies, no build step to
  consume. `src/embed.js` IS the file served at `/v1/embed.js` - there's
  nothing to bundle for the tracking module. A future Web-Components-based
  widget (chat, marketing capture) would still ship as part of this same file
  or a sibling one loaded by it, not a separate framework.
- **Fetch with `keepalive: true`**, falling back to nothing further, for
  calls that need a response path (`identify`, `bindLead`, the initial
  page-view). **`navigator.sendBeacon`** (falling back to `fetch`) for
  `track.event()`, since events are the ones most likely to fire right before
  a page unload (e.g. an "add to cart" click that navigates away).
- Reserved for later, not built yet: Shadow DOM Custom Elements for any
  on-page UI, an iframe + `postMessage` chat panel, SSE/WebSocket for
  streaming chat replies. See the planning README in the main repo for the
  full rationale.

## Config

Set via `data-*` attributes on the script tag:

| Attribute | Meaning |
|---|---|
| `data-client-id` | Tenant identity for tracking calls (sent as `org_id`/`fingerprint_hash` scoping to the tracking endpoints - these are public, origin-restricted routes, never a private bearer token). Required for tracking calls to actually store anything server-side; a missing value logs a console warning but never throws. |
| `data-environment` | `production` (default) or `sandbox`. |
| `data-base-url` | Override for the API base URL. Required when `data-environment="sandbox"` - there's no single fixed sandbox host. |
| `data-modules` | Comma-separated module opt-in/out, or `auto` (default) to load whatever's enabled. Currently only affects whether the automatic page-view fire happens on load. |
| `data-locale` | Defaults to `navigator.language`. |
| `data-theme-*` | Reserved for future widget theming tokens (e.g. `data-theme-primary-color`) - collected into `window.ZeroAI.config.theme` already, not consumed by anything yet since there's no UI to theme. |

## API

```js
window.ZeroAI.ready(function (sdk) {
  // fires immediately if already initialized, or once init finishes
});

window.ZeroAI.track.visitor({});                 // POST /track/visitor (fired automatically on load unless data-modules excludes it)
window.ZeroAI.track.event('add_to_cart', {...});  // POST /track/visitor-event (sendBeacon)
window.ZeroAI.track.identify({...});              // POST /track/visitor-identity
window.ZeroAI.track.bindLead({...});              // POST /track/visitor-lead

window.ZeroAI.visitorId; // stable per-browser id (localStorage, cookie fallback) - NOT true device fingerprinting
```

Every `track.*` call automatically fills in `org_id` (from `data-client-id`),
`page_url`, `referrer`, `visitor_object_id`, and `fingerprint_hash` unless you
pass your own values for those keys.

## Events

`CustomEvent`s dispatched on `document`, so a host page's own analytics or
marketing code can react without polling anything:

- `zeroai:ready` - fires once, after init.
- `zeroai:visitor-identified` - after a successful `track.identify()`.
- `zeroai:lead-captured` - after a successful `track.bindLead()`.
- `zeroai:error` - a tracking call failed (network error). Never thrown -
  the SDK is designed to never break the host page.
- `zeroai:chat-opened` - **reserved**, not dispatched yet (no chat widget
  built).

## Testing

```
npm install
npm test
```

Tests run against a real `jsdom` window (no real network calls - `fetch` and
`navigator.sendBeacon` are mocked) via Node's built-in test runner.

## Distribution

Not yet wired up: this repo's `src/embed.js` needs an actual publish step to
land at `https://zeroaiboss.com/v1/embed.js` in the main app. That's
infrastructure/CI work, not decided yet - tracked on BOSS project 43.
