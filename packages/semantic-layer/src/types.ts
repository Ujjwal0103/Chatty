// Internal semantic-layer model. Two metric shapes:
//   - AggregateMetric: declarative "aggregate a measure over a base, optionally
//     grouped by supported dimensions / a time bucket". The generic compiler
//     handles dimensions, filters, time windows, ordering.
//   - CustomMetric: a hand-written, unit-tested SQL builder for movement and
//     retention metrics (new/churned MRR, NRR, GRR) whose logic doesn't fit the
//     single-aggregate mold. Still deterministic code — the LLM never writes it.

export type MetricGrain = "snapshot" | "period" | "cohort";

/** How a supported dimension is joined and projected for a given metric. */
export interface DimensionBinding {
  key: string;
  label: string;
  description: string;
  /** SQL expression producing the dimension value, e.g. "pp.name". */
  selectExpr: string;
  /** JOIN clauses this dimension needs (deduped when combined). */
  joins: string[];
}

export interface CompileContext {
  asOf: string; // dataset reference date (ISO) for snapshot metrics
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

export interface AggregateMetric {
  kind: "aggregate";
  key: string;
  label: string;
  description: string;
  grain: Exclude<MetricGrain, "cohort">;
  /** FROM clause including base joins shared by every query for this metric. */
  fromSql: string;
  /** The aggregate expression, e.g. "SUM(il.amount) / 100.0". */
  measureExpr: string;
  /** Always-on filters, e.g. ["i.status = 'paid'"]. */
  baseFilters?: string[];
  /** Time column for period metrics, e.g. "i.created". */
  timeColumn?: string;
  /** For snapshot metrics: builds the "is live at :asOf" predicate. */
  snapshotFilter?: (asOfPlaceholder: string) => string;
  /** Dimensions this metric supports, keyed by dimension key. */
  dimensions: Record<string, DimensionBinding>;
  /** Short prose of the definition, surfaced in provenance. */
  definition: string;
}

export interface CustomMetric {
  kind: "custom";
  key: string;
  label: string;
  description: string;
  grain: MetricGrain;
  /** Custom metrics accept a time window but no group-by dimensions in v1. */
  build: (plan: import("@chatty/shared").QueryPlan, ctx: CompileContext) => CompiledQuery;
  definition: string;
}

export type Metric = AggregateMetric | CustomMetric;

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}
