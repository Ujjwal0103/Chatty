import { createHash } from "node:crypto";
import { introspectSchema } from "@chatty/connectors";
import { planSql, type SqlSchema } from "@chatty/planner";
import { config, type AnswerEnvelope, type Provenance, type QueryResult } from "@chatty/shared";
import pg from "pg";
import { cacheGet, cacheSet } from "./redis.js";
import type { Stage } from "./engine.js";

// Generic BYO-Postgres engine: introspect the connection's schema, have the LLM
// write grounded read-only SQL, validate it (read-only + schema/table allowlist +
// LIMIT), execute against the connection's OWN read-only pool, and return the
// answer with the exact SQL as provenance. Trust here = safe + grounded +
// transparent, not vetted metrics.

const { Pool } = pg;

export interface DbConnection {
  id: string;
  displayName: string;
  config: { schema?: string; connectionString?: string };
}

// One read-only pool per distinct connection string.
const pools = new Map<string, pg.Pool>();
function poolFor(connectionString: string): pg.Pool {
  let p = pools.get(connectionString);
  if (!p) {
    p = new Pool({ connectionString, max: 4 });
    pools.set(connectionString, p);
  }
  return p;
}

async function execReadOnly(
  pool: pg.Pool,
  sql: string,
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${config.statementTimeoutMs}`);
    const res = await client.query(sql);
    await client.query("COMMIT");
    return { columns: res.fields.map((f) => f.name), rows: res.rows as Array<Record<string, unknown>> };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function connString(conn: DbConnection): string {
  // Demo connection has no connectionString: use the least-privilege role on the
  // local DB (which has SELECT on the demo `app` schema).
  return conn.config.connectionString ?? config.databaseUrlRo;
}

/**
 * Test a candidate BYO-Postgres connection by connecting and introspecting the
 * given schema. Returns the table count. Uses a throwaway pool with a connect
 * timeout so a bad host fails fast; never logs the connection string.
 */
export async function testConnection(connectionString: string, schemaName: string): Promise<number> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 8000 });
  try {
    const tables = await introspectSchema(pool, schemaName);
    return tables.length;
  } finally {
    await pool.end();
  }
}

/** Introspect a connection's schema for display in the UI. */
export async function describeConnection(
  conn: DbConnection,
): Promise<{ schemaName: string; tables: Array<{ name: string; columns: string[] }> }> {
  const schemaName = conn.config.schema ?? "public";
  const pool = poolFor(connString(conn));
  const tables = await introspectSchema(pool, schemaName);
  return { schemaName, tables: tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) })) };
}

export async function* answerGeneric(question: string, conn: DbConnection): AsyncGenerator<Stage> {
  const { validateSql } = await import("@chatty/shared");
  try {
    const schemaName = conn.config.schema ?? "public";
    const pool = poolFor(connString(conn));

    yield { stage: "planning" };

    const tables = await introspectSchema(pool, schemaName);
    if (tables.length === 0) {
      yield { stage: "error", message: `No tables found in schema '${schemaName}'.` };
      return;
    }
    const schema: SqlSchema = {
      schemaName,
      tables: tables.map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => ({ name: c.name, dataType: c.dataType })),
      })),
    };

    const { sql, explanation } = await planSql(question, schema);
    if (!sql) {
      yield { stage: "error", message: explanation || "That question can't be answered from this schema." };
      return;
    }
    yield { stage: "compiled", sql, metric: "sql" };

    const allowedTables = tables.map((t) => `${schemaName}.${t.name}`);
    const validation = await validateSql(sql, { allowedSchemas: [schemaName], allowedTables });
    if (!validation.ok || !validation.safeSql || !validation.fingerprint) {
      yield { stage: "error", message: `Validation failed: ${validation.violations.join(", ")}` };
      return;
    }
    yield { stage: "validated", fingerprint: validation.fingerprint };

    // Generic SQL has literals inlined (no bind params), so key the result cache on
    // the full safe SQL, not the literal-masked fingerprint.
    const key = `gen:${createHash("sha256").update(validation.safeSql).digest("hex").slice(0, 24)}`;
    let result: QueryResult;
    const cached = await cacheGet<QueryResult>(key);
    if (cached) {
      yield { stage: "cache", hit: true };
      result = cached;
    } else {
      yield { stage: "cache", hit: false };
      const exec = await execReadOnly(pool, validation.safeSql);
      result = { columns: exec.columns, rows: exec.rows };
      await cacheSet(key, result);
    }
    yield { stage: "result", result };

    const provenance: Provenance = {
      metrics: [
        {
          key: "sql",
          label: "Ad-hoc query",
          description: explanation,
          definition: explanation,
          grain: "adhoc",
        },
      ],
      compiledSql: validation.safeSql,
      sqlFingerprint: validation.fingerprint,
      sampleRows: result.rows.slice(0, 5),
      executedAt: new Date().toISOString(),
    };
    const envelope: AnswerEnvelope = {
      question,
      plan: { metrics: ["sql"] },
      result,
      provenance,
    };
    yield { stage: "done", envelope };
  } catch (err) {
    yield { stage: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
