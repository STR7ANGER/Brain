const STORAGE_KEYS = {
  apiBaseUrl: "apiBaseUrl",
  authToken: "authToken",
  userEmail: "userEmail",
  pendingEmail: "pendingEmail",
  otpRequested: "otpRequested",
};

const subtitle = document.getElementById("subtitle");
const settingsWarning = document.getElementById("settings-warning");
const openSettingsBtn = document.getElementById("open-settings");
const authView = document.getElementById("auth-view");
const historyView = document.getElementById("history-view");
const emailInput = document.getElementById("email");
const otpSection = document.getElementById("otp-section");
const otpInput = document.getElementById("otp");
const sendOtpBtn = document.getElementById("send-otp");
const verifyOtpBtn = document.getElementById("verify-otp");
const status = document.getElementById("status");
const userEmailLabel = document.getElementById("user-email");
const refreshHistoryBtn = document.getElementById("refresh-history");
const historyList = document.getElementById("history-list");
const logoutBtn = document.getElementById("logout");

function setStatus(message, isError = false) {
  status.textContent = message;
  status.className = isError ? "status error" : "status";
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(Object.values(STORAGE_KEYS), (items) => {
      resolve({
        apiBaseUrl: items.apiBaseUrl || "",
        authToken: items.authToken || "",
        userEmail: items.userEmail || "",
        pendingEmail: items.pendingEmail || "",
        otpRequested: items.otpRequested || false,
      });
    });
  });
}

function setSettings(values) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(values, () => resolve());
  });
}

function formatExpires(seconds) {
  if (!seconds || seconds <= 0) return "expired";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function showAuth() {
  authView.style.display = "block";
  historyView.style.display = "none";
  subtitle.textContent = "Sign in to continue.";
}

function showHistory(email) {
  authView.style.display = "none";
  historyView.style.display = "block";
  userEmailLabel.textContent = email;
  subtitle.textContent = "Your recent sessions.";
}

async function fetchHistory(baseUrl, token) {
  historyList.innerHTML = "";
  setStatus("Loading history...");
  const res = await fetch(`${baseUrl}/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to load history");
  }
  const data = await res.json();
  const items = data.items || [];
  if (items.length === 0) {
    historyList.innerHTML = "<div class=\"history-item\">No sessions yet.</div>";
    setStatus("");
    return;
  }

  for (const item of items) {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `
      <div class="history-title">${item.project || "untitled"}</div>
      <div class="history-meta">Expires in ${formatExpires(item.expiresIn)}</div>
      <div class="history-actions">
        <button data-action="copy-url" data-url="${item.url}">Copy URL</button>
      </div>
    `;
    historyList.appendChild(div);
  }
  setStatus("");
}

async function init() {
  const settings = await getSettings();
  const baseUrl = settings.apiBaseUrl.replace(/\/$/, "");

  if (!baseUrl) {
    settingsWarning.style.display = "block";
  }

  if (!settings.authToken) {
    showAuth();
    if (settings.pendingEmail) {
      emailInput.value = settings.pendingEmail;
    }
    if (settings.otpRequested || otpInput.value) {
      otpSection.style.display = "block";
    }
    updateAuthButtons();
  } else {
    showHistory(settings.userEmail || "");
    if (baseUrl) {
      try {
        await fetchHistory(baseUrl, settings.authToken);
      } catch (err) {
        setStatus("Session expired. Please log in again.", true);
        await setSettings({ authToken: "", userEmail: "" });
        showAuth();
      }
    }
  }

  openSettingsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  emailInput.addEventListener("input", async () => {
    await setSettings({ pendingEmail: emailInput.value.trim() });
    updateAuthButtons();
  });

  otpInput.addEventListener("input", () => {
    updateAuthButtons();
  });

  sendOtpBtn.addEventListener("click", async () => {
    try {
      if (!baseUrl) {
        setStatus("Set API Base URL in settings.", true);
        return;
      }
      const email = emailInput.value.trim();
      if (!email) {
        setStatus("Enter your email.", true);
        return;
      }
      setStatus("Sending OTP...");
      const res = await fetch(`${baseUrl}/auth/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to send OTP");
      }
      otpSection.style.display = "block";
      await setSettings({ pendingEmail: email, otpRequested: true });
      updateAuthButtons();
      setStatus("OTP sent. Check your email.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  verifyOtpBtn.addEventListener("click", async () => {
    try {
      if (!baseUrl) {
        setStatus("Set API Base URL in settings.", true);
        return;
      }
      const email = emailInput.value.trim();
      const code = otpInput.value.trim();
      if (!email || !code) {
        setStatus("Enter email and OTP.", true);
        return;
      }
      setStatus("Verifying...");
      const res = await fetch(`${baseUrl}/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "OTP verification failed");
      }
      const data = await res.json();
      await setSettings({ authToken: data.token, userEmail: data.email });
      showHistory(data.email);
      await fetchHistory(baseUrl, data.token);
      await setSettings({ pendingEmail: "", otpRequested: false });
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  refreshHistoryBtn.addEventListener("click", async () => {
    try {
      const latest = await getSettings();
      if (!latest.authToken) {
        showAuth();
        return;
      }
      await fetchHistory(baseUrl, latest.authToken);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  logoutBtn.addEventListener("click", async () => {
    await setSettings({ authToken: "", userEmail: "", pendingEmail: "", otpRequested: false });
    showAuth();
    setStatus("Logged out.");
  });

  historyList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    if (!action) return;

    const latest = await getSettings();
    const token = latest.authToken;
    if (!token) {
      setStatus("Please log in again.", true);
      return;
    }

    if (action === "copy-url") {
      const url = target.dataset.url;
      if (!url) return;
      await navigator.clipboard.writeText(url);
      setStatus("URL copied.");
    }
  });
}

function updateAuthButtons() {
  const email = emailInput.value.trim();
  const otp = otpInput.value.trim();
  sendOtpBtn.disabled = email.length === 0;
  verifyOtpBtn.disabled = email.length === 0 || otp.length === 0;
}

init();
