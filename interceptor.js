// interceptor.js — runs in the MAIN world at document_start.
// It patches window.fetch (and XHR as a backup) to observe X's own GraphQL
// traffic. When X fetches its Bookmarks timeline, we:
//   1. capture a full request template (queryId, operationName, variables,
//      features, fieldToggles, bearer, sanitized header allowlist), and
//   2. read a clone() of the response body — never the original — so X's own
//      request is never affected.
// Both are relayed to the isolated-world content script via window.postMessage
// as JSON strings, tagged with a private marker. The patched fetch always
// returns the original, untouched promise/response.
(function () {
  "use strict";

  const MARKER = "__bookmark_nudge__";

  // Headers we must never replay / persist: cookies are sent automatically,
  // csrf is re-derived from the live ct0 cookie at call time, and the rest are
  // volatile / browser-controlled.
  const VOLATILE_HEADERS = new Set([
    "cookie",
    "x-csrf-token",
    "content-length",
    "content-type",
    "host",
    "user-agent",
    "accept-encoding",
    "connection",
    "x-client-transaction-id",
    "x-xp-forwarded-for",
  ]);

  function relay(type, payloadObj) {
    try {
      window.postMessage(
        { source: MARKER, type, payload: JSON.stringify(payloadObj) },
        location.origin
      );
    } catch (_) {
      /* ignore */
    }
  }

  function safeJSON(str) {
    if (str == null) return undefined;
    try {
      return JSON.parse(str);
    } catch (_) {
      return undefined;
    }
  }

  function headersToObject(h) {
    const out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== "undefined" && h instanceof Headers) {
        h.forEach((v, k) => (out[String(k).toLowerCase()] = v));
      } else if (Array.isArray(h)) {
        for (const pair of h) {
          if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = pair[1];
        }
      } else if (typeof h === "object") {
        for (const k in h) {
          if (Object.prototype.hasOwnProperty.call(h, k)) {
            out[String(k).toLowerCase()] = h[k];
          }
        }
      }
    } catch (_) {
      /* ignore */
    }
    return out;
  }

  function sanitizeHeaders(obj) {
    const out = {};
    for (const k in obj) {
      if (!VOLATILE_HEADERS.has(k)) out[k] = obj[k];
    }
    return out;
  }

  function isBookmarksUrl(url) {
    return (
      typeof url === "string" &&
      /\/i\/api\/graphql\//.test(url) &&
      /Bookmarks/i.test(url)
    );
  }

  // Build the request template from the URL + headers.
  function buildTemplate(url, headersObj) {
    try {
      const u = new URL(url, location.origin);
      const m = u.pathname.match(/\/graphql\/([^/]+)\/([^/?]+)/);
      if (!m) return null;
      const operationName = m[2];
      if (!/Bookmarks/i.test(operationName)) return null;

      const tmpl = {
        queryId: m[1],
        operationName,
        variables: safeJSON(u.searchParams.get("variables")),
        features: safeJSON(u.searchParams.get("features")),
        fieldToggles: safeJSON(u.searchParams.get("fieldToggles")),
        bearer: headersObj["authorization"] || undefined,
        headerAllowlist: sanitizeHeaders(headersObj),
        capturedAt: new Date().toISOString(),
      };
      return tmpl;
    } catch (_) {
      return null;
    }
  }

  // ---- Patch window.fetch ----
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      const promise = originalFetch.apply(this, arguments);
      try {
        const url =
          typeof input === "string"
            ? input
            : (input && input.url) || "";
        if (isBookmarksUrl(url)) {
          // Collect headers from whichever arg carries them.
          let headersObj = {};
          if (init && init.headers) headersObj = headersToObject(init.headers);
          else if (input && typeof input === "object" && input.headers)
            headersObj = headersToObject(input.headers);

          const tmpl = buildTemplate(url, headersObj);
          if (tmpl) relay("template", tmpl);

          // Read a clone asynchronously; never touch the original body.
          promise
            .then((resp) => {
              try {
                resp
                  .clone()
                  .json()
                  .then((json) => relay("response", json))
                  .catch(() => {});
              } catch (_) {
                /* ignore */
              }
            })
            .catch(() => {});
        }
      } catch (_) {
        /* never let our logic break X's fetch */
      }
      return promise;
    };
  }

  // ---- Patch XMLHttpRequest (best-effort backup) ----
  try {
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    const origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      this.__bn_url = url;
      this.__bn_headers = {};
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (this.__bn_headers) this.__bn_headers[String(name).toLowerCase()] = value;
      } catch (_) {}
      return origSetHeader.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        if (isBookmarksUrl(this.__bn_url)) {
          const tmpl = buildTemplate(this.__bn_url, this.__bn_headers || {});
          if (tmpl) relay("template", tmpl);
          this.addEventListener("load", function () {
            try {
              const json = safeJSON(this.responseText);
              if (json) relay("response", json);
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  } catch (_) {
    /* XHR patch is optional */
  }
})();
