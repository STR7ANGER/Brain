const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");

const { pool, withTransaction } = require("./db");
const { cleanMessages } = require("./text");
const { chunkWithGemini } = require("./chunking");
const { embedText } = require("./gemini");
const { rankChunks } = require("./rank");

const PORT = process.env.PORT || 8787;
const API_KEY = process.env.API_KEY || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:" + PORT;
const MAX_CONTEXT_BULLETS = Number(process.env.MAX_CONTEXT_BULLETS || 15);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function requireAuth(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({ error: "API_KEY not configured" });
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

app.post("/save-session", requireAuth, async (req, res) => {
  try {
    const { project, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages must be a non-empty array" });
    }

    const cleanedMessages = cleanMessages(messages);
    const chunks = await chunkWithGemini({ project, messages: cleanedMessages });

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return res.status(500).json({ error: "No chunks produced" });
    }

    const embeddings = [];
    for (const chunk of chunks) {
      const vector = await embedText(chunk.content);
      embeddings.push(vector);
    }

    const result = await withTransaction(async (client) => {
      const sessionRes = await client.query(
        "INSERT INTO sessions (project) VALUES ($1) RETURNING id",
        [project || null]
      );
      const sessionId = sessionRes.rows[0].id;

      for (const msg of cleanedMessages) {
        await client.query(
          "INSERT INTO raw_messages (session_id, role, content) VALUES ($1, $2, $3)",
          [sessionId, msg.role, msg.content]
        );
      }

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const vector = embeddings[i];
        const vectorLiteral = "[" + vector.join(",") + "]";
        await client.query(
          "INSERT INTO chunks (session_id, type, content, embedding) VALUES ($1, $2, $3, $4::vector)",
          [sessionId, chunk.type, chunk.content, vectorLiteral]
        );
      }

      return sessionId;
    });

    const url = `/brain/${result}`;
    const curl = `curl -H \"Authorization: Bearer ${API_KEY}\" ${PUBLIC_BASE_URL}${url}/context`;

    return res.json({ brainId: result, url, curl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/brain/:id/context", requireAuth, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const sessionRes = await pool.query(
      "SELECT id, project, created_at FROM sessions WHERE id = $1",
      [sessionId]
    );
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }
    const session = sessionRes.rows[0];

    const chunksRes = await pool.query(
      "SELECT id, type, content, created_at FROM chunks WHERE session_id = $1",
      [sessionId]
    );

    const fluffPatterns = [
      /if you want/i,
      /just tell me/i,
      /let me know/i,
      /got it/i,
      /happy to/i,
      /i can/i,
      /i could/i,
      /i will/i,
      /we can/i,
      /should we/i,
      /would you like/i,
    ];

    const filtered = chunksRes.rows.filter((chunk) => {
      if (!chunk || !chunk.content) return false;
      return !fluffPatterns.some((re) => re.test(chunk.content));
    });

    const quotas = {
      decision: 5,
      task: 5,
      tech: 5,
      idea: 3,
      other: 2,
    };

    const grouped = {
      decision: [],
      task: [],
      tech: [],
      idea: [],
      other: [],
    };

    for (const chunk of filtered) {
      const type = grouped[chunk.type] ? chunk.type : "other";
      grouped[type].push(chunk);
    }

    for (const key of Object.keys(grouped)) {
      grouped[key] = rankChunks(grouped[key]).slice(0, quotas[key]);
    }

    const totalTarget = MAX_CONTEXT_BULLETS;

    let selected = [
      ...grouped.decision,
      ...grouped.task,
      ...grouped.tech,
      ...grouped.idea,
      ...grouped.other,
    ];

    if (selected.length > totalTarget) {
      const trimmed = rankChunks(selected).slice(0, totalTarget);
      const keepIds = new Set(trimmed.map((c) => c.id));
      for (const key of Object.keys(grouped)) {
        grouped[key] = grouped[key].filter((c) => keepIds.has(c.id));
      }
      selected = trimmed;
    } else {
      const selectedIds = new Set(selected.map((c) => c.id));
      const remaining = rankChunks(filtered.filter((c) => !selectedIds.has(c.id)));
      while (selected.length < totalTarget && remaining.length > 0) {
        selected.push(remaining.shift());
      }
    }
    const projectName = session.project || "untitled";

    const lines = [];
    lines.push("SYSTEM:");
    lines.push("- Start implementation immediately using reasonable assumptions.");
    lines.push("- Do not ask questions unless blocked.");
    lines.push("- Focus on producing working code first, then refinement.");
    lines.push("");
    lines.push("USER:");
    lines.push(`Project: ${projectName}`);
    lines.push("");

    function pushSection(title, items) {
      if (!items || items.length === 0) return;
      lines.push(`${title}:`);
      for (const item of items) {
        lines.push(`- ${item.content}`);
      }
      lines.push("");
    }

    pushSection("Decisions", grouped.decision);
    pushSection("Tasks", grouped.task);
    pushSection("Tech", grouped.tech);
    pushSection("Ideas", grouped.idea);
    pushSection("Other", grouped.other);

    const extra = selected.filter(
      (item) =>
        !grouped.decision.includes(item) &&
        !grouped.task.includes(item) &&
        !grouped.tech.includes(item) &&
        !grouped.idea.includes(item) &&
        !grouped.other.includes(item)
    );
    if (extra.length > 0) {
      lines.push("Additional Context:");
      for (const item of extra) {
        lines.push(`- ${item.content}`);
      }
      lines.push("");
    }

    lines.push("Task:");
    lines.push("Start implementation immediately using reasonable assumptions. Do not ask questions unless blocked.");

    res.type("text/plain").send(lines.join("\n"));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Save to Brain backend listening on ${PORT}`);
});
