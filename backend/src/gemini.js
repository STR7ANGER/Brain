const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-004";

function requireKey() {
  if (!GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY not configured");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(prompt, options = {}) {
  requireKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
    },
  };
  if (options.responseMimeType) {
    body.generationConfig.responseMimeType = options.responseMimeType;
  }

  const retries = Number.isInteger(options.retries) ? options.retries : 2;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p.text || "").join("");
      return text;
    }

    const text = await res.text();
    lastError = new Error(`Gemini error ${res.status}: ${text}`);
    if (res.status === 503 || res.status === 429) {
      const delay = 500 * Math.pow(2, attempt);
      await sleep(delay);
      continue;
    }
    break;
  }

  throw lastError || new Error("Gemini error");
}

async function embedText(text) {
  requireKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GOOGLE_API_KEY}`;
  const body = {
    content: {
      parts: [{ text }],
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Embedding error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const values = json?.embedding?.values;
  if (!Array.isArray(values)) {
    throw new Error("Embedding response missing values");
  }
  return values;
}

module.exports = { callGemini, embedText };
