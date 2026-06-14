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
// Search by DOI (exact match)
async function searchByDOI(doi, accessToken) {
  const url = `${MENDELEY_API_BASE}/documents?doi=${encodeURIComponent(doi)}&limit=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.mendeley-document.1+json",
    },
  });
  if (!res.ok) return [];
  return res.json();
}

// Search by title (partial/fuzzy match)
async function searchByTitle(title, accessToken) {
  // Mendeley API: search your library with title keyword
  const url = `${MENDELEY_API_BASE}/documents?title=${encodeURIComponent(title)}&limit=5`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.mendeley-document.1+json",
    },
  });
  if (!res.ok) return [];
  return res.json();
}

// Normalize title for fuzzy comparison
function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function titlesMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  // Substring match (Scholar sometimes truncates with "…")
  if (na.length > 20 && nb.startsWith(na.slice(0, Math.floor(na.length * 0.85)))) return true;
  if (nb.length > 20 && na.startsWith(nb.slice(0, Math.floor(nb.length * 0.85)))) return true;
  return false;
}

// Main check: returns { found: bool, title: string|null }
async function checkInLibrary({ doi, title }) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return { found: false, needsAuth: true };

  try {
    // 1) DOI check (most reliable)
    if (doi) {
      const results = await searchByDOI(doi, accessToken);
      if (results.length > 0) return { found: true, matchedTitle: results[0].title };
    }

    // 2) Title search fallback
    if (title) {
      const results = await searchByTitle(title, accessToken);
      const match = results.find((doc) => titlesMatch(doc.title || "", title));
      if (match) return { found: true, matchedTitle: match.title };
    }

    return { found: false };
  } catch (e) {
    console.error("Mendeley API error:", e);
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
    clearTokens().then(() => sendResponse({ success: true }));
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

// ── Add article to Mendeley library ──────────────────────────
async function addToLibrary({ title, doi, authors, year, journal, url }) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return { success: false, needsAuth: true };

  const doc = { type: "journal_article" };
  if (title)   doc.title = title;
  if (doi)     doc.identifiers = { doi };
  if (year)    doc.year = parseInt(year, 10) || undefined;
  if (journal) doc.source = journal;
  if (url)     doc.websites = [url];

  // Parse "First Last" style author strings
  if (authors) {
    doc.authors = authors
      .split(/,\s*(?=[A-Z])|\s+and\s+/i)
      .map((a) => a.trim()).filter(Boolean)
      .map((a) => {
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
      return { success: true, id: created.id, title: created.title };
    } else {
      const errText = await res.text();
      return { success: false, error: `${res.status}: ${errText}` };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ADD_ARTICLE") {
    addToLibrary(msg.payload).then(sendResponse);
    return true;
  }
});
