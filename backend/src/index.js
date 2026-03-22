const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

const { pool, withTransaction } = require("./db");
const { cleanMessages } = require("./text");
const { chunkWithGemini } = require("./chunking");
const { embedText } = require("./gemini");
const { rankChunks } = require("./rank");

const PORT = process.env.PORT || 8787;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:" + PORT;
const MAX_CONTEXT_BULLETS = Number(process.env.MAX_CONTEXT_BULLETS || 15);
const JWT_SECRET = process.env.JWT_SECRET || "";
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const OTP_EXPIRES_MINUTES = Number(process.env.OTP_EXPIRES_MINUTES || 10);
const OTP_RATE_LIMIT_SECONDS = Number(process.env.OTP_RATE_LIMIT_SECONDS || 60);
const SESSION_EXPIRES_DAYS = Number(process.env.SESSION_EXPIRES_DAYS || 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function requireEnv(value, name) {
  if (!value) {
    throw new Error(`${name} not configured`);
  }
}

let mailTransporter = null;
function getMailer() {
  requireEnv(GMAIL_USER, "GMAIL_USER");
  requireEnv(GMAIL_APP_PASSWORD, "GMAIL_APP_PASSWORD");
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD,
      },
    });
  }
  return mailTransporter;
}

function hashCode(code) {
  requireEnv(JWT_SECRET, "JWT_SECRET");
  return crypto.createHash("sha256").update(code + JWT_SECRET).digest("hex");
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function cleanupExpired() {
  await pool.query("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < now()");
  await pool.query(
    "DELETE FROM login_otps WHERE expires_at < now() OR used_at IS NOT NULL"
  );
}

function requireAuth(req, res, next) {
  try {
    requireEnv(JWT_SECRET, "JWT_SECRET");
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

app.post("/auth/request-otp", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email is required" });
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: "invalid email" });
    }

    await cleanupExpired();

    const userRes = await pool.query(
      "INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id",
      [normalizedEmail]
    );
    const userId = userRes.rows[0].id;

    const rateRes = await pool.query(
      "SELECT id FROM login_otps WHERE user_id = $1 AND created_at > now() - ($2 || ' seconds')::interval",
      [userId, OTP_RATE_LIMIT_SECONDS.toString()]
    );
    if (rateRes.rows.length > 0) {
      return res.status(429).json({ error: "OTP recently sent. Please wait." });
    }

    const code = generateOtp();
    const codeHash = hashCode(code);
    const expiresAt = `now() + interval '${OTP_EXPIRES_MINUTES} minutes'`;

    await pool.query(
      `INSERT INTO login_otps (user_id, code_hash, expires_at) VALUES ($1, $2, ${expiresAt})`,
      [userId, codeHash]
    );

    const mailer = getMailer();
    await mailer.sendMail({
      from: GMAIL_USER,
      to: normalizedEmail,
      subject: "Your Save to Brain OTP",
      text: `Your OTP is ${code}. It expires in ${OTP_EXPIRES_MINUTES} minutes.`,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/auth/verify-otp", async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ error: "email and code are required" });
    }
    const normalizedEmail = email.trim().toLowerCase();

    await cleanupExpired();

    const userRes = await pool.query("SELECT id, email FROM users WHERE email = $1", [
      normalizedEmail,
    ]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: "Invalid code" });
    }
    const user = userRes.rows[0];

    const otpRes = await pool.query(
      "SELECT id, code_hash FROM login_otps WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );
    if (otpRes.rows.length === 0) {
      return res.status(401).json({ error: "Invalid code" });
    }
    const otpRow = otpRes.rows[0];
    if (otpRow.code_hash !== hashCode(code.trim())) {
      return res.status(401).json({ error: "Invalid code" });
    }

    await pool.query("UPDATE login_otps SET used_at = now() WHERE id = $1", [
      otpRow.id,
    ]);

    requireEnv(JWT_SECRET, "JWT_SECRET");
    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: "30d",
    });

    return res.json({ token, email: user.email });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/history", requireAuth, async (req, res) => {
  try {
    await cleanupExpired();
    const userId = req.user.id;
    const historyRes = await pool.query(
      "SELECT id, project, expires_at, created_at, EXTRACT(EPOCH FROM (expires_at - now())) AS expires_in FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC",
      [userId]
    );
    const items = historyRes.rows.map((row) => ({
      brainId: row.id,
      project: row.project || "untitled",
      url: `${PUBLIC_BASE_URL}/brain/${row.id}/context`,
      expiresAt: row.expires_at,
      expiresIn: Math.max(0, Math.floor(Number(row.expires_in || 0))),
    }));
    return res.json({ items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/save-session", requireAuth, async (req, res) => {
  try {
    await cleanupExpired();
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
        `INSERT INTO sessions (project, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_EXPIRES_DAYS} days') RETURNING id`,
        [project || null, req.user.id]
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
    const curl = `curl -H \"Authorization: Bearer YOUR_JWT\" ${PUBLIC_BASE_URL}${url}/context`;

    return res.json({ brainId: result, url, curl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/brain/:id/context", requireAuth, async (req, res) => {
  try {
    await cleanupExpired();
    const sessionId = req.params.id;
    const sessionRes = await pool.query(
      "SELECT id, project, created_at FROM sessions WHERE id = $1 AND user_id = $2 AND expires_at > now()",
      [sessionId, req.user.id]
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
