// popup.js — handles login/logout UI

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const loggedOutView = document.getElementById("loggedOutView");
const loggedInView = document.getElementById("loggedInView");
const loginBtn = document.getElementById("loginBtn");
const loginLabel = document.getElementById("loginLabel");
const loginSpinner = document.getElementById("loginSpinner");
const logoutBtn = document.getElementById("logoutBtn");
const redirectUrlEl = document.getElementById("redirectUrl");

// Show redirect URL for Mendeley app registration
chrome.runtime.sendMessage({ type: "GET_REDIRECT_URL" }, (res) => {
  if (res?.url) {
    redirectUrlEl.textContent = res.url;
    redirectUrlEl.addEventListener("click", () => {
      navigator.clipboard.writeText(res.url).then(() => {
        redirectUrlEl.textContent = "Copied!";
        setTimeout(() => (redirectUrlEl.textContent = res.url), 1500);
      });
    });
  }
});

// Check login status on open
chrome.runtime.sendMessage({ type: "GET_AUTH_STATUS" }, (res) => {
  setAuthState(res?.loggedIn ?? false);
});

function setAuthState(loggedIn) {
  if (loggedIn) {
    statusDot.className = "status-dot connected";
    statusText.textContent = "Connected to Mendeley";
    loggedInView.classList.remove("hidden");
    loggedOutView.classList.add("hidden");
  } else {
    statusDot.className = "status-dot disconnected";
    statusText.textContent = "Not connected";
    loggedOutView.classList.remove("hidden");
    loggedInView.classList.add("hidden");
  }
}

// Login
loginBtn.addEventListener("click", () => {
  loginLabel.textContent = "Connecting...";
  loginSpinner.classList.remove("hidden");
  loginBtn.disabled = true;

  chrome.runtime.sendMessage({ type: "LOGIN" }, (res) => {
    loginSpinner.classList.add("hidden");
    loginBtn.disabled = false;
    if (res?.success) {
      setAuthState(true);
    } else {
      loginLabel.textContent = "Connect Mendeley";
      statusText.textContent = "Login failed — try again";
      statusDot.className = "status-dot disconnected";
      alert("Login error: " + (res?.error || "Unknown error"));
    }
  });
});

// Logout
logoutBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "LOGOUT" }, () => {
    setAuthState(false);
  });
});
