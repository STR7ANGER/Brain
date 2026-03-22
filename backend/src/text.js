function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function cleanMessages(messages) {
  return messages
    .filter((m) => m && typeof m.content === "string")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: normalizeWhitespace(m.content),
    }))
    .filter((m) => m.content.length > 0);
}

module.exports = { cleanMessages };
