# Architecture

## Components

```
┌─ MAIN world ─────────────┐   ┌─ ISOLATED world ───────────┐   ┌─ Service worker ─┐
│ interceptor.js           │   │ content.js                 │   │ background.js    │
│ - patch window.fetch/XHR │   │ - relay listener           │   │ - scrapeCreds:   │
│ - on .../Bookmarks:      │ → │ - cache to storage         │ → │   fetch bundle,  │
│   relay template +       │postMessage  - active refresh   │msg │   regex queryId  │
│   response clone         │   │ - inject + drive the card  │ ← │   + features     │
└──────────────────────────┘   └────────────────────────────┘   └──────────────────┘
                                          │ chrome.storage.local
```

## Data flow

1. **Passive capture (highest fidelity).** When X itself fetches the Bookmarks
   timeline (i.e. the user visits `x.com/i/bookmarks`), `interceptor.js` (MAIN world,
   `document_start`) captures the full request template (queryId, variables,
   features, fieldToggles, bearer, sanitized header allowlist) and a `clone()` of the
   response, and relays both to `content.js` via `window.postMessage` (JSON strings,
   validated by a private marker). The original response is returned untouched.

2. **Auto-seed (no manual step).** If `creds` are missing, `content.js` finds the X
   web-client bundle URL from the page's `<script>` tags and asks `background.js` to
   `scrapeCreds`. The service worker fetches the bundle from `abs.twimg.com` (CORS-
   exempt via host permission) and regex-extracts the Bookmarks operation's
   `queryId` + `featureSwitches` (→ all `true`) + `fieldToggles`. Bearer defaults to
   the public web constant. Interceptor-captured creds are never clobbered.

3. **Active fetch.** With creds + the live `ct0` cookie, `content.js` calls the
   Bookmarks GraphQL endpoint same-origin (`credentials: 'include'`), paginating via
   the `cursor-bottom` value with safety caps (max pages, stop on empty/duplicate
   cursor, stop on 403/429). On 400/403 it re-scrapes creds once and retries. At most
   once per 24h (`lastFetchedAt`).

4. **Render.** On the Home route, once the timeline has mounted, `content.js` injects
   a Shadow-DOM card as the first child of `div[data-testid="primaryColumn"]` (above
   the For you/Following tabs, outside the virtualized list so scrolling can't recycle
   it). The card shows full text, media, stats, and prev/next nav.

## GraphQL contract

- Endpoint: `GET <origin>/i/api/graphql/<queryId>/Bookmarks?variables=&features=&fieldToggles=`
- Headers: `authorization: Bearer <public>`, `x-csrf-token: <live ct0>`,
  `x-twitter-active-user: yes`, `x-twitter-auth-type: OAuth2Session`,
  `x-twitter-client-language: en`; `credentials: 'include'`.
- Response traversal: `data.bookmark_timeline_v2.timeline.instructions[]` →
  `TimelineAddEntries` → `entries[]`; for `tweet-*` entries unwrap
  `content.itemContent.tweet_results.result` (`result.tweet` for
  `TweetWithVisibilityResults`); skip tombstones/unavailable. Fields:
  `legacy.full_text` / `note_tweet...text`; `legacy.{reply_count, retweet_count,
  favorite_count, quote_count, bookmark_count}`; `views.count` (when
  `state === "EnabledWithCount"`); `legacy.extended_entities.media[]`;
  `core.user_results.result.legacy.{screen_name, name, profile_image_url_https}`
  (with `.core.*` / `.avatar.image_url` fallbacks); `is_blue_verified`.

## Reliability / failure handling

- **Extension reload:** `isContextValid()` (`!!chrome.runtime?.id`) gates every
  `chrome.*` call; the observer/listeners/DOM are torn down so a stale content script
  goes quiet instead of throwing `Extension context invalidated`.
- **X churn:** selectors use only `data-testid`/ARIA/structure; queryId + features are
  re-scraped on demand; bearer is a stable public constant with bundle re-scrape as
  backup.
- **Multi-tab:** object-map storage + `chrome.storage.onChanged` keep tabs consistent.

## Permissions

- `storage` — cache + state.
- `host_permissions: https://x.com/*` — content scripts + same-origin GraphQL fetch.
- `host_permissions: https://abs.twimg.com/*` — service-worker bundle fetch for
  credential scraping.
- No `tabs`, `scripting`, or `alarms`.
