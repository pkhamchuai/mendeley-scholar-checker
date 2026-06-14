// ============================================================
// content.js — Scrapes Google Scholar & injects Mendeley badges
// ============================================================

const BADGE_ATTR = "data-mendeley-checked";

// ── Extract DOI ───────────────────────────────────────────────
function extractDOI(el) {
  const links = el.querySelectorAll("a[href]");
  for (const link of links) {
    const href = link.href || "";
    const doiMatch = href.match(/(?:doi\.org\/|\/doi\/)?(10\.\d{4,}\/[^\s&"'>]+)/i);
    if (doiMatch) return decodeURIComponent(doiMatch[1]);
  }
  const text = el.innerText || "";
  const textMatch = text.match(/\bdoi[:\s]+?(10\.\d{4,}\/\S+)/i);
  if (textMatch) return textMatch[1];
  return null;
}

// ── Extract title ─────────────────────────────────────────────
function extractTitle(el) {
  const titleEl =
    el.querySelector("h3.gs_rt a") ||
    el.querySelector(".gs_rt a") ||
    el.querySelector("h3 a");
  if (titleEl) return titleEl.textContent.replace(/^\[.*?\]\s*/, "").trim();
  const h3 = el.querySelector("h3");
  if (h3) return h3.textContent.trim();
  return null;
}

// ── Extract authors, year, journal from .gs_a line ───────────
function extractMeta(el) {
  const metaEl = el.querySelector(".gs_a");
  if (!metaEl) return {};
  const text = metaEl.textContent;

  // Format: "Author1, Author2 - Journal, Year - Publisher"
  const parts = text.split(" - ");
  const authors = parts[0]?.trim() || null;
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;
  const journal = parts[1]?.replace(/,\s*\d{4}.*/, "").trim() || null;

  return { authors, year, journal };
}

// ── Extract article URL ───────────────────────────────────────
function extractURL(el) {
  const titleLink = el.querySelector("h3.gs_rt a, .gs_rt a, h3 a");
  return titleLink?.href || null;
}

// ── Create badge element ──────────────────────────────────────
function makeBadge(state) {
  const badge = document.createElement("span");
  badge.className = `msc-badge msc-badge--${state}`;

  const icons  = { found: "✓", notfound: "+", loading: "…", adding: "…", error: "?" };
  const labels = {
    found:    "In Mendeley",
    notfound: "Add to Mendeley",
    loading:  "Checking…",
    adding:   "Adding…",
    error:    "Error",
  };

  badge.innerHTML = `<span class="msc-icon">${icons[state]}</span><span class="msc-label">${labels[state]}</span>`;
  return badge;
}

// ── Handle click on "+ Add to Mendeley" badge ────────────────
async function handleAddClick(badge, cardEl, articleData) {
  // Prevent double-click
  if (badge.dataset.adding === "true") return;
  badge.dataset.adding = "true";

  // Show adding state
  const addingBadge = makeBadge("adding");
  badge.replaceWith(addingBadge);

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: "ADD_ARTICLE",
      payload: articleData,
    });
  } catch {
    result = { success: false, error: "Extension disconnected" };
  }

  if (result?.success) {
    // Flip to "In Mendeley" ✓
    const foundBadge = makeBadge("found");
    foundBadge.title = `Added: "${result.title || articleData.title}"`;
    cardEl.setAttribute(BADGE_ATTR, "found");
    addingBadge.replaceWith(foundBadge);
  } else if (result?.needsAuth) {
    const errBadge = makeBadge("error");
    errBadge.querySelector(".msc-label").textContent = "Login required";
    errBadge.title = "Click the extension icon to reconnect";
    addingBadge.replaceWith(errBadge);
  } else {
    const errBadge = makeBadge("error");
    errBadge.querySelector(".msc-label").textContent = "Add failed";
    errBadge.title = result?.error || "Unknown error";
    // Let them retry
    errBadge.style.cursor = "pointer";
    errBadge.addEventListener("click", () => handleAddClick(errBadge, cardEl, articleData));
    addingBadge.replaceWith(errBadge);
  }
}

// ── Process a single Scholar result card ─────────────────────
async function processResult(el) {
  if (el.hasAttribute(BADGE_ATTR)) return;
  el.setAttribute(BADGE_ATTR, "pending");

  const title   = extractTitle(el);
  const doi     = extractDOI(el);
  if (!title && !doi) return;

  const { authors, year, journal } = extractMeta(el);
  const url = extractURL(el);
  const articleData = { title, doi, authors, year, journal, url };

  const targetEl =
    el.querySelector(".gs_fl") ||
    el.querySelector(".gs_a")  ||
    el.querySelector("h3");
  if (!targetEl) return;

  const loadingBadge = makeBadge("loading");
  targetEl.insertAdjacentElement("afterend", loadingBadge);

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: "CHECK_ARTICLE",
      payload: { doi, title },
    });
  } catch {
    result = { error: "Extension disconnected" };
  }

  let finalBadge;

  if (result?.needsAuth) {
    finalBadge = makeBadge("error");
    finalBadge.querySelector(".msc-label").textContent = "Login required";
    finalBadge.title = "Click the extension icon to login";

  } else if (result?.found) {
    finalBadge = makeBadge("found");
    finalBadge.title = `Matched: "${result.matchedTitle}"`;
    el.setAttribute(BADGE_ATTR, "found");

  } else {
    // Not in library — make it clickable
    finalBadge = makeBadge("notfound");
    finalBadge.style.cursor = "pointer";
    finalBadge.title = "Click to add this paper to your Mendeley library";
    finalBadge.addEventListener("click", () => handleAddClick(finalBadge, el, articleData));
    el.setAttribute(BADGE_ATTR, "notfound");
  }

  loadingBadge.replaceWith(finalBadge);
}

// ── Scan all visible results ──────────────────────────────────
function scanResults() {
  document.querySelectorAll(".gs_r.gs_or").forEach(processResult);
}

// ── Watch for dynamic content (pagination, etc.) ──────────────
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.addedNodes.length) { scanResults(); break; }
  }
});

// ── Init ──────────────────────────────────────────────────────
function init() {
  if (!window.location.href.includes("scholar.google.com")) return;
  scanResults();
  observer.observe(document.body, { childList: true, subtree: true });
}

init();
