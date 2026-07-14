import type { MetricProvenance, QueryPlan } from "@chatty/shared";
import { METRICS } from "./metrics.js";
import type { AggregateMetric, CompileContext, CompiledQuery, Metric } from "./types.js";
import { CompileError } from "./types.js";
import { Params, renderFilter, VALID_GRAINS } from "./util.js";

export { CompileError } from "./types.js";

export interface CompileOutput {
  sql: string;
  params: unknown[];
  metric: MetricProvenance;
}

/**
 * Deterministically compile a validated QueryPlan into SQL. The LLM only ever
 * picks metric/dimension/filter KEYS; every SQL fragment comes from vetted code
 * here. Anything the plan references that isn't in the catalog fails closed.
 */
export function compile(plan: QueryPlan, ctx: CompileContext): CompileOutput {
  if (!plan.metrics || plan.metrics.length === 0) {
    throw new CompileError("QueryPlan.metrics must contain at least one metric");
  }
  if (plan.metrics.length > 1) {
    throw new CompileError("Multiple metrics per query are not supported yet (milestone 1)");
  }
  const metricKey = plan.metrics[0]!;
  const metric = METRICS[metricKey];
  if (!metric) {
    throw new CompileError(`Unknown metric '${metricKey}'`);
  }

  const compiled =
    metric.kind === "aggregate" ? buildAggregate(metric, plan, ctx) : buildCustom(metric, plan);

  const sql = applyOrderAndLimit(compiled.sql, plan, metric);
  return { sql, params: compiled.params, metric: provenanceFor(metric) };
}

function buildCustom(
  metric: Extract<Metric, { kind: "custom" }>,
  plan: QueryPlan,
): CompiledQuery {
  if (plan.dimensions && plan.dimensions.length > 0) {
    throw new CompileError(`Metric '${metric.key}' does not support group-by dimensions`);
  }
  if (plan.filters && plan.filters.length > 0) {
    throw new CompileError(`Metric '${metric.key}' does not support filters`);
  }
  const ctx: CompileContext = { asOf: "" };
  return metric.build(plan, ctx);
}

function buildAggregate(metric: AggregateMetric, plan: QueryPlan, ctx: CompileContext): CompiledQuery {
  const p = new Params();
  const selects: string[] = [];
  const groupBy: string[] = [];
  const joins: string[] = [];
  const where: string[] = [...(metric.baseFilters ?? [])];
  const usedDimJoins = new Set<string>();

  const bindDimension = (key: string) => {
    const binding = metric.dimensions[key];
    if (!binding) {
      throw new CompileError(`Metric '${metric.key}' does not support dimension '${key}'`);
    }
    for (const j of binding.joins) {
      if (!usedDimJoins.has(j)) {
        usedDimJoins.add(j);
        joins.push(j);
      }
    }
    return binding;
  };

  // Group-by dimensions.
  for (const dimKey of plan.dimensions ?? []) {
    const b = bindDimension(dimKey);
    selects.push(`${b.selectExpr} AS ${dimKey}`);
    groupBy.push(b.selectExpr);
  }

  // Time handling.
  if (metric.grain === "snapshot") {
    const asOf = plan.timeRange?.asOf ?? ctx.asOf;
    if (!asOf) throw new CompileError(`Snapshot metric '${metric.key}' needs an as-of date`);
    where.push(metric.snapshotFilter!(p.add(asOf)));
  } else {
    const tr = plan.timeRange;
    if (metric.timeColumn) {
      if (tr?.start) where.push(`${metric.timeColumn} >= ${p.add(tr.start)}`);
      if (tr?.end) where.push(`${metric.timeColumn} < ${p.add(tr.end)}`);
      if (tr?.grain) {
        if (!VALID_GRAINS.has(tr.grain)) throw new CompileError(`Invalid grain '${tr.grain}'`);
        const bucket = `date_trunc('${tr.grain}', ${metric.timeColumn})::date`;
        selects.unshift(`${bucket} AS period`);
        groupBy.push(bucket);
      }
    }
  }

  // Filters.
  for (const f of plan.filters ?? []) {
    const b = bindDimension(f.dimension);
    where.push(renderFilter(b.selectExpr, f, p));
  }

  selects.push(`${metric.measureExpr} AS value`);

  let sql = `SELECT ${selects.join(", ")}\nFROM ${metric.fromSql}`;
  if (joins.length) sql += `\n${joins.join("\n")}`;
  if (where.length) sql += `\nWHERE ${where.join(" AND ")}`;
  if (groupBy.length) sql += `\nGROUP BY ${groupBy.join(", ")}`;
  return { sql, params: p.values };
}

function applyOrderAndLimit(sql: string, plan: QueryPlan, metric: Metric): string {
  let out = sql;
  const orderable = new Set<string>(["value", "period", ...Object.keys(
    metric.kind === "aggregate" ? metric.dimensions : {},
  )]);
  if (plan.orderBy && plan.orderBy.length > 0) {
    const parts = plan.orderBy.map((o) => {
      if (!orderable.has(o.key)) throw new CompileError(`Cannot order by '${o.key}'`);
      const dir = o.direction === "desc" ? "DESC" : "ASC";
      return `${o.key} ${dir}`;
    });
    out += `\nORDER BY ${parts.join(", ")}`;
  }
  if (plan.limit !== undefined) {
    if (!Number.isInteger(plan.limit) || plan.limit <= 0) {
      throw new CompileError(`Invalid limit '${plan.limit}'`);
    }
    out += `\nLIMIT ${plan.limit}`;
  }
  return out;
}

function provenanceFor(metric: Metric): MetricProvenance {
  return {
    key: metric.key,
    label: metric.label,
    description: metric.description,
    definition: metric.definition,
    grain: metric.grain,
  };
}
