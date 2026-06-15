// ============================================================
// background.js — OAuth2 + Mendeley API handler
// ============================================================

const MENDELEY_CLIENT_ID = "YOUR_CLIENT_ID_HERE"; // injected by build.js       // ← Replace after registering app
const MENDELEY_CLIENT_SECRET = "YOUR_CLIENT_SECRET_HERE"; // ← Replace after registering app
const REDIRECT_URL = chrome.identity.getRedirectURL();   // Auto-generates your extension's callback URL

const MENDELEY_AUTH_URL = "https://api.mendeley.com/oauth/authorize";
const MENDELEY_TOKEN_URL = "https://api.mendeley.com/oauth/token";
const MENDELEY_API_BASE  = "https://api.mendeley.com";
const SCOPES = "all";

// ── Token storage helpers ─────────────────────────────────────
async function saveTokens(tokens) {
  const expiresAt = Date.now() + tokens.expires_in * 1000;
  await chrome.storage.local.set({ mendeley_tokens: { ...tokens, expires_at: expiresAt } });
}

async function getTokens() {
  const data = await chrome.storage.local.get("mendeley_tokens");
  return data.mendeley_tokens || null;
}

async function clearTokens() {
  await chrome.storage.local.remove("mendeley_tokens");
}

// ── OAuth2 Authorization Code Flow ───────────────────────────
async function launchOAuth() {
  const state = Math.random().toString(36).slice(2);
  const authUrl =
    `${MENDELEY_AUTH_URL}?response_type=code` +
    `&client_id=${encodeURIComponent(MENDELEY_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URL)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${state}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      async (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          return reject(new Error(chrome.runtime.lastError?.message || "Auth cancelled"));
        }
        const url = new URL(responseUrl);
        const code = url.searchParams.get("code");
        if (!code) return reject(new Error("No auth code returned"));

        try {
          const tokens = await exchangeCodeForToken(code);
          await saveTokens(tokens);
          resolve(tokens);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function exchangeCodeForToken(code) {
  // Mendeley requires HTTP Basic Auth (client_id:client_secret), NOT body params
  const basicAuth = btoa(`${MENDELEY_CLIENT_ID}:${MENDELEY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URL,
  });

  const res = await fetch(MENDELEY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed: ${res.status} — ${errText}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  // Same: Basic Auth required for refresh too
  const basicAuth = btoa(`${MENDELEY_CLIENT_ID}:${MENDELEY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    redirect_uri: REDIRECT_URL,
  });

  const res = await fetch(MENDELEY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  return res.json();
}

// ── Get valid access token (auto-refresh if expired) ─────────
async function getValidAccessToken() {
  let tokens = await getTokens();
  if (!tokens) return null;

  const isExpired = Date.now() >= tokens.expires_at - 60000; // 1-min buffer
  if (isExpired && tokens.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(tokens.refresh_token);
      await saveTokens(refreshed);
      tokens = refreshed;
    } catch {
      await clearTokens();
      return null;
    }
  }
  return tokens.access_token;
}

// ── Mendeley library search ───────────────────────────────────

const LIBRARY_CACHE_KEY = "msc_lib_cache";
const LIBRARY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Fetch all documents from the user's library and cache them locally.
// The Mendeley API does not support title-based search within a personal library,
// so we maintain a local index and fuzzy-match against it.
async function getLibraryIndex(accessToken) {
  const stored = await chrome.storage.local.get(LIBRARY_CACHE_KEY);
  const cache = stored[LIBRARY_CACHE_KEY];
  if (cache && Date.now() - cache.ts < LIBRARY_CACHE_TTL) return cache.docs;

  const docs = [];
  let nextUrl = `${MENDELEY_API_BASE}/documents?limit=500`;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.mendeley-document.1+json",
      },
    });
    if (!res.ok) break;

    const page = await res.json();
    for (const d of page) {
      docs.push({ title: d.title || "", doi: d.identifiers?.doi || "" });
    }

    // Follow pagination via Link header
    const linkHeader = res.headers.get("Link") || "";
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = nextMatch ? nextMatch[1] : null;
  }

  await chrome.storage.local.set({ [LIBRARY_CACHE_KEY]: { docs, ts: Date.now() } });
  return docs;
}

function invalidateLibraryCache() {
  return chrome.storage.local.remove(LIBRARY_CACHE_KEY);
}

// Normalize title for fuzzy comparison
function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function titlesMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  // Prefix match (Scholar sometimes truncates with "…")
  if (na.length > 20 && nb.startsWith(na.slice(0, Math.floor(na.length * 0.85)))) return true;
  if (nb.length > 20 && na.startsWith(nb.slice(0, Math.floor(nb.length * 0.85)))) return true;
  // Word-overlap: ≥85% of significant words in the shorter title appear in the longer one
  const wa = new Set(na.split(" ").filter((w) => w.length > 3));
  const wb = new Set(nb.split(" ").filter((w) => w.length > 3));
  const [smaller, larger] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  if (smaller.size > 0) {
    const overlap = [...smaller].filter((w) => larger.has(w)).length;
    if (overlap / smaller.size >= 0.85) return true;
  }
  return false;
}

// Main check: returns { found: bool, matchedTitle: string|null }
async function checkInLibrary({ doi, title }) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return { found: false, needsAuth: true };

  try {
    const index = await getLibraryIndex(accessToken);

    // 1) DOI match (exact, case-insensitive)
    if (doi) {
      const normDoi = doi.toLowerCase();
      const match = index.find((d) => d.doi && d.doi.toLowerCase() === normDoi);
      if (match) return { found: true, matchedTitle: match.title };
    }

    // 2) Fuzzy title match against cached index
    if (title) {
      const match = index.find((d) => titlesMatch(d.title, title));
      if (match) return { found: true, matchedTitle: match.title };
    }

    return { found: false };
  } catch (e) {
    console.error("[MSC] Mendeley API error:", e);
    return { found: false, error: e.message };
  }
}

// ── Message listener (from content.js / popup.js) ─────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CHECK_ARTICLE") {
    checkInLibrary(msg.payload).then(sendResponse);
    return true; // keep channel open for async
  }

  if (msg.type === "LOGIN") {
    launchOAuth()
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === "LOGOUT") {
    Promise.all([clearTokens(), invalidateLibraryCache()]).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === "GET_AUTH_STATUS") {
    getTokens().then((t) => sendResponse({ loggedIn: !!t }));
    return true;
  }

  if (msg.type === "GET_REDIRECT_URL") {
    sendResponse({ url: REDIRECT_URL });
    return false;
  }
});

// ── Unpaywall: find free legal PDF URL for a DOI ─────────────
// Free API — no key needed, just an email for identification
const UNPAYWALL_EMAIL = "mendeley-scholar-checker@example.com";

async function findFreePdfUrl(doi) {
  if (!doi) return null;
  try {
    const res = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${UNPAYWALL_EMAIL}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // Prefer the best OA location with a PDF URL
    const best = data.best_oa_location;
    return best?.url_for_pdf || best?.url || null;
  } catch {
    return null;
  }
}

// ── Attach a PDF to an existing Mendeley document ────────────
async function attachPdf(documentId, pdfUrl, accessToken) {
  try {
    console.log("[Mendeley] Fetching PDF from:", pdfUrl);
    const pdfRes = await fetch(pdfUrl);
    if (!pdfRes.ok) {
      console.warn("[Mendeley] PDF fetch failed:", pdfRes.status);
      return false;
    }

    const pdfBuffer = await pdfRes.arrayBuffer();

    // Validate magic bytes: every real PDF starts with "%PDF"
    const header = new Uint8Array(pdfBuffer.slice(0, 4));
    const magic  = String.fromCharCode(...header);
    if (magic !== "%PDF") {
      console.warn("[Mendeley] Not a real PDF (magic bytes missing) — skipping attach. Got:", magic);
      return false;
    }

    const filename = pdfUrl.split("/").pop()?.split("?")[0]?.replace(/[^a-zA-Z0-9._-]/g, "_") || "paper.pdf";
    const safeFilename = filename.endsWith(".pdf") ? filename : filename + ".pdf";

    const uploadRes = await fetch(`${MENDELEY_API_BASE}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "Link": `<${MENDELEY_API_BASE}/documents/${documentId}>; rel="document"`,
      },
      body: pdfBuffer,
    });

    if (uploadRes.ok) {
      console.log("[Mendeley] PDF attached successfully:", safeFilename);
      return true;
    } else {
      const err = await uploadRes.text();
      console.warn("[Mendeley] PDF attach failed:", uploadRes.status, err);
      return false;
    }
  } catch (e) {
    console.warn("[Mendeley] PDF attach exception:", e.message);
    return false;
  }
}

