---
status: active
type: feat
created: 2026-06-27
reviewed_by: codex
---

# feat: Bookmark display settings (pool size + ordering), in-card gear panel, and link/article rendering

## Summary

Two related card improvements, all in `content.js`:

1. **Display settings** — an in-card settings panel opened by a gear button on the
   card's top-right. Controls the prev/next **pool**: size (`20` vs `全量/all`) and
   ordering (`完全随机` / `由旧到新` / `由最新到旧`). Defaults: 20, random.
2. **Link/article rendering** — when a bookmark's body is essentially a shared link
   (it currently renders a bare `https://t.co/…`, e.g. the DAN KOE example), resolve
   it and show the **article title + clean link** as a card, and de-`t.co` any inline
   links.

Data source, GraphQL fetch, auto-seed, and `manifest.json` are unchanged (Codex
confirmed no manifest change is needed).

Target repo: `x-bookmark-nudge` (this repo).

---

## Problem frame

- The card cycles the **entire** eligible list starting at a random index; the user
  wants a 20-item window by default with configurable size/order, reachable from a
  gear on the card.
- Link-only bookmarks show an opaque `t.co` shortlink with no title (see the DAN KOE
  bookmark), so the user can't tell what the article is.

---

## Requirements

- **R1** — Default prev/next pool is 20, not the full list.
- **R2** — Setting: pool size `20` or `全量 (all)`.
- **R3** — Setting: ordering `完全随机` / `由旧到新` / `由最新到旧` (applies to both sizes).
- **R4** — Gear button at the card's top-right opens settings.
- **R5** — Settings are an in-card inline panel (gear flips view; back returns); live apply.
- **R6** — When a bookmark is a shared link/article, render the article **title + link**
  (a link card) and replace bare `t.co` shortlinks in the text with readable URLs.
- **Defaults** — pool `20`, order `完全随机`.

---

## Key technical decisions

- **In-card panel, not an options page** (no manifest change). Gear toggles a settings
  view inside the existing Shadow-DOM host.
- **Settings in `chrome.storage.local.settings`** = `{ poolSize: 20 | "all", order:
  "random" | "oldest" | "newest" }`, defaults applied on read. **Normalize on read/write**
  (Codex CRITICAL #4): `poolSize = raw === "all" ? "all" : 20` (number, so the
  `=== 20` slice works), and validate `order ∈ {random,oldest,newest}`.
