# Changelog

## 2.1.2

- **Fix:** link-only bookmarks still showed a bare `t.co` because cached bookmarks
  parsed by older versions never re-fetched. Added a schema-version migration that
  drops the stale-shape cache on upgrade and re-fetches with the current parser, so
  article titles / resolved links now appear. Read/snooze state is preserved.

## 2.1.1

- **Fix:** the bookmark card disappeared after navigating into a single tweet and
  back to Home. The card is now restored on return (preserving the same bookmark and
  position) instead of being suppressed by the once-per-open flag.

## 2.1.0

- **Display settings.** In-card settings panel (gear button, top-right of the card)
  to choose the prev/next pool size (`20` vs `全量/all`) and ordering (`完全随机` /
  `由最新到旧` / `由旧到新`). Defaults: 20, random. Ordering uses bookmark recency
  rebuilt from the live timeline, and applies live + across tabs.
- **Link/article cards.** Link-only bookmarks (e.g. a shared article showing only a
  `t.co`) now render the article **title + link** resolved from URL entities and X's
  card data; inline `t.co` shortlinks display as readable domains.

## 2.0.0

- **Auto-seed (no manual step).** Added a service worker that scrapes the current
  Bookmarks `queryId` + feature flags from X's web-client JS bundle, so bookmarks
  load without ever opening the bookmarks page. Self-heals on X deploys (re-scrapes
  on missing/stale credentials).
- **Browsable card.** Added 上一条 / 下一条 (prev/next) navigation with an `n / N`
  position indicator.
- **Full content.** Removed the 6-line text clamp; the full tweet now shows (incl.
  long-form notes), plus a media preview and an engagement-stats row (replies,
  reposts, likes, views, bookmarks) with K/M formatting and a verified badge.
- **Robustness.** Fixed `Uncaught (in promise) Error: Extension context invalidated`
  by guarding every `chrome.*` call with an `isContextValid()` check and tearing down
  observers/listeners/DOM when the extension is reloaded.

## 1.0.0

- Initial release: injects a single bookmark card at the top of the Home feed with
  Read / Done / Keep for later. Reads bookmarks via X's internal GraphQL API by
  intercepting the page's own Bookmarks request (MAIN-world fetch patch) and
  re-fetching with the captured credentials. Shadow-DOM card, light/dark theming,
  once-per-open cadence, random selection, cross-tab consistency.
