import pg from "pg";
import { introspectSchema } from "./introspect.js";
import type { Connector, PostgresConfig, SyncResult, TableInfo } from "./types.js";

/**
 * Bring-your-own read-only Postgres. Nothing is copied; the source is queried in
 * place, so "sync" is a no-op and introspection reads the source's information_schema.
 * (A source-specific semantic layer is future work; milestone 1 ships the Stripe one.)
 */
export class PostgresConnector implements Connector {
  readonly kind = "postgres" as const;
  private readonly connectionString: string;
  private readonly schema: string;

  constructor(config: PostgresConfig) {
    this.connectionString = config.connectionString;
    this.schema = config.schema ?? "public";
  }

  async sync(): Promise<SyncResult> {
    return {
      kind: this.kind,
      rowsByTable: {},
      note: "bring-your-own Postgres is queried in place; no sync performed",
    };
  }

  async introspect(): Promise<TableInfo[]> {
    const pool = new pg.Pool({ connectionString: this.connectionString, max: 2 });
    try {
      return await introspectSchema(pool, this.schema);
    } finally {
      await pool.end();
    }
  }
}
