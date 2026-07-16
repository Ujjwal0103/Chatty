// Source-agnostic connector contract. Every connector lands data as SQL-queryable
// tables (Stripe syncs INTO the warehouse; BYO-Postgres is introspected in place),
// so the semantic layer and planner work over one uniform substrate regardless of
// where the data came from.

export type ConnectorKind = "stripe" | "postgres" | "quickbooks";

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
}

export interface SyncResult {
  kind: ConnectorKind;
  /** Rows written per warehouse table (empty for introspect-only connectors). */
  rowsByTable: Record<string, number>;
  /** Human-readable note, e.g. "using seed (no STRIPE_SECRET_KEY)". */
  note?: string;
}

export interface Connector {
  readonly kind: ConnectorKind;
  /** Pull/refresh source data (into the warehouse, or a no-op for BYO). */
  sync(): Promise<SyncResult>;
  /** List the tables/columns this source exposes, for schema linking. */
  introspect(): Promise<TableInfo[]>;
}

export interface StripeConfig {
  kind: "stripe";
  secretKey?: string;
}

export interface PostgresConfig {
  kind: "postgres";
  /** A read-only connection string to the customer's warehouse. */
  connectionString: string;
  /** Schema to introspect (defaults to "public"). */
  schema?: string;
}

export interface QuickbooksConfig {
  kind: "quickbooks";
}

export type ConnectorConfig = StripeConfig | PostgresConfig | QuickbooksConfig;
