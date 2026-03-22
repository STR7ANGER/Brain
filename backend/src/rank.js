const PRIORITY = {
  decision: 5,
  task: 4,
  tech: 3,
  idea: 2,
  other: 1,
};

function rankChunks(chunks) {
  return [...chunks].sort((a, b) => {
    const pa = PRIORITY[a.type] || 0;
    const pb = PRIORITY[b.type] || 0;
    if (pb !== pa) return pb - pa;
    const da = new Date(a.created_at || 0).getTime();
    const db = new Date(b.created_at || 0).getTime();
    return db - da;
  });
}

module.exports = { rankChunks };
