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
