import cors from "@fastify/cors";
import { catalogDimensions, catalogMetrics } from "@chatty/semantic-layer";
import { closePools, rwPool } from "@chatty/shared";
import Fastify from "fastify";
import { answer } from "./engine.js";
import { closeRedis } from "./redis.js";

const PORT = Number(process.env.API_PORT ?? 8787);

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/health", async () => ({ status: "ok" }));

// Semantic-layer catalog — powers the UI's "available metrics" panel.
app.get("/metrics", async () => ({
  metrics: catalogMetrics(),
  dimensions: catalogDimensions(),
}));

app.get("/connections", async () => {
  const { rows } = await rwPool().query(
    `SELECT id, kind, display_name, created_at, last_synced_at FROM connections ORDER BY created_at`,
  );
  return { connections: rows };
});

app.get("/history", async () => {
  const { rows } = await rwPool().query(
    `SELECT id, question, compiled_sql, result, provenance, error, created_at
       FROM query_history ORDER BY created_at DESC LIMIT 50`,
  );
  return { history: rows };
});

// Ask a question — streams pipeline stages over SSE.
app.post<{ Body: { question?: string } }>("/ask", async (req, reply) => {
  const question = (req.body?.question ?? "").trim();
  // Take over the raw socket so Fastify doesn't send its own response and race
  // our SSE writes.
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const send = (obj: unknown): void => {
    reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  if (!question) {
    send({ stage: "error", message: "Missing 'question'." });
    reply.raw.end();
    return;
  }

  // Detect client disconnect via the RESPONSE socket. (The request stream's
  // "close" fires as soon as the POST body is read, which is not what we want.)
  let closed = false;
  reply.raw.on("close", () => {
    closed = true;
  });

  for await (const stage of answer(question)) {
    if (closed) break;
    send(stage);
  }
  reply.raw.end();
});

async function shutdown(): Promise<void> {
  await app.close();
  await closeRedis();
  await closePools();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app
  .listen({ port: PORT, host: "127.0.0.1" })
  .then((addr) => app.log.info(`chatty api on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
