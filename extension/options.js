const STORAGE_KEYS = {
  apiBaseUrl: "apiBaseUrl",
  apiKey: "apiKey",
  project: "project",
};

const apiBaseUrlInput = document.getElementById("apiBaseUrl");
const apiKeyInput = document.getElementById("apiKey");
const projectInput = document.getElementById("project");
const saveButton = document.getElementById("save");
const status = document.getElementById("status");

function loadSettings() {
  chrome.storage.sync.get(Object.values(STORAGE_KEYS), (items) => {
    apiBaseUrlInput.value = items.apiBaseUrl || "";
    apiKeyInput.value = items.apiKey || "";
    projectInput.value = items.project || "";
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
  const apiKey = apiKeyInput.value.trim();
  const project = projectInput.value.trim();

  chrome.storage.sync.set(
    {
      [STORAGE_KEYS.apiBaseUrl]: apiBaseUrl,
      [STORAGE_KEYS.apiKey]: apiKey,
      [STORAGE_KEYS.project]: project,
    },
    () => {
      showStatus("Settings saved");
    }
  );
});

loadSettings();
