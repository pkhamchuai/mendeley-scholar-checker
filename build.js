// build.js — reads .env and generates dist/background.js with credentials injected
// Run: node build.js
// Output: dist/ folder → load THAT folder as your Chrome extension

const fs = require("fs");
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

  if (!id || id === "your_client_id_here") {
    console.error("❌  MENDELEY_CLIENT_ID is not set in .env");
    process.exit(1);
  }
  if (!secret || secret === "your_client_secret_here") {
    console.error("❌  MENDELEY_CLIENT_SECRET is not set in .env");
    process.exit(1);
  }

  return { id, secret };
}

// ── Copy files to dist/ ───────────────────────────────────────
function buildDist({ id, secret }) {
  const srcDir  = __dirname;
  const distDir = path.join(__dirname, "dist");

  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);

  // Files to copy as-is
  const staticFiles = [
    "manifest.json",
    "content.js",
    "styles.css",
    "popup.html",
    "popup.js",
  ];

  staticFiles.forEach((file) => {
    fs.copyFileSync(path.join(srcDir, file), path.join(distDir, file));
  });

  // Copy icons folder
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

  console.log("✅  Build complete → dist/");
  console.log("    Load the dist/ folder in chrome://extensions/");
}

// ── Run ───────────────────────────────────────────────────────
const credentials = loadEnv();
buildDist(credentials);
