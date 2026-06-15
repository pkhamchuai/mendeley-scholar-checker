// ============================================================
// content.js — Scrapes Google Scholar & injects Mendeley badges
// ============================================================

const BADGE_ATTR = "data-mendeley-checked";

// ── Extract DOI ───────────────────────────────────────────────
function extractDOI(el) {
  const links = el.querySelectorAll("a[href]");
  for (const link of links) {
    const href = link.href || "";
    // Require explicit doi.org/ prefix to avoid false positives (e.g. PDF URLs with DOI-like paths)
    const doiMatch = href.match(/doi\.org\/(10\.\d{4,}\/[^\s&"'>]+)/i);
    if (doiMatch) {
      let doi = decodeURIComponent(doiMatch[1]);
      // Strip trailing file-type path segments added by some publishers
      doi = doi.replace(/\/(pdf|html|htm|xml|full|abstract|meta|references?)$/i, "");
      doi = doi.replace(/\.(pdf|html|htm|xml)$/i, "");
      return doi;
    }
  }
  const text = el.innerText || "";
  const textMatch = text.match(/\bdoi[:\s]+?(10\.\d{4,}\/\S+)/i);
  if (textMatch) return textMatch[1].replace(/\.(pdf|html|htm|xml)$/i, "");
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

// ── Extract free PDF URL from Scholar result ──────────────────
// Scholar shows a [PDF] badge on the right side of some results (.gs_or_ggsm)
// Only return URLs from sources likely to be freely accessible
const FREE_PDF_HOSTS = [
  "arxiv.org",
  "semanticscholar.org",
  "europepmc.org",
  "ncbi.nlm.nih.gov",
  "biorxiv.org",
  "medrxiv.org",
  "plos",
  "peerj.com",
  "mdpi.com",
  "frontiersin.org",
  "hal.science",
  "hal.archives-ouvertes.fr",
  "core.ac.uk",
  "unpaywall.org",
  "openreview.net",
  "openaccess.thecvf.com",  // CVPR, ICCV, ECCV — free
  "ecva.net",               // ECCV
  "aclanthology.org",       // NLP papers
  "aaai.org/ojs",           // AAAI open access
  "jmlr.org",               // JMLR
  "proceedings.mlr.press",  // ICML, AISTATS
  "researchgate.net/profile", // direct PDF links sometimes work
];

function extractPDFUrl(el) {
  // Scholar puts the [PDF] link in .gs_or_ggsm or .gs_ggs
  const pdfLink =
    el.querySelector(".gs_or_ggsm a[href]") ||
    el.querySelector(".gs_ggs a[href]");

  if (!pdfLink) return null;
  const href = pdfLink.href || "";

  // Only use if it ends in .pdf or is from a known free host
  const isFreeHost = FREE_PDF_HOSTS.some((h) => href.includes(h));
  const isPdfLink  = href.toLowerCase().includes(".pdf");

  if (isFreeHost || isPdfLink) return href;
  return null;
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
    if (result.pdfAttached) {
      foundBadge.querySelector(".msc-label").textContent = "In Mendeley + PDF";
      foundBadge.title = `Added with PDF: "${result.title || articleData.title}"`;
    } else {
      foundBadge.title = `Added (metadata only): "${result.title || articleData.title}"`;
    }
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
  const url    = extractURL(el);
  const pdfUrl = extractPDFUrl(el);
  const articleData = { title, doi, authors, year, journal, url, pdfUrl };

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
    if (articleData.pdfUrl) {
      finalBadge.title = "Click to add to Mendeley (PDF found — will try to attach)";
      finalBadge.querySelector(".msc-label").textContent = "Add to Mendeley + PDF";
    } else {
      finalBadge.title = "Click to add this paper to your Mendeley library (metadata only)";
    }
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
