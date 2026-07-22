// Client for the sqlglot validator sidecar. Every planned query passes through
// here before execution — the sidecar enforces read-only, schema allowlisting,
// LIMIT injection, and returns the structural fingerprint used for cache keys.
import { config } from "./config.js";
import type { ValidationResult } from "./types.js";

export interface ValidateOptions {
  allowedSchemas?: string[];
  maxRows?: number;
  /** Exact schema.table allowlist; when set, tables outside it fail closed. */
  allowedTables?: string[];
}

interface ValidatorResponse {
  ok: boolean;
  fingerprint: string | null;
  safe_sql: string | null;
  violations: string[];
}

export async function validateSql(sql: string, opts: ValidateOptions = {}): Promise<ValidationResult> {
  const res = await fetch(`${config.validatorUrl}/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sql,
      allowed_schemas: opts.allowedSchemas ?? ["warehouse"],
      max_rows: opts.maxRows ?? config.rowLimit,
      allowed_tables: opts.allowedTables ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(`Validator sidecar error: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as ValidatorResponse;
  return {
    ok: body.ok,
    fingerprint: body.fingerprint ?? undefined,
    safeSql: body.safe_sql ?? undefined,
    violations: body.violations,
  };
}
