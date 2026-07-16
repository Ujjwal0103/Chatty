import { createHash } from "node:crypto";
import { plan as planQuestion } from "@chatty/planner";
import { compile } from "@chatty/semantic-layer";
import {
  config,
  execReadOnly,
  rwPool,
  validateSql,
  type AnswerEnvelope,
  type Provenance,
  type QueryResult,
} from "@chatty/shared";
import { cacheGet, cacheSet } from "./redis.js";

// Streamed stages so the client sees the agent's reasoning: plan → sql → validate
// → cache → result → provenance. This is the trust surface — every number ships
// with the exact SQL, the metric definitions, and sample source rows.
export type Stage =
  | { stage: "planning" }
  | { stage: "planned"; plan: AnswerEnvelope["plan"]; retrievedKeys: string[] }
  | { stage: "compiled"; sql: string; metric: string }
  | { stage: "validated"; fingerprint: string }
  | { stage: "cache"; hit: boolean }
  | { stage: "result"; result: QueryResult }
  | { stage: "done"; envelope: AnswerEnvelope }
  | { stage: "error"; message: string };

interface CachedAnswer {
  result: QueryResult;
  sampleRows: Array<Record<string, unknown>>;
}

function cacheKey(fingerprint: string, params: unknown[]): string {
  const p = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16);
  return `ans:${fingerprint}:${p}`;
}

async function sampleSourceRows(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await execReadOnly(
    `SELECT i.id, i.customer_id, i.created::date AS created, i.status, i.amount_paid
       FROM warehouse.invoices i ORDER BY i.created DESC LIMIT 5`,
  );
  return rows;
}

async function persistHistory(env: AnswerEnvelope, fingerprint: string): Promise<void> {
  try {
    await rwPool().query(
      `INSERT INTO query_history (question, query_plan, compiled_sql, sql_fingerprint, result, provenance)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        env.question,
        JSON.stringify(env.plan),
        env.provenance.compiledSql,
        fingerprint,
        JSON.stringify(env.result),
        JSON.stringify(env.provenance),
      ],
    );
  } catch {
    // history is non-critical; don't fail the request on a write error
  }
}

/** Run the full pipeline, yielding each stage. Terminates with a `done` or `error`. */
export async function* answer(question: string): AsyncGenerator<Stage> {
  try {
    yield { stage: "planning" };
    const { plan, retrievedKeys } = await planQuestion(question);
    yield { stage: "planned", plan, retrievedKeys };

    const compiled = compile(plan, { asOf: config.datasetAsOf });
    yield { stage: "compiled", sql: compiled.sql, metric: compiled.metric.key };

    const validation = await validateSql(compiled.sql);
    if (!validation.ok || !validation.safeSql || !validation.fingerprint) {
      yield { stage: "error", message: `Validation failed: ${validation.violations.join(", ")}` };
      return;
    }
    yield { stage: "validated", fingerprint: validation.fingerprint };

    const key = cacheKey(validation.fingerprint, compiled.params);
    let result: QueryResult;
    let sampleRows: Array<Record<string, unknown>>;

    const cached = await cacheGet<CachedAnswer>(key);
    if (cached) {
      yield { stage: "cache", hit: true };
      result = cached.result;
      sampleRows = cached.sampleRows;
    } else {
      yield { stage: "cache", hit: false };
      const exec = await execReadOnly(validation.safeSql, compiled.params);
      result = { columns: exec.columns, rows: exec.rows };
      sampleRows = await sampleSourceRows();
      await cacheSet(key, { result, sampleRows } satisfies CachedAnswer);
    }
    yield { stage: "result", result };

    const provenance: Provenance = {
      metrics: [compiled.metric],
      compiledSql: validation.safeSql,
      sqlFingerprint: validation.fingerprint,
      sampleRows,
      executedAt: new Date().toISOString(),
    };
    const envelope: AnswerEnvelope = { question, plan, result, provenance };
    await persistHistory(envelope, validation.fingerprint);
    yield { stage: "done", envelope };
  } catch (err) {
    yield { stage: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
