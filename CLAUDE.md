# Project memory — Bookmark Nudge for X

Canonical memory for agents working on this repo. History/rationale: `docs/MEMORY.md`.
Technical detail: `docs/ARCHITECTURE.md`. Repo: https://github.com/guizhouln/x-bookmark-nudge

## What this is

A personal Chrome (Manifest V3) extension. Each time you open X (x.com), it injects
one of your saved bookmarks as a native-looking card at the top of the Home feed
(Read / Done / Keep for later, prev/next, full tweet + media + engagement stats).
No build step, no dependencies. Load unpacked from the repo root.

## Components

- `interceptor.js` — MAIN world, `document_start`. Patches `fetch`/XHR to passively
  capture X's own Bookmarks GraphQL request template + a `clone()` of the response.
  Highest fidelity; never consumes/breaks the original request.
- `background.js` — service worker. `scrapeCreds`: fetch X's web bundle from
  `abs.twimg.com`, regex out the Bookmarks `queryId` + `featureSwitches` +
  `fieldToggles`. Lets the extension seed without the user opening the bookmarks page.
- `content.js` — ISOLATED world, `document_start`. Caches to `chrome.storage.local`,
  actively fetches (paginated, self-healing), and injects/operates the card.

## Key decisions (do not silently reverse)

- **Cadence:** one card per page load (in-memory `shownThisLoad`), NOT a persisted
  per-day lock — that previously broke "every time I open X". 
- **Selection:** display settings (gear → in-card panel) choose pool size (`20` vs
  `all`) and order (`random`/`newest`/`oldest`); ordering uses **bookmark recency**
  rebuilt from the API timeline in `applyFetchedBookmarks`, not tweet `createdAt`.
  Defaults 20/random. prev/next pages the pool.
- **Link/article:** link-only bookmarks render the article title + link (from
  `legacy.entities.urls` + `result.card` data); inline t.co shown as readable domains.
- **Read = open + mark Done** with a 5s Undo toast.
- **Auto-seed = silent bundle scrape** (chosen over a visible background tab).
- **Privacy:** never persist `ct0`/`auth_token`; read `ct0` fresh per request. The
  only token in source is X's public web bearer constant (not a secret). No secrets
  in the repo.

## Editing rules / conventions

- DOM selectors: ONLY `data-testid` / ARIA / structure, with fallbacks. Never target
  X's hashed CSS classes.
- Never hardcode the volatile `queryId`/`features` as the sole source — they rotate;
  re-capture (interceptor) or re-scrape (SW). Self-heal on 400/403.
- Cross-origin `abs.twimg.com` fetch happens in the service worker (host-permission
  CORS bypass), not the content script.
- Guard every `chrome.*` call with `isContextValid()` (`!!chrome.runtime?.id`) and
  tear down observers/listeners/DOM on invalidation (extension-reload safety).
- Storage uses object maps (`bookmarkById`, `doneById`, `snoozedById`) + merge-on-write
  + `chrome.storage.onChanged` for multi-tab consistency. Re-read before write.
- Card lives in a Shadow DOM host, inserted as the first child of
  `div[data-testid="primaryColumn"]` (outside the virtualized list). Theme via
  computed background luminance (light/dark).

## Storage schema (`chrome.storage.local`)

`bookmarkById{ id: {id,text,authorHandle,authorName,authorAvatarUrl,verified,createdAt,tweetUrl,stats,views,media} }`,
`order[]`, `doneById{}`, `snoozedById{ id: ISO }`,
`creds{queryId, operationName, variables, features, fieldToggles, bearer, headerAllowlist, source}`,
`lastFetchedAt`.

## Dev workflow

- No build. Syntax check: `node --check content.js background.js interceptor.js`;
  validate `manifest.json` with any JSON parser.
- Test: `chrome://extensions` → Developer mode → Load unpacked → repo root → open
  `x.com`. Reload the extension after edits.
- Git identity used here: `guizhouln <guizhou2423@gmail.com>`. Publishing uses `gh`.

## Known fragilities

X changes its internal API and DOM often. The design self-heals (re-scrape rotating
creds; resilient selectors). If a card stops appearing: reload the extension, or open
the bookmarks page once to re-seed.
