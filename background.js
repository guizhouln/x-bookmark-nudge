// background.js — MV3 service worker.
// Single job: on demand, fetch X's web-client JS bundle from abs.twimg.com and
// regex-extract the Bookmarks GraphQL operation's queryId + feature switches +
// field toggles, so content.js can actively pull bookmarks WITHOUT the user ever
// opening the bookmarks page. Cross-origin abs.twimg.com fetch is done here (the
// SW bypasses page CORS via host_permissions). Self-healing: re-scrape whenever
// content.js reports missing/stale creds.

// The public web-client OAuth2 app bearer (a hardcoded constant in X's bundle, not
// a user secret). Used as a fallback; the user's own session cookies do the auth.
const PUBLIC_BEARER =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// Matches: {queryId:"...",operationName:"Bookmarks",operationType:"query",metadata:{featureSwitches:[...],fieldToggles:[...]}}
const BOOKMARKS_RE =
  /\{queryId:"([^"]+)",operationName:"Bookmarks",operationType:"query",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]/;

function namesToTrueMap(listStr) {
  const out = {};
  if (!listStr) return out;
  const names = listStr.match(/"([^"]+)"/g);
  if (!names) return out;
  for (const n of names) out[n.replace(/"/g, "")] = true;
  return out;
}

async function scrapeCreds(bundleUrl) {
  const resp = await fetch(bundleUrl);
  if (!resp.ok) throw new Error("bundle fetch " + resp.status);
  const text = await resp.text();
  const m = text.match(BOOKMARKS_RE);
  if (!m) throw new Error("Bookmarks operation not found in bundle");
  const creds = {
    queryId: m[1],
    operationName: "Bookmarks",
    variables: { count: 100, includePromotedContent: false },
    features: namesToTrueMap(m[2]),
    fieldToggles: namesToTrueMap(m[3]),
    bearer: PUBLIC_BEARER,
    source: "bundle",
  };
  return creds;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "scrapeCreds" || !msg.bundleUrl) return;
  scrapeCreds(msg.bundleUrl)
    .then((creds) => {
      // Don't clobber higher-fidelity creds captured live by the interceptor.
      chrome.storage.local.get(["creds"], (cur) => {
        const existing = cur && cur.creds;
        if (existing && existing.source === "interceptor" && existing.queryId) {
          sendResponse({ creds: existing });
          return;
        }
        chrome.storage.local.set({ creds }, () => sendResponse({ creds }));
      });
    })
    .catch((err) => {
      console.warn("[BookmarkNudge SW] scrape failed:", err && err.message);
      sendResponse({ error: String((err && err.message) || err) });
    });
  return true; // async sendResponse
});