- **Order semantics = "most recently bookmarked first," derived from the GraphQL
  timeline order — NOT from `createdAt`/snowflake id** (Codex CRITICAL #1). Today
  `mergeBookmarks` only *appends first-seen IDs*, so `order` drifts from true bookmark
  recency. Fix: `activeRefresh` rebuilds `order` from the full fetch =
  `fetchedIdsInApiOrder + previouslyKnownIdsNotInThisFetch`. Then `newest` = `order`
  as-is, `oldest` = `order.slice().reverse()`, `random` = shuffle a copy
  (copy-safe — Codex NIT). The passive-intercept path keeps append-only (no cursor
  info to reorder); active refresh is the authoritative ordering.
- **Single apply path** (Codex IMPROVEMENT): a settings change writes storage, then the
  rebuild happens in exactly one place. Either rebuild locally and dedupe the
  `storage.onChanged` echo (cache last-applied settings JSON and ignore a matching
  event), or rebuild only in `onChanged`. Prevents `random` from shuffling twice.
- **Link/article extraction** (R6): from `legacy.entities.urls[]` (`url` = t.co,
  `expanded_url`, `display_url`) build a t.co→readable map to de-`t.co` the text; from
  `result.card.legacy.binding_values` (normalize array-of-`{key,value}` → map) read
  `title`, `domain`/`vanity_url`, and the destination (`card_url`/`website_url`, mapped
  through the urls table to the expanded URL). Store `bm.link = { title, url, domain }`.
  Render a bordered link-card (domain small, title bold, click → open url). If the body
  text is only the shortlink that the card already represents, drop it.

---

## Implementation units

### U1. Settings model + ordering + selection pool

**Goal:** Persist settings, fix order semantics, and make the pool honor them.

**Requirements:** R1, R2, R3.

**Files:** `content.js`

**Approach:**
- `DEFAULT_SETTINGS = { poolSize: 20, order: "random" }`; `getSettings()` reads +
  normalizes (poolSize→`20`|`"all"`, order validated); `saveSettings(partial)` merges.
- **Authoritative order:** in `activeRefresh`, after collecting all pages, rebuild
  `order` = fetched IDs in API order followed by any existing IDs not refetched; write
  with `bookmarkById`. Keep `mergeBookmarks` append-only for the passive path.
- `orderEligible(list, order)` — copy-safe: `newest` → list as-is, `oldest` →
  `list.slice().reverse()`, `random` → Fisher–Yates on a copy.
- `pickPool(settings)` — filter eligible (done/snoozed), `orderEligible`, then
  `slice(0,20)` when `poolSize === 20`.
- `injectCard` → `currentList = await pickPool(await getSettings())`, `currentIdx = 0`.

**Patterns to follow:** existing storage helpers + `currentList`/`renderCurrent` model.

**Test scenarios (manual — no JS test harness; verify in-browser + `node --check`):**
- Fresh install → pool 20, random; cap never exceeds 20.
- `all` → pages through every eligible item; `n/N` = full count.
- `newest` vs `oldest` → first item flips; ordering reflects **bookmark recency** (the
  same item that's first in X's bookmarks page), not tweet age.
- After a refresh that discovers newly-added bookmarks, `newest` still shows them first
  (order rebuilt from API), proving the drift fix.
- eligible `< 20` → just those; `0` → no card; pool of `1` → prev/next wrap to itself.

**Verification:** with 20, `n/N ≤ 20`; switching order re-sequences the same set;
`all` expands the count; newly-bookmarked items lead in `newest`.

### U2. Gear button + in-card settings panel + view dispatcher + cross-tab

**Goal:** Add the gear and inline panel; wire live + cross-tab updates correctly.

**Requirements:** R4, R5.

**Files:** `content.js`

**Approach:**
- `viewMode` (`"card" | "settings"`, default card) + a `render(host)` dispatcher →
  `renderCurrent` or `renderSettings`. **Use `render(host)` everywhere view-mode
  matters** (Codex CRITICAL #3): settings changes, back/gear clicks, theme refresh
  (`updateCardTheme` must call `render`, Codex IMPROVEMENT), post-action renders.
- Gear button (`data-act="settings"`) added to `.top` left of ✕ (reuse a gear SVG,
  style like `.x`).
- `buildSettingsMarkup(settings, theme)`: back control (`data-act="back"`), 显示数量 /
  Items segmented (`20` / `全量 All`, `data-act="set-pool"` + `data-val`), 排序 / Order
  segmented (`随机` / `最新到旧` / `最旧到新`, `data-act="set-order"` + `data-val`); active
  option highlighted; bilingual labels.
- Delegated handler: `settings`/`back` → set `viewMode`, `render`; `set-pool`/`set-order`
  → normalize `dataset.val`, `saveSettings`, rebuild pool via the single apply path,
  `currentIdx = 0`, then `render` (stay in settings). Call `clearToastAndUndo()` on
  pool rebuild so a stale Undo can't act on a removed item (Codex IMPROVEMENT).
- **`storage.onChanged` rework** (Codex CRITICAL #2 + IMPROVEMENT): handle
  `changes.settings` **before** the current-card-ID guard (rebuild pool + `render`);
  derive the current id from `currentList[currentIdx]?.id`, not `host.dataset.bookmarkId`
  (stale in settings view); on `doneById`/`snoozedById` changes, **re-filter the whole
  pool**, not just the visible item, then `render` (or remove card if empty).

**Patterns to follow:** the single delegated `shadowRoot` listener (persists across
`innerHTML`), `THEMES`/`ACCENT`, `removeFromList`/`render` flow.

**Test scenarios (manual):**
- Gear visible top-right next to ✕ (light + dark); click → panel with current
  selections highlighted.
- Toggle pool/order → panel stays open (uses `render`), card re-sequences on back;
  persists across reload; second tab syncs via `storage.onChanged`.
- `random` toggled once shuffles once (no double reshuffle).
- Another tab marks an **off-screen** pool item done → it's removed from this tab's pool.
- Theme toggle while panel open keeps the panel open.

**Verification:** gear opens/closes panel without navigating; changes apply immediately,
persist, and sync across tabs; no double-shuffle; Undo never acts on a removed item.

### U3. Link / article title rendering (R6)

**Goal:** Turn bare `t.co` link bookmarks into a readable article title + link card.

**Requirements:** R6.

**Files:** `content.js` (`extractTweet`, `cleanText`, `buildCardMarkup` + shadow CSS).

**Approach:**
- In `extractTweet`, read `legacy.entities.urls[]` → map each `url` (t.co) to
  `display_url`/`expanded_url`. Replace t.co occurrences in `text` with the readable
  `display_url` (generalizes today's trailing-only strip in `cleanText`).
- Read `result.card.legacy.binding_values` (normalize array `{key,value:{string_value}}`
  or map) → `title`, `domain`/`vanity_url`, destination URL (`card_url`/`website_url`,
  resolved through the urls map to `expanded_url`). Optionally `result.article…title`
  for native X Articles. Build `bm.link = { title, url, domain }` (null when absent).
- If the cleaned text is empty or equals just the card's shortlink, suppress the text
  block and lead with the link card.
- `buildCardMarkup`: when `bm.link`, render a bordered, rounded link card (small domain
  line, bold title, `data-act="open"` → open `bm.link.url`). Place it where media sits
  (a tweet rarely has both a big media block and a link card; if both, show media then
  link card).

**Patterns to follow:** existing media block markup + `data-act="open"` handler;
`safe()` escaping; `THEMES` tokens.

**Test scenarios (manual):**
- DAN KOE-style bookmark (body is only a t.co) → renders the article title + domain,
  click opens the expanded article URL; no bare t.co shown.
- Tweet with text + trailing link card → text shown de-`t.co`'d, link card below.
- Tweet with no links → unchanged (no link card).
- Tweet with image media and no card → media renders as before.
- Card present but missing `title` → fall back to `display_url`/domain as the title.

**Verification:** the example bookmark shows a human-readable title and opens the real
article; inline `t.co` links read as domains, not shortcodes.

---

## Scope boundaries

In scope: in-card settings (pool size + ordering, defaults 20/random), gear button,
authoritative bookmark-recency ordering, live + cross-tab apply, and link/article
title rendering.

### Deferred to follow-up work
- Separate options page / toolbar popup (not chosen).
- Fetch-size optimization (fetch only page 1 when order=newest & pool=20).
- Following t.co redirects over the network to get titles when no card exists
  (we rely on X's card/entities data, no extra network).
- Quote-tweet / multi-image gallery rendering; additional settings (snooze, cadence).

---

## Verification (end-to-end)
1. `node --check content.js` passes.
2. Reload unpacked at repo root; open `x.com/home`.
3. Default pool 20/random; `n/N ≤ 20`.
4. Gear → panel; toggle size/order → live re-sequence (bookmark-recency), persist, cross-tab sync; single shuffle; panel stays open; theme toggle keeps panel.
5. A link-only bookmark shows article title + link and opens the real URL.
6. Existing actions (prev/next, Read/Done/Keep, Undo, dismiss) unaffected.

---

## Codex review — folded in
- **Order not newest-first** → rebuild `order` from API fetch order (bookmark recency); copy-safe `orderEligible`. (CRITICAL #1)
- **`storage.onChanged` guard skips settings** → handle `changes.settings` first; derive id from `currentList[currentIdx]`; re-filter whole pool on done/snooze. (CRITICAL #2 + IMPROVEMENT)
- **Re-render via `render(host)` dispatcher**, not `renderCurrent`, incl. `updateCardTheme`. (CRITICAL #3 + IMPROVEMENT)
- **Normalize `poolSize`** (string `"20"` → number 20) and validate `order`. (CRITICAL #4)
- **Single apply path** (no double shuffle); **`clearToastAndUndo()` on rebuild**. (IMPROVEMENTS)
- No manifest change; soften the "different 20 each open" test (random may repeat). (NITs)
