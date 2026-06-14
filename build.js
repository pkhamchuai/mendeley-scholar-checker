// build.js — reads .env and generates dist/ with credentials injected
// Run: node build.js
// Output: dist/ folder → load THAT folder as your Chrome extension

const fs   = require("fs");
const path = require("path");

// ── Load .env ─────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    console.error("❌  .env file not found. Copy .env.example → .env and fill in your credentials.");
    process.exit(1);
  }

  const env = {};
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const [key, ...rest] = trimmed.split("=");
      env[key.trim()] = rest.join("=").trim();
    });

  const id     = env.MENDELEY_CLIENT_ID;
  const secret = env.MENDELEY_CLIENT_SECRET;
  const extKey = env.EXTENSION_KEY;

  if (!id || id === "your_client_id_here") {
    console.error("❌  MENDELEY_CLIENT_ID is not set in .env");
    process.exit(1);
  }
  if (!secret || secret === "your_client_secret_here") {
    console.error("❌  MENDELEY_CLIENT_SECRET is not set in .env");
    process.exit(1);
  }
  if (!extKey || extKey === "your_extension_key_here") {
    console.warn("⚠️   EXTENSION_KEY is not set — Extension ID may change on reload.");
    console.warn("    Run: python3 get_key.py <your-extension-id>  to generate it.");
  }

  return { id, secret, extKey };
}

// ── Copy files to dist/ ───────────────────────────────────────
function buildDist({ id, secret, extKey }) {
  const srcDir  = __dirname;
  const distDir = path.join(__dirname, "dist");

  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);

  // Files to copy as-is
  const staticFiles = ["content.js", "styles.css", "popup.html", "popup.js"];
  staticFiles.forEach((file) => {
    fs.copyFileSync(path.join(srcDir, file), path.join(distDir, file));
  });

  // Copy icons/
  const iconsSrc  = path.join(srcDir,  "icons");
  const iconsDist = path.join(distDir, "icons");
  if (!fs.existsSync(iconsDist)) fs.mkdirSync(iconsDist);
  fs.readdirSync(iconsSrc).forEach((f) => {
    fs.copyFileSync(path.join(iconsSrc, f), path.join(iconsDist, f));
  });

  // Inject credentials into background.js
  let bg = fs.readFileSync(path.join(srcDir, "background.js"), "utf8");
  bg = bg
    .replace("YOUR_CLIENT_ID_HERE",     id)
    .replace("YOUR_CLIENT_SECRET_HERE", secret);
  fs.writeFileSync(path.join(distDir, "background.js"), bg, "utf8");

  // Inject key into manifest.json
  let manifest = fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8");
  if (extKey && extKey !== "your_extension_key_here") {
    manifest = manifest.replace("PASTE_YOUR_KEY_HERE", extKey);
    // Remove the __IMPORTANT__ comment field (not valid JSON with it in production)
    manifest = manifest.replace(/\s*"__IMPORTANT__":\s*"[^"]*",?\n?/g, "\n");
  } else {
    // No key — remove the key field entirely so Chrome assigns one dynamically
    manifest = manifest.replace(/\s*"__IMPORTANT__":\s*"[^"]*",?\n?/g, "\n");
    manifest = manifest.replace(/\s*"key":\s*"PASTE_YOUR_KEY_HERE",?\n?/g, "\n");
  }
  fs.writeFileSync(path.join(distDir, "manifest.json"), manifest, "utf8");

  console.log("\n✅  Build complete → dist/");
  console.log("    Load the dist/ folder in chrome://extensions/\n");

  if (!extKey || extKey === "your_extension_key_here") {
    console.log("💡  Tip: After loading, run  python3 get_key.py <your-extension-id>");
    console.log("    Add EXTENSION_KEY to .env, then rebuild to pin the Extension ID.\n");
  }
}

// ── Run ───────────────────────────────────────────────────────
const credentials = loadEnv();
buildDist(credentials);
