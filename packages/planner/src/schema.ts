import type { FilterOp, PlanFilter, QueryPlan } from "@chatty/shared";
import { z } from "zod";

// The schema the LLM fills in. It is deliberately FLAT and uses sentinel values
// ("none" / "" / 0 / []) instead of optionals, because structured-output strict
// schemas require every field to be present. We translate it into the richer
// QueryPlan in code, so the model never has to emit nested unions or nulls.
export const PlanSchema = z.object({
  metric: z.string().describe("Exactly one metric key from the catalog, e.g. 'mrr'."),
  dimensions: z
    .array(z.string())
    .describe("Dimension keys to group by (only ones the chosen metric supports). [] if none."),
  filters: z
    .array(
      z.object({
        dimension: z.string(),
        op: z.enum(["=", "!=", ">", ">=", "<", "<=", "in", "not_in"]),
        value: z
          .string()
          .describe("Scalar value; for in/not_in use a comma-separated list, e.g. 'Pro,Enterprise'."),
      }),
    )
    .describe("Filters on supported dimensions. [] if none."),
  timeGrain: z
    .enum(["none", "day", "week", "month", "quarter", "year"])
    .describe("Bucket a period metric over time, else 'none'."),
  start: z.string().describe("Inclusive ISO date YYYY-MM-DD for period/cohort metrics, else ''."),
  end: z.string().describe("Exclusive ISO date YYYY-MM-DD for period/cohort metrics, else ''."),
  asOf: z.string().describe("Point-in-time ISO date for snapshot metrics, else ''."),
  orderBy: z
    .enum(["none", "value_desc", "value_asc", "period_asc", "period_desc"])
    .describe("How to order grouped/bucketed rows."),
  limit: z.number().int().describe("Row cap, or 0 for no explicit limit."),
});

export type RawPlan = z.infer<typeof PlanSchema>;

function orderByOf(raw: RawPlan): QueryPlan["orderBy"] {
  switch (raw.orderBy) {
    case "value_desc":
      return [{ key: "value", direction: "desc" }];
    case "value_asc":
      return [{ key: "value", direction: "asc" }];
    case "period_asc":
      return [{ key: "period", direction: "asc" }];
    case "period_desc":
      return [{ key: "period", direction: "desc" }];
    default:
      return undefined;
  }
}

function filtersOf(raw: RawPlan): PlanFilter[] | undefined {
  if (raw.filters.length === 0) return undefined;
  return raw.filters.map((f) => {
    const op = f.op as FilterOp;
    if (op === "in" || op === "not_in") {
      return { dimension: f.dimension, op, value: f.value.split(",").map((s) => s.trim()) };
    }
    return { dimension: f.dimension, op, value: f.value };
  });
}

function timeRangeOf(raw: RawPlan): QueryPlan["timeRange"] {
  const tr: NonNullable<QueryPlan["timeRange"]> = {};
  if (raw.timeGrain !== "none") tr.grain = raw.timeGrain;
  if (raw.start) tr.start = raw.start;
  if (raw.end) tr.end = raw.end;
  if (raw.asOf) tr.asOf = raw.asOf;
  return Object.keys(tr).length > 0 ? tr : undefined;
}

/** Translate the flat model output into a validated-shape QueryPlan. */
export function toQueryPlan(raw: RawPlan): QueryPlan {
  const plan: QueryPlan = { metrics: [raw.metric] };
  if (raw.dimensions.length > 0) plan.dimensions = raw.dimensions;
  const filters = filtersOf(raw);
  if (filters) plan.filters = filters;
  const timeRange = timeRangeOf(raw);
  if (timeRange) plan.timeRange = timeRange;
  const orderBy = orderByOf(raw);
  if (orderBy) plan.orderBy = orderBy;
  if (raw.limit > 0) plan.limit = raw.limit;
  return plan;
}
