// Pooled Postgres access. Two pools by design:
//   - rwPool: full-privilege, for migrations/seeding/platform writes.
//   - roPool: the least-privilege chatty_ro role, used ONLY to execute planned
//     queries. Statement timeout + read-only transaction are enforced per query.
import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

let _rw: pg.Pool | undefined;
let _ro: pg.Pool | undefined;

export function rwPool(): pg.Pool {
  _rw ??= new Pool({ connectionString: config.databaseUrl, max: 10 });
  return _rw;
}

export function roPool(): pg.Pool {
  _ro ??= new Pool({ connectionString: config.databaseUrlRo, max: 10 });
  return _ro;
}

/**
 * Execute already-validated SQL on the read-only pool inside a read-only
 * transaction with a statement timeout. Never pass unvalidated SQL here.
 */
export async function execReadOnly(
  sql: string,
  params: unknown[] = [],
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
  const client = await roPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${config.statementTimeoutMs}`);
    const res = await client.query(sql, params);
    await client.query("COMMIT");
    return {
      columns: res.fields.map((f) => f.name),
      rows: res.rows as Array<Record<string, unknown>>,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([_rw?.end(), _ro?.end()]);
  _rw = undefined;
  _ro = undefined;
}
