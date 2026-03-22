const { callGemini } = require("./gemini");

function buildPrompt({ project, messages }) {
  const header = project ? `Project: ${project}` : "Project: untitled";
  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  return [
    "You are a meticulous assistant that extracts concise knowledge units.",
    "Return ONLY valid JSON array (no markdown, no commentary).",
    "Each element must be an object with keys: type and content.",
    "type must be one of: idea, decision, task, tech, other.",
    "content must be a short, standalone bullet (max ~140 chars) with no leading dash.",
    "Do not include duplicates or trivial filler.",
    "If you are unsure, return an empty JSON array [].",
    header,
    "Conversation:",
    transcript,
  ].join("\n");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (innerErr) {
        return null;
      }
    }
    return null;
  }
}

function stripCodeFences(text) {
  return text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
}

function classifySentence(sentence) {
  const s = sentence.toLowerCase();
  if (/(decide|decision|we will|we'll|choose|selected)/.test(s)) return "decision";
  if (/(todo|to do|need to|must|fix|implement|build|add|create)/.test(s)) return "task";
  if (/(use|stack|tech|database|db|api|framework|library|postgres|pgvector)/.test(s))
    return "tech";
  if (/(idea|concept|goal|vision|plan)/.test(s)) return "idea";
  return "other";
}

function heuristicChunks(messages) {
  const seen = new Set();
  const chunks = [];
  for (const msg of messages) {
    const sentences = msg.content
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 12 && s.length <= 200);
    for (const sentence of sentences) {
      const normalized = sentence.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      chunks.push({
        type: classifySentence(sentence),
        content: sentence.replace(/^[-*]\s+/, ""),
      });
    }
  }
  return chunks.slice(0, 30);
}

async function chunkWithGemini({ project, messages }) {
  const prompt = buildPrompt({ project, messages });
  let responseText = "";
  try {
    responseText = await callGemini(prompt, {
      responseMimeType: "application/json",
      retries: 2,
    });
  } catch (err) {
    const fallback = heuristicChunks(messages);
    if (fallback.length === 0) {
      throw err;
    }
    return fallback;
  }
  const parsed = safeJsonParse(stripCodeFences(responseText));
  if (!Array.isArray(parsed)) {
    const retryPrompt = [
      "Return ONLY a JSON array. No markdown. No prose.",
      "Each element: {\"type\":\"idea|decision|task|tech|other\",\"content\":\"...\"}",
      "If you cannot comply, return []",
      "",
      prompt,
    ].join("\n");
    let retryText = "";
    try {
      retryText = await callGemini(retryPrompt, {
        responseMimeType: "application/json",
        retries: 2,
      });
    } catch (err) {
      const fallback = heuristicChunks(messages);
      if (fallback.length === 0) {
        throw err;
      }
      return fallback;
    }
    const retryParsed = safeJsonParse(stripCodeFences(retryText));
    if (!Array.isArray(retryParsed)) {
      const fallback = heuristicChunks(messages);
      if (fallback.length === 0) {
        throw new Error("Gemini did not return a JSON array");
      }
      return fallback;
    }
    return retryParsed
      .filter((item) => item && typeof item.content === "string")
      .map((item) => ({
        type: ["idea", "decision", "task", "tech", "other"].includes(item.type)
          ? item.type
          : "other",
        content: item.content.trim(),
      }))
      .filter((item) => item.content.length > 0);
  }
  return parsed
    .filter((item) => item && typeof item.content === "string")
    .map((item) => ({
      type: ["idea", "decision", "task", "tech", "other"].includes(item.type)
        ? item.type
        : "other",
      content: item.content.trim(),
    }))
    .filter((item) => item.content.length > 0);
}

module.exports = { chunkWithGemini };
