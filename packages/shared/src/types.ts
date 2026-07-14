// Core cross-package contracts. The QueryPlan is the pivot of the whole system:
// the LLM planner emits ONE of these (never raw SQL), and the deterministic
// compiler turns it into vetted SQL. Keeping this shape strict is what lets a
// hallucinated field fail closed instead of producing a wrong number.

export type Grain = "day" | "week" | "month" | "quarter" | "year";

export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "not_in";

export interface PlanFilter {
  /** Dimension key defined in the semantic layer, e.g. "plan" or "customer_status". */
  dimension: string;
  op: FilterOp;
  /** Scalar for comparison ops, array for in/not_in. */
  value: string | number | boolean | Array<string | number>;
}

export interface PlanTimeRange {
  /** Bucketing grain when grouping a measure over time. */
  grain?: Grain;
  /** Inclusive ISO date (YYYY-MM-DD). */
  start?: string;
  /** Exclusive ISO date (YYYY-MM-DD). */
  end?: string;
  /** Point-in-time reference for snapshot metrics (defaults to dataset "today"). */
  asOf?: string;
}

export interface PlanOrderBy {
  /** A metric or dimension key present in the plan. */
  key: string;
  direction: "asc" | "desc";
}

/** The structured query the planner produces. Validated before compilation. */
export interface QueryPlan {
  /** One or more metric keys from the semantic layer, e.g. ["mrr"]. */
  metrics: string[];
  /** Dimension keys to group by, e.g. ["plan"]. */
  dimensions?: string[];
  filters?: PlanFilter[];
  timeRange?: PlanTimeRange;
  /** For retention metrics: the cohort dimension (usually "signup_month"). */
  cohort?: { by: string };
  orderBy?: PlanOrderBy[];
  limit?: number;
}

/** The definition of a metric, surfaced in provenance so numbers are auditable. */
export interface MetricProvenance {
  key: string;
  label: string;
  description: string;
  /** Human-readable definition, e.g. the measure expression + grain + filters. */
  definition: string;
  grain: string;
}

export interface Provenance {
  metrics: MetricProvenance[];
  compiledSql: string;
  sqlFingerprint: string;
  /** A few raw source rows behind the answer, for spot-checking. */
  sampleRows?: Array<Record<string, unknown>>;
  executedAt: string;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface AnswerEnvelope {
  question: string;
  plan: QueryPlan;
  result: QueryResult;
  provenance: Provenance;
}

/** Result of validating compiled SQL through the sqlglot sidecar. */
export interface ValidationResult {
  ok: boolean;
  fingerprint?: string;
  /** Rewritten SQL (e.g. with an enforced LIMIT) to actually execute. */
  safeSql?: string;
  violations: string[];
}
