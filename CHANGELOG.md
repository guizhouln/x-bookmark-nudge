# Changelog

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
