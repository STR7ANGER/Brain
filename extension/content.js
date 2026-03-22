const STORAGE_KEYS = {
  apiBaseUrl: "apiBaseUrl",
  apiKey: "apiKey",
  project: "project",
};

function createButton() {
  const btn = document.createElement("button");
  btn.id = "save-to-brain-button";
  btn.textContent = "Save to Brain";
  return btn;
}

function createContainer() {
  const container = document.createElement("div");
  container.id = "save-to-brain-container";
  return container;
}

function createToast() {
  const toast = document.createElement("div");
  toast.id = "save-to-brain-toast";
  toast.style.display = "none";
  return toast;
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(Object.values(STORAGE_KEYS), (items) => {
      resolve({
        apiBaseUrl: items.apiBaseUrl || "",
        apiKey: items.apiKey || "",
        project: items.project || "",
      });
    });
  });
}

function extractMessages() {
  const nodes = document.querySelectorAll("div[data-message-author-role]");
  const messages = [];
  nodes.forEach((node) => {
    const role = node.getAttribute("data-message-author-role") || "user";
    const textNode = node.querySelector(".markdown") || node;
    const content = (textNode.innerText || "").trim();
    if (content) {
      messages.push({ role, content });
    }
  });
  return messages;
}

function showToast(container, html, success = true) {
  const toast = container.querySelector("#save-to-brain-toast");
  if (!toast) return;
  toast.innerHTML = html;
  toast.classList.toggle("success", success);
  toast.classList.toggle("error", !success);
  toast.style.display = "block";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.display = "none";
  }, 8000);
}

async function handleSaveClick(container, button) {
  button.disabled = true;
  button.textContent = "Saving...";
  try {
    const settings = await getSettings();
    if (!settings.apiBaseUrl || !settings.apiKey) {
      showToast(
        container,
        "Missing API base URL or API key. Set them in extension options.",
        false
      );
      return;
    }

    const messages = extractMessages();
    if (messages.length === 0) {
      showToast(container, "No messages found on the page.", false);
      return;
    }

    const baseUrl = settings.apiBaseUrl.replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/save-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ project: settings.project || undefined, messages }),
    });

    if (!res.ok) {
      const errText = await res.text();
      showToast(container, `Save failed: ${errText}`, false);
      return;
    }

    const data = await res.json();
    const curlCmd =
      data.curl ||
      `curl -H \"Authorization: Bearer ${settings.apiKey}\" ${baseUrl}/brain/${data.brainId}/context`;
    const html = `
      <div><strong>Saved to Brain</strong></div>
      <div>brain/${data.brainId}</div>
      <div class="save-to-brain-actions">
        <button id="save-to-brain-copy">Copy cURL</button>
        <button id="save-to-brain-copy-prompt">Copy Prompt</button>
      </div>
    `;
    showToast(container, html, true);

    const copyBtn = container.querySelector("#save-to-brain-copy");
    if (copyBtn) {
      copyBtn.onclick = async () => {
        await navigator.clipboard.writeText(curlCmd);
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy cURL"), 2000);
      };
    }

    const copyPromptBtn = container.querySelector("#save-to-brain-copy-prompt");
    if (copyPromptBtn) {
      copyPromptBtn.onclick = async () => {
        copyPromptBtn.textContent = "Fetching...";
        try {
          const promptRes = await fetch(`${baseUrl}/brain/${data.brainId}/context`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${settings.apiKey}`,
            },
          });
          if (!promptRes.ok) {
            const errText = await promptRes.text();
            throw new Error(errText);
          }
          const promptText = await promptRes.text();
          await navigator.clipboard.writeText(promptText);
          copyPromptBtn.textContent = "Copied";
          setTimeout(() => (copyPromptBtn.textContent = "Copy Prompt"), 2000);
        } catch (err) {
          copyPromptBtn.textContent = "Copy Prompt";
          showToast(container, `Copy prompt failed: ${err.message}`, false);
        }
      };
    }
  } catch (err) {
    showToast(container, `Save failed: ${err.message}`, false);
  } finally {
    button.disabled = false;
    button.textContent = "Save to Brain";
  }
}

function injectUI() {
  if (document.getElementById("save-to-brain-container")) return;
  const container = createContainer();
  const button = createButton();
  const toast = createToast();

  button.addEventListener("click", () => handleSaveClick(container, button));

  container.appendChild(button);
  container.appendChild(toast);
  document.body.appendChild(container);
}

injectUI();

const observer = new MutationObserver(() => {
  if (!document.getElementById("save-to-brain-container")) {
    injectUI();
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });
