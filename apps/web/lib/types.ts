// Client-side mirrors of the API's wire types (kept minimal; the API is the source
// of truth). See apps/api/src/engine.ts and packages/shared/src/types.ts.

export interface MetricProvenance {
  key: string;
  label: string;
  description: string;
  definition: string;
  grain: string;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface Provenance {
  metrics: MetricProvenance[];
  compiledSql: string;
  sqlFingerprint: string;
  sampleRows?: Array<Record<string, unknown>>;
  executedAt: string;
}

export interface QueryPlan {
  metrics: string[];
  dimensions?: string[];
  filters?: Array<{ dimension: string; op: string; value: unknown }>;
  timeRange?: { grain?: string; start?: string; end?: string; asOf?: string };
  orderBy?: Array<{ key: string; direction: string }>;
  limit?: number;
}

export interface AnswerEnvelope {
  question: string;
  plan: QueryPlan;
  result: QueryResult;
  provenance: Provenance;
}

export type Stage =
  | { stage: "planning" }
  | { stage: "planned"; plan: QueryPlan; retrievedKeys: string[] }
  | { stage: "compiled"; sql: string; metric: string }
  | { stage: "validated"; fingerprint: string }
  | { stage: "cache"; hit: boolean }
  | { stage: "result"; result: QueryResult }
  | { stage: "done"; envelope: AnswerEnvelope }
  | { stage: "error"; message: string };

export interface CatalogMetric {
  key: string;
  label: string;
  description: string;
  grain: string;
  supportedDimensions: string[];
}

export interface Connection {
  id: string;
  kind: string;
  display_name: string;
  mode: "finance" | "generic";
}

export interface SchemaInfo {
  schemaName: string | null;
  tables: Array<{ name: string; columns: string[] }>;
}
