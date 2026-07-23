import cors from "@fastify/cors";
import { catalogDimensions, catalogMetrics } from "@chatty/semantic-layer";
import { closePools, rwPool } from "@chatty/shared";
import Fastify from "fastify";
import { answer } from "./engine.js";
import { answerGeneric, describeConnection, type DbConnection } from "./generic.js";
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
  // `mode` tells the UI which engine a source uses: curated finance metrics vs
  // generic freeform SQL. `config` (which may hold secrets) is never returned.
  const { rows } = await rwPool().query<{ kind: string }>(
    `SELECT id, kind, display_name, created_at, last_synced_at FROM connections ORDER BY created_at`,
  );
  return {
    connections: rows.map((r) => ({ ...r, mode: r.kind === "postgres" ? "generic" : "finance" })),
  };
});

app.get("/history", async () => {
  const { rows } = await rwPool().query(
    `SELECT id, question, compiled_sql, result, provenance, error, created_at
       FROM query_history ORDER BY created_at DESC LIMIT 50`,
  );
  return { history: rows };
});

// Introspected schema for a generic (BYO-Postgres) source, for the UI's table list.
app.get<{ Params: { id: string } }>("/connections/:id/schema", async (req) => {
  const conn = await loadConnection(req.params.id);
  if (!conn || conn.kind !== "postgres") return { schemaName: null, tables: [] };
  return describeConnection({ id: conn.id, displayName: conn.display_name, config: conn.config });
});

interface ConnectionRow {
  id: string;
  kind: string;
  config: { schema?: string; connectionString?: string };
  display_name: string;
}

async function loadConnection(id: string): Promise<ConnectionRow | undefined> {
  const { rows } = await rwPool().query<ConnectionRow>(
    `SELECT id, kind, config, display_name FROM connections WHERE id = $1`,
    [id],
  );
  return rows[0];
}

// Ask a question — routes to the curated finance engine or the generic BYO-Postgres
// engine based on the selected connection, and streams pipeline stages over SSE.
app.post<{ Body: { question?: string; connectionId?: string } }>("/ask", async (req, reply) => {
  const question = (req.body?.question ?? "").trim();
  const connectionId = req.body?.connectionId;
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

  let stream;
  if (connectionId) {
    const conn = await loadConnection(connectionId);
    if (!conn) {
      send({ stage: "error", message: "Unknown connection." });
      reply.raw.end();
      return;
    }
    const dbConn: DbConnection = { id: conn.id, displayName: conn.display_name, config: conn.config };
    stream = conn.kind === "postgres" ? answerGeneric(question, dbConn) : answer(question);
  } else {
    stream = answer(question);
  }

  for await (const stage of stream) {
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
