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

## Status (2026-10-01)

`src/embed.js` - the loader/bootstrap and visitor tracking module are built and tested (`npm
test`, 11/11 passing -- tests cover tracking/events only, not the modules added after). Also
built since this note was last accurate (BOSS project 43): a chat widget (`sdk.chat`, an iframe
launcher + overlay), lead_capture form submission (`sdk.forms.submit`), web push config
(`sdk.push.getWebConfig`), browser error reporting (`sdk.errors`), and funnel events
(`sdk.funnels.event`). None of these newer modules have automated tests yet.

`src/forms-wizard.js` (new, BOSS project 50 task 140, loaded as a separate sibling script after
embed.js) adds `sdk.forms.renderWizard(selector, { publicKey })`: a multi-page, Indeed-style
application wizard against ZeroAI-CRM's generic Form Builder public API. Renders every field
type Form Builder supports, walks a multi-phase flow's chained pages automatically (one
`GET .../flow` call describes every page up front), uploads file fields via a separate
multipart endpoint, and silently/best-effort auto-fills matching fields from an uploaded resume
via a local-LLM extraction endpoint. No automated tests yet.

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
| `data-chat-agent-id` | Optional agent id passed to the chat widget's iframe, binding the launcher to one specific agent instead of the tenant's default. |
| `data-company-id` | Optional company scope passed to `sdk.push`/error reporting for a multi-company tenant. |

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

Also available, each its own module built since the table above was last fully accurate:

```js
window.ZeroAI.forms.submit(formId, data);        // POST /api/lead_capture/submit.php
window.ZeroAI.push.getWebConfig();               // GET /firebase/web-config
window.ZeroAI.errors.report({ message, stack }); // POST /errors/browser (also auto-installed on window.onerror if the 'errors'/'auto' module is enabled)
window.ZeroAI.funnels.event('page_visit', {...}); // POST /funnels/event/browser
window.ZeroAI.chat.open();                       // opens the floating chat launcher/overlay (mounted automatically if the 'chat'/'auto' module is enabled and data-client-id is set)
```

`src/forms-wizard.js` (load as a separate `<script>` tag after embed.js) adds:

```js
window.ZeroAI.ready(function (sdk) {
  sdk.forms.renderWizard('#apply-here', {
    publicKey: 'THE_JOB_APPLICATION_PUBLIC_KEY', // from ZeroAI-CRM's HR "Build Application Form" panel
    onSubmit: function (result) { /* result.submissionId */ },
  });
});
```

Renders a multi-step form (one step per page of the application flow), walking `next_form_id`
chaining automatically via one `GET .../flow` call, submitting each page as the applicant
advances, uploading any file fields, and -- on a file field change -- silently attempting resume
auto-fill against the WHOLE flow's fields (not just the current page), pre-filling whatever it
finds without ever overwriting a field the applicant already typed into.

## Events

`CustomEvent`s dispatched on `document`, so a host page's own analytics or
marketing code can react without polling anything:

- `zeroai:ready` - fires once, after init.
- `zeroai:visitor-identified` - after a successful `track.identify()`.
- `zeroai:lead-captured` - after a successful `track.bindLead()` OR `forms.submit()`.
- `zeroai:error` - a tracking/module call failed (network error, or a forms-wizard page
  rejected by the server). Never thrown - the SDK is designed to never break the host page.
- `zeroai:chat-opened` / `zeroai:chat-closed` - the chat launcher/overlay was opened/closed.
- `zeroai:application-submitted` (forms-wizard.js) - the LAST page of an application flow was
  submitted successfully. `detail: { publicKey, submissionId }`.
- `zeroai:resume-parsed` (forms-wizard.js) - a resume auto-fill attempt returned at least an
  empty result (check `detail.appliedToVisibleFields.length` for whether anything was actually
  filled in). `detail: { fields, appliedToVisibleFields }`.

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
