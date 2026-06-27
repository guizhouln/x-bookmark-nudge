// content.js — ISOLATED world, document_start.
// - Receives interceptor relay (template -> creds, response -> cache).
// - Seeds creds automatically via the service worker (JS-bundle scrape) when missing.
// - Actively refreshes the bookmark list (paginated, capped, self-healing).
// - Injects a browsable "From your bookmarks" reader card on Home: full tweet,
//   media, engagement stats, prev/next navigation, Read / Done / Keep / dismiss.
// - Survives extension reload ("Extension context invalidated") by tearing down.
(function () {
  "use strict";

  const MARKER = "__bookmark_nudge__";
  const HOST_ID = "bookmark-nudge-card-host";
  const LOG = "[BookmarkNudge]";

  const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const SNOOZE_MS = 24 * 60 * 60 * 1000;
  const MAX_PAGES = 20;
  const PER_PAGE = 50;
  const TOAST_MS = 5000;
  const DEBOUNCE_MS = 200;

  const DEFAULT_SETTINGS = { poolSize: 20, order: "random" };
  const VALID_ORDERS = ["random", "oldest", "newest"];

  // Per-page-load UI state (not persisted).
  let sessionDismissed = false;
  let refreshInFlight = false;
  let shownThisLoad = false;

  // Reader state for the currently injected card.
  let currentList = [];
  let currentIdx = 0;
  let lastAction = null; // { bm, type } for Undo
  let toastTimer = null;
  let viewMode = "card"; // "card" | "settings"
  let currentSettings = DEFAULT_SETTINGS;

  // Teardown plumbing.
  let _observer = null;
  let _popstateHandler = null;
  let _messageHandler = null;
  let _storageHandler = null;
  let _destroyed = false;
  let busy = false;

  // ---------- extension-context safety (U1) ----------
  function isContextValid() {
    try {
      return typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function getLocal(keys) {
    if (!isContextValid()) return Promise.resolve({});
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (r) => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve({});
          resolve(r || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }
  function setLocal(obj) {
    if (!isContextValid()) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve();
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ---------- display settings (pool size + ordering) ----------
  function normalizeSettings(raw) {
    raw = raw || {};
    const poolSize = raw.poolSize === "all" ? "all" : 20; // number 20 so === checks work
    const order = VALID_ORDERS.indexOf(raw.order) >= 0 ? raw.order : DEFAULT_SETTINGS.order;
    return { poolSize, order };
  }
  async function getSettings() {
    const { settings } = await getLocal(["settings"]);
    return normalizeSettings(settings);
  }
  async function saveSettings(partial) {
    const cur = await getSettings();
    const next = normalizeSettings(Object.assign({}, cur, partial));
    await setLocal({ settings: next });
    return next;
  }

  // ---------- relay listener (must exist before X's first fetch) ----------
  function onMessage(ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== MARKER || typeof d.payload !== "string") return;
    let payload;
    try {
      payload = JSON.parse(d.payload);
    } catch (_) {
      return;
    }
    if (d.type === "template") handleTemplate(payload);
    else if (d.type === "response") handleResponse(payload);
  }

  async function handleTemplate(tmpl) {
    if (!tmpl || !tmpl.queryId) return;
    const { creds } = await getLocal(["creds"]);
    const merged = Object.assign({}, creds || {}, {
      queryId: tmpl.queryId,
      operationName: tmpl.operationName || (creds && creds.operationName) || "Bookmarks",
      variables: tmpl.variables || (creds && creds.variables),
      features: tmpl.features || (creds && creds.features),
      fieldToggles: tmpl.fieldToggles || (creds && creds.fieldToggles),
      bearer: tmpl.bearer || (creds && creds.bearer),
      headerAllowlist: tmpl.headerAllowlist || (creds && creds.headerAllowlist),
      source: "interceptor",
    });
    await setLocal({ creds: merged });
  }

  async function handleResponse(json) {
    const { bookmarks } = parseBookmarks(json);
    if (bookmarks.length) {
      await mergeBookmarks(bookmarks);
      console.debug(LOG, "cached", bookmarks.length, "from intercepted response");
    }
  }

  // ---------- tolerant parsing (U3) ----------
  function parseBookmarks(json) {
    const out = [];
    let cursor = null;
    try {
      const instructions =
        json &&
        json.data &&
        json.data.bookmark_timeline_v2 &&
        json.data.bookmark_timeline_v2.timeline &&
        json.data.bookmark_timeline_v2.timeline.instructions;
      if (!Array.isArray(instructions)) return { bookmarks: out, cursor };
      for (const ins of instructions) {
        const type = ins && (ins.type || ins.__typename);
        if (type !== "TimelineAddEntries") continue;
        for (const entry of ins.entries || []) {
          const id = (entry && entry.entryId) || "";
          if (id.startsWith("cursor-bottom-")) {
            cursor = (entry.content && entry.content.value) || cursor;
            continue;
          }
          if (!id.startsWith("tweet-")) continue;
          const t = extractTweet(entry);
          if (t) out.push(t);
        }
      }
    } catch (e) {
      console.warn(LOG, "parse error", e);
    }
    return { bookmarks: out, cursor };
  }

  // ---------- link/article (URL entities + link card) helpers (U3) ----------
  function hostFromUrl(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch (_) {
      return "";
    }
  }
  function bindingMap(bv) {
    // binding_values is an array of {key, value} (older) or an object map (newer)
    const map = {};
    if (Array.isArray(bv)) {
      for (const e of bv) if (e && e.key) map[e.key] = e.value;
    } else if (bv && typeof bv === "object") {
      Object.assign(map, bv);
    }
    return map;
  }
  function strVal(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    return v.string_value || (v.value && v.value.string_value) || "";
  }
  function extractLink(result, urlByTco) {
    try {
      const card = result.card && result.card.legacy;
      if (card && card.binding_values) {
        const bv = bindingMap(card.binding_values);
        const title = strVal(bv.title) || strVal(bv.event_title);
        const domain = strVal(bv.domain) || strVal(bv.vanity_url);
        const tco = strVal(bv.card_url) || (result.card && result.card.url) || "";
        const resolved = urlByTco[tco];
        const url = (resolved && resolved.expanded) || strVal(bv.website_url) || tco;
        if (title || url) {
          return {
            title: title || domain || hostFromUrl(url) || url,
            url,
            domain: domain || hostFromUrl(url),
            display: (resolved && resolved.display) || hostFromUrl(url),
          };
        }
      }
    } catch (_) {}
    return null;
  }

  function extractTweet(entry) {
    try {
      const itemContent = entry && entry.content && entry.content.itemContent;
      if (!itemContent || !itemContent.tweet_results) return null;
      let result = itemContent.tweet_results.result;
      if (!result) return null;
      if (result.__typename === "TweetWithVisibilityResults") result = result.tweet;
      if (!result) return null;
      if (result.__typename === "TweetTombstone" || result.__typename === "TweetUnavailable")
        return null;

      const legacy = result.legacy || {};
      const restId = result.rest_id || legacy.id_str;
      if (!restId) return null;

      const noteText =
        result.note_tweet &&
        result.note_tweet.note_tweet_results &&
        result.note_tweet.note_tweet_results.result &&
        result.note_tweet.note_tweet_results.result.text;

      // Resolve t.co shortlinks to readable URLs and extract a link/article card.
      const urlByTco = {};
      const urlEntities = (legacy.entities && legacy.entities.urls) || [];
      for (const u of urlEntities) {
        if (u && u.url) {
          urlByTco[u.url] = {
            expanded: u.expanded_url || u.url,
            display: u.display_url || u.expanded_url || u.url,
          };
        }
      }
      let resolvedText = noteText || legacy.full_text || legacy.text || "";
      for (const tco in urlByTco) {
        resolvedText = resolvedText.split(tco).join(urlByTco[tco].display);
      }
      let link = extractLink(result, urlByTco);
      let text = cleanText(resolvedText);
      // If the body is only the link the card already represents, drop the text.
      if (link && text) {
        const stripped = text
          .split(link.display || " ").join("")
          .split(link.url || " ").join("")
          .trim();
        if (!stripped) text = "";
      }
      // No card preview, but the body is just a single link → surface it as a card.
      if (!link) {
        const tcos = Object.keys(urlByTco);
        if (tcos.length === 1) {
          const r = urlByTco[tcos[0]];
          const stripped = text.split(r.display).join("").split(r.expanded).join("").trim();
          if (!stripped) {
            link = { title: r.display, url: r.expanded, domain: hostFromUrl(r.expanded), display: r.display };
            text = "";
          }
        }
      }

      const userResult =
        result.core && result.core.user_results && result.core.user_results.result;
      const uLegacy = (userResult && userResult.legacy) || {};
      const uCore = (userResult && userResult.core) || {};
      const screenName = uLegacy.screen_name || uCore.screen_name || "";
      const name = uLegacy.name || uCore.name || "";
      const avatar =
        uLegacy.profile_image_url_https ||
        (userResult && userResult.avatar && userResult.avatar.image_url) ||
        "";
      const verified = !!(userResult && (userResult.is_blue_verified || uLegacy.verified));

      // views (string) only when a count is exposed
      let views = null;
      if (result.views && result.views.state === "EnabledWithCount" && result.views.count != null) {
        const v = parseInt(result.views.count, 10);
        if (!isNaN(v)) views = v;
      }

      const stats = {
        replies: legacy.reply_count || 0,
        reposts: legacy.retweet_count || 0,
        likes: legacy.favorite_count || 0,
        quotes: legacy.quote_count || 0,
        bookmarks: legacy.bookmark_count || 0,
      };

      const media = [];
      const mediaArr =
        (legacy.extended_entities && legacy.extended_entities.media) ||
        (legacy.entities && legacy.entities.media) ||
        [];
      for (const m of mediaArr) {
        if (!m || !m.media_url_https) continue;
        const item = { type: m.type || "photo", poster: m.media_url_https };
        if (
          (m.type === "video" || m.type === "animated_gif") &&
          m.video_info &&
          m.video_info.variants
        ) {
          const mp4s = m.video_info.variants
            .filter((v) => v.content_type === "video/mp4" && v.url)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (mp4s[0]) item.videoUrl = mp4s[0].url;
        }
        media.push(item);
      }

      const tweetUrl = screenName
        ? "https://x.com/" + screenName + "/status/" + restId
        : "https://x.com/i/status/" + restId;

      return {
        id: String(restId),
        text,
        link,
        authorHandle: screenName,
        authorName: name,
        authorAvatarUrl: avatar,
        verified,
        createdAt: legacy.created_at || "",
        tweetUrl,
        stats,
        views,
        media,
      };
    } catch (_) {
      return null;
    }
  }

  function cleanText(t) {
    // strip a single trailing media/self t.co link
    return String(t).replace(/\s+https:\/\/t\.co\/\w+\s*$/, "").trim();
  }

  function formatDate(createdAt) {
    if (!createdAt) return "";
    const d = new Date(createdAt);
    if (isNaN(d.getTime())) return "";
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60000);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    if (min < 1) return "now";
    if (min < 60) return min + "m";
    if (hr < 24) return hr + "h";
    if (day < 7) return day + "d";
    const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return M[d.getMonth()] + " " + d.getDate() + (sameYear ? "" : ", " + d.getFullYear());
  }

  function formatCount(n) {
    if (n == null || isNaN(n)) return "";
    n = Number(n);
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    if (n < 1000000) return Math.floor(n / 1000) + "K";
    return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }

  // ---------- cache merge ----------
  async function mergeBookmarks(list) {
    const cur = await getLocal(["bookmarkById", "order"]);
    const bookmarkById = cur.bookmarkById || {};
    const order = Array.isArray(cur.order) ? cur.order.slice() : [];
    for (const b of list) {
      if (!bookmarkById[b.id]) order.push(b.id);
      bookmarkById[b.id] = b;
    }
    await setLocal({ bookmarkById, order });
  }

  // Rebuild `order` from a full active fetch so it reflects bookmark recency
  // (API timeline order = most-recently-bookmarked first), then any older known
  // ids not in this fetch. This is the authoritative ordering for newest/oldest.
  async function applyFetchedBookmarks(collected) {
    const cur = await getLocal(["bookmarkById", "order"]);
    const bookmarkById = cur.bookmarkById || {};
    const prevOrder = Array.isArray(cur.order) ? cur.order : [];
    const fetchedIds = [];
    const seen = new Set();
    for (const b of collected) {
      bookmarkById[b.id] = b;
      if (!seen.has(b.id)) {
        seen.add(b.id);
        fetchedIds.push(b.id);
      }
    }
    const tail = prevOrder.filter((id) => !seen.has(id) && bookmarkById[id]);
    await setLocal({
      bookmarkById,
      order: fetchedIds.concat(tail),
      lastFetchedAt: new Date().toISOString(),
    });
  }

  // ---------- seed creds via service worker bundle-scrape (U2) ----------
  function findBundleUrl() {
    const direct = document.querySelector(
      'script[src*="abs.twimg.com/responsive-web/client-web/main."]'
    );
    if (direct) return direct.src;
    const all = Array.prototype.slice.call(
      document.querySelectorAll('script[src*="abs.twimg.com/responsive-web/client-web"]')
    );
    const main = all.find((s) => /\/main\./.test(s.src));
    const pick = main || all[0];
    return pick ? pick.src : null;
  }

  function scrapeCredsViaSW() {
    if (!isContextValid()) return Promise.resolve(null);
    const bundleUrl = findBundleUrl();
    if (!bundleUrl) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "scrapeCreds", bundleUrl }, (resp) => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve(null);
          resolve(resp && resp.creds ? resp.creds : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // ---------- active refresh (self-healing) ----------
  function buildHeaders(creds, ct0) {
    const h = Object.assign({}, creds.headerAllowlist || {});
    if (creds.bearer) h["authorization"] = creds.bearer;
    h["x-csrf-token"] = ct0;
    h["x-twitter-active-user"] = h["x-twitter-active-user"] || "yes";
    h["x-twitter-auth-type"] = h["x-twitter-auth-type"] || "OAuth2Session";
    h["x-twitter-client-language"] = h["x-twitter-client-language"] || "en";
    h["content-type"] = "application/json";
    return h;
  }

  function buildUrl(creds, variables) {
    let url =
      location.origin +
      "/i/api/graphql/" +
      creds.queryId +
      "/" +
      (creds.operationName || "Bookmarks") +
      "?variables=" +
      encodeURIComponent(JSON.stringify(variables)) +
      "&features=" +
      encodeURIComponent(JSON.stringify(creds.features || {}));
    if (creds.fieldToggles)
      url += "&fieldToggles=" + encodeURIComponent(JSON.stringify(creds.fieldToggles));
    return url;
  }

  async function maybeRefresh() {
    if (refreshInFlight || !isContextValid()) return;
    if (location.origin !== "https://x.com") return;
    const { lastFetchedAt, creds } = await getLocal(["lastFetchedAt", "creds"]);
    let c = creds;
    if (!c || !c.queryId) {
      c = await scrapeCredsViaSW();
      if (!c || !c.queryId) return;
    } else if (lastFetchedAt && Date.now() - Date.parse(lastFetchedAt) < REFRESH_INTERVAL_MS) {
      return;
    }
    refreshInFlight = true;
    try {
      await activeRefresh(c);
    } catch (e) {
      console.warn(LOG, "refresh failed", e);
    } finally {
      refreshInFlight = false;
    }
  }

  async function activeRefresh(creds) {
    const ct0 = getCookie("ct0");
    if (!ct0) return;
    let c = creds;
    let rescraped = false;
    const seen = new Set();
    const collected = [];
    let cursor = "";
    let pages = 0;

    while (pages < MAX_PAGES) {
      const variables = Object.assign({}, c.variables || {});
      variables.count = variables.count || PER_PAGE;
      if (cursor) variables.cursor = cursor;
      else delete variables.cursor;

      let resp;
      try {
        resp = await fetch(buildUrl(c, variables), {
          method: "GET",
          credentials: "include",
          headers: buildHeaders(c, ct0),
        });
      } catch (e) {
        break;
      }

      if ((resp.status === 400 || resp.status === 403) && !rescraped) {
        rescraped = true;
        const nc = await scrapeCredsViaSW();
        if (nc && nc.queryId) {
          c = nc;
          continue; // retry same page with fresh creds
        }
        break;
      }
      if (!resp.ok || resp.status === 429) break;

      let json;
      try {
        json = await resp.json();
      } catch (e) {
        break;
      }
      const { bookmarks, cursor: next } = parseBookmarks(json);
      if (bookmarks.length) collected.push(...bookmarks);
      pages++;
      if (!next || next === cursor || seen.has(next) || bookmarks.length === 0) break;
      seen.add(next);
      cursor = next;
    }

    if (collected.length) await applyFetchedBookmarks(collected);
    else await setLocal({ lastFetchedAt: new Date().toISOString() });
    console.debug(LOG, "active refresh pulled", collected.length, "over", pages, "pages");
  }

  // ---------- eligibility + mutations ----------
  async function eligibleList() {
    const { bookmarkById, order, doneById, snoozedById } = await getLocal([
      "bookmarkById",
      "order",
      "doneById",
      "snoozedById",
    ]);
    if (!bookmarkById || !order) return [];
    const done = doneById || {};
    const sn = snoozedById || {};
    const now = Date.now();
    return order
      .filter((id) => bookmarkById[id] && !done[id] && !(sn[id] && Date.parse(sn[id]) > now))
      .map((id) => bookmarkById[id]); // order = bookmark recency, newest first
  }

  function orderEligible(list, order) {
    if (order === "oldest") return list.slice().reverse();
    if (order === "random") {
      const a = list.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
      }
      return a;
    }
    return list; // "newest" = as-is
  }

  // The prev/next pool: eligible bookmarks ordered per settings, capped at 20
  // unless poolSize is "all".
  async function pickPool(settings) {
    const s = settings || (await getSettings());
    let list = orderEligible(await eligibleList(), s.order);
    if (s.poolSize === 20) list = list.slice(0, 20);
    return list;
  }

  async function markDone(id) {
    const { doneById } = await getLocal(["doneById"]);
    const map = doneById || {};
    map[id] = true;
    await setLocal({ doneById: map });
  }
  async function unmarkDone(id) {
    const { doneById } = await getLocal(["doneById"]);
    const map = doneById || {};
    delete map[id];
    await setLocal({ doneById: map });
  }
  async function snooze(id) {
    const { snoozedById } = await getLocal(["snoozedById"]);
    const map = snoozedById || {};
    map[id] = new Date(Date.now() + SNOOZE_MS).toISOString();
    await setLocal({ snoozedById: map });
  }
  async function unsnooze(id) {
    const { snoozedById } = await getLocal(["snoozedById"]);
    const map = snoozedById || {};
    delete map[id];
    await setLocal({ snoozedById: map });
  }

  // ---------- DOM helpers ----------
  function isHomeRoute() {
    const p = location.pathname;
    return p === "/" || p === "/home";
  }
  function getPrimaryColumn() {
    return document.querySelector('div[data-testid="primaryColumn"]');
  }
  function getTimelineSection(col) {
    if (!col) return null;
    return (
      col.querySelector('section[aria-label="Timeline: Your Home Timeline"]') ||
      col.querySelector('section[aria-label="Home timeline"]') ||
      col.querySelector('section[aria-label^="Timeline"]') ||
      col.querySelector('section[role="region"]') ||
      col.querySelector("section")
    );
  }
  function detectTheme() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const nums = bg.match(/\d+/g);
      if (nums && nums.length >= 3) {
        const lum = 0.299 * +nums[0] + 0.587 * +nums[1] + 0.114 * +nums[2];
        return lum < 128 ? "dark" : "light";
      }
    } catch (_) {}
    return "light";
  }
  function removeCard() {
    const el = document.getElementById(HOST_ID);
    if (el) el.remove();
  }

  const THEMES = {
    light: {
      bg: "#fff",
      border: "rgb(239,243,244)",
      text: "rgb(15,20,25)",
      sub: "rgb(83,100,113)",
      btnBorder: "rgb(207,217,222)",
      hover: "rgba(0,0,0,0.04)",
    },
    dark: {
      bg: "#000",
      border: "rgb(47,51,54)",
      text: "rgb(231,233,234)",
      sub: "rgb(113,118,123)",
      btnBorder: "rgb(66,83,100)",
      hover: "rgba(255,255,255,0.06)",
    },
  };
  const ACCENT = "#1d9b8e";
  const FONT =
    'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  const ICONS = {
    bookmark:
      '<path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5z"></path>',
    reply:
      '<path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01z"></path>',
    repost:
      '<path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"></path>',
    like:
      '<path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91z"></path>',
    view:
      '<path d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"></path>',
    gear:
      '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.49.49 0 00.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"></path>',
  };

  function statSvg(path) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + path + "</svg>";
  }

  function buildCardMarkup(bm, theme, pos) {
    const t = THEMES[theme] || THEMES.light;
    const css = `
      :host { all: initial; display: block; }
      .wrap { font-family:${FONT}; background:${t.bg}; color:${t.text};
        border-bottom:1px solid ${t.border}; padding:12px 16px 10px; box-sizing:border-box; }
      .top { display:flex; align-items:center; gap:6px; margin-bottom:10px; }
      .top .bk { width:17px; height:17px; fill:${ACCENT}; }
      .top .lbl { color:${ACCENT}; font-weight:700; font-size:14px; }
      .top .spacer { flex:1; }
      .nav { display:flex; align-items:center; gap:2px; color:${t.sub}; font-size:13px; }
      .nav button, .x { cursor:pointer; border:0; background:transparent; color:${t.sub};
        border-radius:999px; padding:4px 8px; font-size:16px; line-height:1; }
      .nav button:hover, .x:hover { background:${t.hover}; color:${ACCENT}; }
      .nav .pos { min-width:54px; text-align:center; font-variant-numeric:tabular-nums; font-size:13px; }
      .gear { cursor:pointer; border:0; background:transparent; padding:4px; border-radius:999px; display:inline-flex; }
      .gear svg { width:18px; height:18px; fill:${t.sub}; }
      .gear:hover { background:${t.hover}; }
      .gear:hover svg { fill:${ACCENT}; }
      .author { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
      .avatar { width:36px; height:36px; border-radius:999px; flex:none; background:${t.border}; object-fit:cover; }
      .who { display:flex; flex-direction:column; line-height:1.2; min-width:0; }
      .name { font-weight:700; font-size:15px; display:flex; align-items:center; gap:3px;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .badge { width:15px; height:15px; fill:${ACCENT}; flex:none; }
      .handle { color:${t.sub}; font-size:14px; }
      .text { font-size:15px; line-height:1.45; white-space:pre-wrap; word-break:break-word;
        margin:4px 0 10px; max-height:340px; overflow-y:auto; }
      .media { margin:0 0 10px; border:1px solid ${t.border}; border-radius:14px; overflow:hidden; position:relative; }
      .media img { display:block; width:100%; max-height:320px; object-fit:cover; cursor:pointer; }
      .media .play { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none; }
      .media .play span { width:54px; height:54px; border-radius:999px; background:rgba(0,0,0,0.6);
        display:flex; align-items:center; justify-content:center; }
      .media .play span::after { content:""; border-style:solid; border-width:11px 0 11px 18px;
        border-color:transparent transparent transparent #fff; margin-left:4px; }
      .linkcard { display:block; border:1px solid ${t.border}; border-radius:14px;
        padding:12px 14px; margin:0 0 12px; cursor:pointer; }
      .linkcard:hover { background:${t.hover}; }
      .lc-domain { display:block; color:${t.sub}; font-size:13px; margin-bottom:3px; }
      .lc-title { display:block; font-weight:700; font-size:15px; line-height:1.3;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .stats { display:flex; gap:18px; color:${t.sub}; font-size:13px; margin:0 0 12px; flex-wrap:wrap; }
      .stat { display:flex; align-items:center; gap:5px; font-variant-numeric:tabular-nums; }
      .stat svg { width:16px; height:16px; fill:${t.sub}; }
      .actions { display:flex; gap:8px; flex-wrap:wrap; }
      button.act { font-family:${FONT}; font-weight:700; font-size:14px; padding:7px 16px;
        border-radius:999px; cursor:pointer; border:1px solid ${t.btnBorder}; background:transparent; color:${t.text}; }
      button.act:hover { background:${t.hover}; }
      button.read { background:${ACCENT}; color:#fff; border-color:${ACCENT}; }
      button.read:hover { filter:brightness(0.93); }
      .toast { display:flex; align-items:center; gap:12px; background:${t.hover}; color:${t.sub};
        font-size:13px; padding:7px 12px; border-radius:8px; margin-bottom:10px; }
      .toast button { color:${ACCENT}; font-weight:700; background:transparent; border:0; cursor:pointer; font-size:13px; }
    `;

    const safe = (s) =>
      String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
      );

    const avatarImg = bm.authorAvatarUrl
      ? `<img class="avatar" src="${safe(bm.authorAvatarUrl)}" alt="">`
      : `<div class="avatar"></div>`;
    const badge = bm.verified
      ? '<svg class="badge" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"></path></svg>'
      : "";
    const dateStr = formatDate(bm.createdAt);
    const meta = "@" + safe(bm.authorHandle) + (dateStr ? " · " + safe(dateStr) : "");

    let mediaHtml = "";
    if (bm.media && bm.media.length) {
      const m = bm.media[0];
      const play = m.type !== "photo" ? '<div class="play"><span></span></div>' : "";
      mediaHtml = `<div class="media" data-act="open"><img src="${safe(m.poster)}" alt="">${play}</div>`;
    }

    const textHtml = bm.text ? `<div class="text">${safe(bm.text)}</div>` : "";

    let linkHtml = "";
    if (bm.link && (bm.link.title || bm.link.url)) {
      linkHtml =
        `<div class="linkcard" data-act="openlink">` +
        (bm.link.domain ? `<span class="lc-domain">${safe(bm.link.domain)}</span>` : "") +
        `<span class="lc-title">${safe(bm.link.title || bm.link.url)}</span>` +
        `</div>`;
    }

    const s = bm.stats || {};
    const statHtml =
      `<div class="stats">` +
      `<span class="stat">${statSvg(ICONS.reply)}${formatCount(s.replies)}</span>` +
      `<span class="stat">${statSvg(ICONS.repost)}${formatCount(s.reposts)}</span>` +
      `<span class="stat">${statSvg(ICONS.like)}${formatCount(s.likes)}</span>` +
      (bm.views != null
        ? `<span class="stat">${statSvg(ICONS.view)}${formatCount(bm.views)}</span>`
        : "") +
      (s.bookmarks
        ? `<span class="stat"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.bookmark}</svg>${formatCount(s.bookmarks)}</span>`
        : "") +
      `</div>`;

    const total = pos ? pos.total : 1;
    const idx1 = pos ? pos.idx + 1 : 1;
    const navHtml =
      total > 1
        ? `<div class="nav"><button data-act="prev" title="上一条">‹</button>` +
          `<span class="pos">${idx1} / ${total}</span>` +
          `<button data-act="next" title="下一条">›</button></div>`
        : "";

    return `
      <style>${css}</style>
      <div class="wrap">
        <div class="top">
          <svg class="bk" viewBox="0 0 24 24" aria-hidden="true">${ICONS.bookmark}</svg>
          <span class="lbl">From your bookmarks</span>
          <span class="spacer"></span>
          ${navHtml}
          <button class="gear" data-act="settings" title="设置 / Settings"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.gear}</svg></button>
          <button class="x" data-act="dismiss" title="Hide for now">✕</button>
        </div>
        <div class="author">
          ${avatarImg}
          <div class="who">
            <span class="name">${safe(bm.authorName || bm.authorHandle)}${badge}</span>
            <span class="handle">${meta}</span>
          </div>
        </div>
        ${textHtml}
        ${mediaHtml}
        ${linkHtml}
        ${statHtml}
        <div class="actions">
          <button class="act read" data-act="read">Read</button>
          <button class="act" data-act="done">Done</button>
          <button class="act" data-act="keep">Keep for later</button>
        </div>
      </div>`;
  }

  function buildSettingsMarkup(settings, theme) {
    const t = THEMES[theme] || THEMES.light;
    const css = `
      :host { all: initial; display: block; }
      .wrap { font-family:${FONT}; background:${t.bg}; color:${t.text};
        border-bottom:1px solid ${t.border}; padding:12px 16px 14px; box-sizing:border-box; }
      .top { display:flex; align-items:center; gap:6px; margin-bottom:14px; }
      .top .bk { width:17px; height:17px; fill:${ACCENT}; }
      .top .lbl { color:${ACCENT}; font-weight:700; font-size:14px; }
      .top .spacer { flex:1; }
      .backbtn { cursor:pointer; border:0; background:transparent; color:${t.sub}; font-weight:700;
        font-size:14px; padding:4px 10px; border-radius:999px; }
      .backbtn:hover { background:${t.hover}; color:${ACCENT}; }
      .grp { margin-bottom:14px; }
      .grp-title { font-size:13px; color:${t.sub}; margin-bottom:7px; }
      .seg { display:flex; gap:8px; flex-wrap:wrap; }
      .opt { font-family:${FONT}; font-size:14px; font-weight:600; cursor:pointer; padding:7px 14px;
        border-radius:999px; border:1px solid ${t.btnBorder}; background:transparent; color:${t.text}; }
      .opt:hover { background:${t.hover}; }
      .opt.on { background:${ACCENT}; color:#fff; border-color:${ACCENT}; }
    `;
    const pool = settings.poolSize === "all" ? "all" : 20;
    const order = settings.order;
    const opt = (act, val, label, active) =>
      `<button class="opt${active ? " on" : ""}" data-act="${act}" data-val="${val}">${label}</button>`;
    return `
      <style>${css}</style>
      <div class="wrap">
        <div class="top">
          <svg class="bk" viewBox="0 0 24 24" aria-hidden="true">${ICONS.gear}</svg>
          <span class="lbl">设置 / Settings</span>
          <span class="spacer"></span>
          <button class="backbtn" data-act="back" title="返回 / Back">‹ 返回</button>
        </div>
        <div class="grp">
          <div class="grp-title">显示数量 / Items</div>
          <div class="seg">
            ${opt("set-pool", "20", "20 条", pool === 20)}
            ${opt("set-pool", "all", "全量 All", pool === "all")}
          </div>
        </div>
        <div class="grp">
          <div class="grp-title">排序 / Order</div>
          <div class="seg">
            ${opt("set-order", "random", "随机 Random", order === "random")}
            ${opt("set-order", "newest", "最新到旧 Newest", order === "newest")}
            ${opt("set-order", "oldest", "最旧到新 Oldest", order === "oldest")}
          </div>
        </div>
      </div>`;
  }

  function showToast(shadow, label, withUndo) {
    const wrap = shadow.querySelector(".wrap");
    if (!wrap) return;
    const ex = wrap.querySelector(".toast");
    if (ex) ex.remove();
    const div = document.createElement("div");
    div.className = "toast";
    div.innerHTML = `<span>${label}</span>` + (withUndo ? `<button data-act="undo">Undo</button>` : "");
    wrap.insertBefore(div, wrap.firstChild);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      const tEl = wrap.querySelector(".toast");
      if (tEl) tEl.remove();
    }, TOAST_MS);
  }

  function clearToastAndUndo() {
    lastAction = null;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function removeFromList(id) {
    currentList = currentList.filter((b) => b.id !== id);
    if (currentIdx >= currentList.length) currentIdx = Math.max(0, currentList.length - 1);
  }

  function renderCurrent(host) {
    const bm = currentList[currentIdx];
    if (!bm) {
      removeCard();
      return;
    }
    const theme = detectTheme();
    host.dataset.bookmarkId = bm.id;
    host.dataset.theme = theme;
    host.shadowRoot.innerHTML = buildCardMarkup(bm, theme, {
      idx: currentIdx,
      total: currentList.length,
    });
  }

  function renderSettings(host) {
    const theme = detectTheme();
    host.dataset.theme = theme;
    host.shadowRoot.innerHTML = buildSettingsMarkup(currentSettings, theme);
  }

  // View dispatcher — always use this where view mode can vary (theme refresh,
  // settings changes, cross-tab updates) so we never kick the user out of a view.
  function render(host) {
    if (viewMode === "settings") renderSettings(host);
    else renderCurrent(host);
  }

  function afterAction(host, bm, type, label) {
    lastAction = { bm, type };
    removeFromList(bm.id);
    if (!currentList.length) {
      removeCard();
      return;
    }
    renderCurrent(host);
    showToast(host.shadowRoot, label, type !== "keep");
  }

  async function injectCard(col) {
    if (document.getElementById(HOST_ID)) return;
    currentSettings = await getSettings();
    currentList = await pickPool(currentSettings);
    if (!currentList.length) return;
    currentIdx = 0; // ordering (incl. random shuffle) owns the start
    viewMode = "card";

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "display:block;width:100%;";
    host.attachShadow({ mode: "open" });
    col.insertBefore(host, col.firstChild);

    // single delegated listener; survives innerHTML rebuilds
    host.shadowRoot.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      if (!isContextValid()) {
        teardown();
        return;
      }
      const act = btn.dataset.act;
      if (act === "prev") {
        if (currentList.length) {
          currentIdx = (currentIdx - 1 + currentList.length) % currentList.length;
          renderCurrent(host);
        }
        return;
      }
      if (act === "next") {
        if (currentList.length) {
          currentIdx = (currentIdx + 1) % currentList.length;
          renderCurrent(host);
        }
        return;
      }
      if (act === "settings") {
        viewMode = "settings";
        render(host);
        return;
      }
      if (act === "back") {
        viewMode = "card";
        render(host);
        return;
      }
      if (act === "set-pool" || act === "set-order") {
        const val = btn.dataset.val;
        const patch =
          act === "set-pool" ? { poolSize: val === "all" ? "all" : 20 } : { order: val };
        currentSettings = await saveSettings(patch); // single apply path
        clearToastAndUndo();
        const curId = currentList[currentIdx] && currentList[currentIdx].id;
        currentList = await pickPool(currentSettings);
        const ni = curId ? currentList.findIndex((b) => b.id === curId) : -1;
        currentIdx = ni >= 0 ? ni : 0;
        render(host); // stay in settings view
        return;
      }
      const bm = currentList[currentIdx];
      if (act === "open") {
        if (bm) window.open(bm.tweetUrl, "_blank", "noopener");
      } else if (act === "openlink") {
        if (bm && bm.link && bm.link.url) window.open(bm.link.url, "_blank", "noopener");
      } else if (act === "read") {
        if (!bm) return;
        window.open(bm.tweetUrl, "_blank", "noopener");
        await markDone(bm.id);
        afterAction(host, bm, "read", "Opened & marked done.");
      } else if (act === "done") {
        if (!bm) return;
        await markDone(bm.id);
        afterAction(host, bm, "done", "Marked done.");
      } else if (act === "keep") {
        if (!bm) return;
        await snooze(bm.id);
        afterAction(host, bm, "keep", "Kept for later (24h).");
      } else if (act === "dismiss") {
        sessionDismissed = true;
        removeCard();
      } else if (act === "undo") {
        if (lastAction) {
          const la = lastAction;
          lastAction = null;
          if (la.type === "read" || la.type === "done") await unmarkDone(la.bm.id);
          else if (la.type === "keep") await unsnooze(la.bm.id);
          currentList.splice(Math.min(currentIdx, currentList.length), 0, la.bm);
          renderCurrent(host);
        }
      }
    });

    render(host);
  }

  function updateCardTheme() {
    const host = document.getElementById(HOST_ID);
    if (!host || !host.shadowRoot) return;
    if (host.dataset.theme === detectTheme()) return;
    render(host);
  }

  // ---------- main loop ----------
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!isContextValid()) {
        teardown();
        return;
      }
      if (!isHomeRoute()) {
        removeCard();
        return;
      }
      const col = getPrimaryColumn();
      if (!col) return;
      const section = getTimelineSection(col);
      if (!section) return;
      if (!section.querySelector('div[data-testid="cellInnerDiv"]')) return;

      maybeRefresh(); // fire-and-forget

      const existing = document.getElementById(HOST_ID);
      if (existing && existing.isConnected) {
        updateCardTheme();
        return;
      }
      if (sessionDismissed || shownThisLoad) return;

      await injectCard(col);
      if (document.getElementById(HOST_ID)) shownThisLoad = true;
    } finally {
      busy = false;
    }
  }

  function debounce(fn, ms) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function teardown() {
    if (_destroyed) return;
    _destroyed = true;
    if (_observer) {
      try {
        _observer.disconnect();
      } catch (_) {}
      _observer = null;
    }
    if (_popstateHandler) window.removeEventListener("popstate", _popstateHandler);
    if (_messageHandler) window.removeEventListener("message", _messageHandler);
    if (_storageHandler) {
      try {
        chrome.storage.onChanged.removeListener(_storageHandler);
      } catch (_) {}
    }
    removeCard();
  }

  function start() {
    _messageHandler = onMessage;
    window.addEventListener("message", _messageHandler);

    _storageHandler = async (changes, area) => {
      if (area !== "local") return;
      const host = document.getElementById(HOST_ID);
      if (!host) return;

      // Settings changed (possibly another tab): rebuild the pool + re-render.
      // Handled before any current-card guard. Deduped against the locally-applied
      // value so our own write doesn't trigger a second (re-shuffling) rebuild.
      if (changes.settings) {
        const ns = normalizeSettings(changes.settings.newValue);
        if (ns.poolSize === currentSettings.poolSize && ns.order === currentSettings.order) return;
        currentSettings = ns;
        const curId = currentList[currentIdx] && currentList[currentIdx].id;
        currentList = await pickPool(currentSettings);
        const ni = curId ? currentList.findIndex((b) => b.id === curId) : -1;
        currentIdx = ni >= 0 ? ni : 0;
        if (!currentList.length) removeCard();
        else render(host);
        return;
      }

      // Done/snooze changed: re-filter the whole pool (catches off-screen items
      // marked in another tab). Filtering the existing list — not a fresh pickPool —
      // means our own just-applied action is a no-op here, so the Undo toast survives.
      if (changes.doneById || changes.snoozedById) {
        const { doneById, snoozedById } = await getLocal(["doneById", "snoozedById"]);
        const done = doneById || {};
        const sn = snoozedById || {};
        const now = Date.now();
        const before = currentList.length;
        const curId = currentList[currentIdx] && currentList[currentIdx].id;
        currentList = currentList.filter(
          (b) => !done[b.id] && !(sn[b.id] && Date.parse(sn[b.id]) > now)
        );
        if (currentList.length !== before) {
          const ni = curId ? currentList.findIndex((b) => b.id === curId) : -1;
          currentIdx = ni >= 0 ? ni : Math.min(currentIdx, Math.max(0, currentList.length - 1));
          if (!currentList.length) removeCard();
          else if (viewMode === "card") render(host);
        }
      }
    };
    try {
      chrome.storage.onChanged.addListener(_storageHandler);
    } catch (_) {}

    _popstateHandler = () => setTimeout(tick, 80);
    window.addEventListener("popstate", _popstateHandler);

    _observer = new MutationObserver(
      debounce(() => {
        if (!isContextValid()) {
          teardown();
          return;
        }
        tick();
      }, DEBOUNCE_MS)
    );
    _observer.observe(document.body, { childList: true, subtree: true });
    tick();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
