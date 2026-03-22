const STORAGE_KEYS = {
  apiBaseUrl: "apiBaseUrl",
};

const apiBaseUrlInput = document.getElementById("apiBaseUrl");
const saveButton = document.getElementById("save");
const status = document.getElementById("status");

function loadSettings() {
  chrome.storage.sync.get(Object.values(STORAGE_KEYS), (items) => {
    apiBaseUrlInput.value = items.apiBaseUrl || "";
  });
}

function showStatus(message, success = true) {
  status.textContent = message;
  status.className = success ? "success" : "error";
  setTimeout(() => {
    status.textContent = "";
  }, 3000);
}

saveButton.addEventListener("click", () => {
  const apiBaseUrl = apiBaseUrlInput.value.trim();

  chrome.storage.sync.set(
    {
      [STORAGE_KEYS.apiBaseUrl]: apiBaseUrl,
    },
    () => {
      showStatus("Settings saved");
    }
  );
});

loadSettings();