// ── Add article to Mendeley library ──────────────────────────
async function addToLibrary({ title, doi, authors, year, journal, url, pdfUrl }) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return { success: false, needsAuth: true };

  const doc = { type: "journal" }; // Mendeley API uses "journal" not "journal_article"
  if (title)   doc.title = title;
  if (doi)     doc.identifiers = { doi };
  if (year)    doc.year = parseInt(year, 10) || undefined;
  if (journal) doc.source = journal;
  if (url)     doc.websites = [url];

  // Parse authors from Scholar's ".gs_a" format: "A Smith, B Jones - Journal, 2009 - Publisher"
  // We only want the author portion BEFORE the first " - "
  if (authors) {
    const authorPart = authors.split(/\s+-\s+/)[0]; // strip "- Journal, Year - Publisher"
    doc.authors = authorPart
      .split(",")
      .map((a) => a.trim()).filter(Boolean)
      .filter((a) => /[A-Za-z]/.test(a) && !/^\d+$/.test(a)) // skip pure numbers
      .map((a) => {
        // Scholar uses "F Last" or "FM Last" initials format
        const parts = a.split(/\s+/);
        if (parts.length === 1) return { last_name: parts[0] };
        return { first_name: parts.slice(0, -1).join(" "), last_name: parts[parts.length - 1] };
      });
  }

  try {
    const res = await fetch(`${MENDELEY_API_BASE}/documents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/vnd.mendeley-document.1+json",
        Accept: "application/vnd.mendeley-document.1+json",
      },
      body: JSON.stringify(doc),
    });

    if (res.ok) {
      const created = await res.json();
      console.log("[Mendeley] Added successfully:", created.title);

      // Try to attach PDF: Unpaywall (via DOI) first, then Scholar direct link
      let pdfAttached = false;
      const freePdfUrl = (doi ? await findFreePdfUrl(doi) : null) || pdfUrl || null;
      if (freePdfUrl) {
        console.log("[Mendeley] Trying PDF from:", freePdfUrl);
        pdfAttached = await attachPdf(created.id, freePdfUrl, accessToken);
      } else {
        console.log("[Mendeley] No free PDF found for this paper");
      }

      // Invalidate cache so the new paper is picked up on the next check
      await invalidateLibraryCache();
      return { success: true, id: created.id, title: created.title, pdfAttached };
    } else {
      const errText = await res.text();
      console.error("[Mendeley] Add failed:", res.status, errText);
      console.error("[Mendeley] Payload sent:", JSON.stringify(doc, null, 2));
      return { success: false, error: `${res.status}: ${errText}` };
    }
  } catch (e) {
    console.error("[Mendeley] Add exception:", e);
    return { success: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ADD_ARTICLE") {
    addToLibrary(msg.payload).then(sendResponse);
    return true;
  }
});
