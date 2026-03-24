const dotenv = require("dotenv");
dotenv.config();

const { pool, withTransaction } = require("./db");
const { cleanMessages } = require("./text");
const { chunkWithGemini } = require("./chunking");
const { embedText } = require("./gemini");

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS || 1000);

async function fetchNextJob(client) {
  const res = await client.query(
    "SELECT id, session_id FROM processing_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
  );
  if (res.rows.length === 0) return null;
  const job = res.rows[0];
  await client.query(
    "UPDATE processing_jobs SET status = 'processing', updated_at = now() WHERE id = $1",
    [job.id]
  );
  return job;
}

async function processJob(jobId, sessionId) {
  await withTransaction(async (client) => {
    const messagesRes = await client.query(
      "SELECT role, content FROM raw_messages WHERE session_id = $1 ORDER BY created_at ASC",
      [sessionId]
    );
    const cleaned = cleanMessages(messagesRes.rows);
    const chunks = await chunkWithGemini({ project: null, messages: cleaned });

    const embeddings = [];
    for (const chunk of chunks) {
      const vector = await embedText(chunk.content);
      embeddings.push(vector);
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

    await client.query(
      "UPDATE processing_jobs SET status = 'done', updated_at = now() WHERE id = $1",
      [jobId]
    );
  });
}

async function markFailed(jobId, error) {
  await pool.query(
    "UPDATE processing_jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
    [jobId, error]
  );
}

async function run() {
  console.log("Worker started");
  while (true) {
    try {
      const job = await withTransaction(fetchNextJob);
      if (!job) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
      await processJob(job.id, job.session_id);
    } catch (err) {
      console.error(err);
      if (err?.jobId) {
        await markFailed(err.jobId, err.message);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

run();
