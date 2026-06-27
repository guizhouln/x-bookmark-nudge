# Project Memory

This file is the distilled memory of the conversation that produced this project, so
future sessions (human or agent) have the full context, decisions, and rationale.

## Origin idea

> "I hoard X bookmarks and never read them. So I built an extension that, every time
> I open X, injects one bookmarked post into my main feed (almost like an ad). Now I
> read my bookmarks."

Goal: a personal Chrome (MV3) extension that surfaces a saved X bookmark as a native-
looking card at the top of the Home/For-you feed, with Read / Done / Keep for later.

## Product decisions (confirmed with the user)

- **Cadence:** show the card once per "open" of X (per page load). The persisted
  once-per-calendar-day approach was rejected as a bug — it suppressed the card
  across reloads/tabs, contradicting "every time I open X". Implemented via an
  in-memory `shownThisLoad` flag (resets on reload/new tab).
- **Selection:** random among eligible (un-done, un-snoozed) bookmarks; with prev/
  next, the card starts at a random index and pages through the list.
- **Read button:** opens the tweet in a new tab AND marks it Done, with a 5s Undo
  toast guarding accidental opens.
- **Auto-seed:** silent JS-bundle scrape (chosen over a visible background tab and
  over keeping the manual bookmarks-page visit).
- **Distribution:** public GitHub repo named `x-bookmark-nudge`, MIT license.

## Data source (the crux)

X has no convenient public bookmarks API (the official v2 endpoint needs a paid
developer tier + OAuth and caps at ~800). Instead the extension reuses the logged-in
web session and calls X's **internal GraphQL** Bookmarks endpoint:
`GET https://x.com/i/api/graphql/<queryId>/Bookmarks?variables=...&features=...`
with `authorization: Bearer <public web token>`, `x-csrf-token` = live `ct0` cookie,
`x-twitter-active-user: yes`, `x-twitter-auth-type: OAuth2Session`,
`credentials: 'include'`. Response is parsed tolerantly (handles
`TweetWithVisibilityResults`, note tweets, tombstones; extracts text, author, stats,
views, media). Pagination via the `cursor-bottom` entry, with safety caps.

The volatile bits — `queryId`, the `features` flag set, the bearer — are **never
hardcoded as the only source**: they are captured live (interceptor) or scraped from
X's JS bundle (service worker), so the extension self-heals across X deploys.

## Codex review (v1)

The v1 plan was reviewed by Codex (`codex exec`, read-only). Findings folded in:
capture a full request template + sanitized header allowlist (not just queryId);
tolerant response parser; relay listener at `document_start` to avoid a seed-loss
race; drop the original over-ambitious service worker idea; object-map storage +
`storage.onChanged` for multi-tab safety; pagination safety caps; idempotent,
language-agnostic, computed-style-themed injection; Read→Done gets Undo; sequence
work as capture → active refresh → DOM card.

## Iterations

1. **v1 build** — interceptor + content script + Shadow-DOM card; once-per-open
   cadence; random; Read=Done+Undo. Codex-reviewed.
2. **v1.x fixes** — show the post's date on the card; fix the "shows once then never
   again" bug (replaced persisted `lastShownDate` with in-memory `shownThisLoad`).
3. **v2** (this project) — fix `Extension context invalidated`; silent auto-seed via
   bundle scrape (new service worker); prev/next navigation; full tweet + media +
   engagement stats; packaged as a public MIT repo with this memory.
4. **Published** — bilingual (中文 / English) README with a screenshot gallery
   (light / dark / media mocks under `docs/`). Pushed to
   https://github.com/guizhouln/x-bookmark-nudge (public, MIT, default branch
   `main`). Agent memory consolidated into `CLAUDE.md` (+ `AGENTS.md` pointer).
5. **v2.1.x — settings + link cards** (Codex-reviewed plan via `ce-plan`, see
   `docs/plans/`): in-card settings panel (gear) for pool size (`20`/`all`) +
   ordering (`random`/`newest`/`oldest`), with **bookmark-recency** ordering rebuilt
   from the API timeline (`applyFetchedBookmarks`); link/article cards (resolve `t.co`
   + `result.card`); native **X Article** titles. Fixes: card lost when returning to
   Home from a tweet (2.1.1); stale-cache `SCHEMA_VERSION` migration so re-parsing
   reaches cached bookmarks (2.1.2 links, 2.1.3 article titles).
6. **v2.2.0 — Done un-bookmarks** on X (`DeleteBookmark`; Undo re-adds via
   `CreateBookmark`); the SW scrapes mutation queryIds. Stats row clickable.
7. **v2.3.0 — interactive stat buttons**: reply (intent composer), repost, like,
   bookmark each fire X's own GraphQL mutation with optimistic toggle + color; views
   opens the tweet. `toggleStat`/`doMutation` in content.js; `scrapeMutations` in SW.

## Current state

Live public repo at https://github.com/guizhouln/x-bookmark-nudge — currently
**v2.3.0** (`manifest`), `SCHEMA_VERSION = 4`. Tags `v2.1.0`–`v2.3.0`, each with a
GitHub Release. Loadable unpacked from the repo root. `gh` (2.95.0) installed locally;
git identity `guizhouln <guizhou2423@gmail.com>`. The superseded original folder
`/Users/pro/bookmark-nudge` may be deleted.

## Key code paths

- `interceptor.js` — MAIN world; patches `fetch`/XHR; on a Bookmarks call relays a
  request template + a `clone()` of the response (never consumes the original).
- `background.js` — service worker; `scrapeCreds` regex-extracts the Bookmarks
  `queryId` + `featureSwitches` + `fieldToggles` from the bundle; won't clobber
  higher-fidelity interceptor-captured creds.
- `content.js` — `isContextValid()`/`teardown()` (reload safety), `parseBookmarks`/
  `extractTweet` (rich fields), `maybeRefresh`/`activeRefresh` (paginated, re-scrapes
  on 400/403), `pickEligibleList` + `injectCard`/`renderCurrent` (reader card with
  prev/next), `storage.onChanged` (cross-tab).

## Storage schema (`chrome.storage.local`)

`bookmarkById{}`, `order[]`, `doneById{}`, `snoozedById{ id: ISO }`,
`creds{queryId, operationName, variables, features, fieldToggles, bearer,
headerAllowlist, source}`, `lastFetchedAt`.

## Privacy / ToS posture

Personal use, own data, own session, on `x.com` only. No `ct0`/`auth_token` stored.
The bearer is X's public web constant. Not for distribution at scale.
