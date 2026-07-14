import type { QueryPlan } from "@chatty/shared";
import type { AggregateMetric, CompileContext, CompiledQuery, CustomMetric, DimensionBinding, Metric } from "./types.js";
import { firstOfMonth, Params, shiftMonth } from "./util.js";

// --- Shared base clauses -----------------------------------------------------

// Revenue truth = invoice line items. Using line items (not invoice totals) means
// grouping by plan never fan-out double-counts: each line item maps to one price.
const INVOICE_LINES =
  "warehouse.invoices i JOIN warehouse.invoice_line_items il ON il.invoice_id = i.id";

// The plan (product) dimension off an invoice line item.
const PLAN_DIM_INVOICE: DimensionBinding = {
  key: "plan",
  label: "Plan",
  description: "Product/plan name the revenue is attributed to (Starter, Pro, Enterprise).",
  selectExpr: "pp.name",
  joins: [
    "JOIN warehouse.prices pr ON pr.id = il.price_id",
    "JOIN warehouse.products pp ON pp.id = pr.product_id",
  ],
};

// The plan dimension off a subscription (via its item).
const PLAN_DIM_SUBSCRIPTION: DimensionBinding = {
  key: "plan",
  label: "Plan",
  description: "Product/plan the subscription is on.",
  selectExpr: "pp.name",
  joins: [
    "JOIN warehouse.subscription_items si ON si.subscription_id = s.id",
    "JOIN warehouse.prices pr ON pr.id = si.price_id",
    "JOIN warehouse.products pp ON pp.id = pr.product_id",
  ],
};

const FULL_WINDOW = { start: "2025-01-01", end: "2025-07-01" };

function periodWindow(plan: QueryPlan): { start: string; end: string } {
  return {
    start: plan.timeRange?.start ?? FULL_WINDOW.start,
    end: plan.timeRange?.end ?? FULL_WINDOW.end,
  };
}

/** First-of-month for the last month included in an exclusive-end window. */
function lastMonthOf(endExclusiveIso: string): string {
  const end = new Date(`${endExclusiveIso}T00:00:00Z`);
  const lastDay = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return firstOfMonth(
    `${lastDay.getUTCFullYear()}-${String(lastDay.getUTCMonth() + 1).padStart(2, "0")}-${String(
      lastDay.getUTCDate(),
    ).padStart(2, "0")}`,
  );
}

// --- Aggregate metrics -------------------------------------------------------

const activeSubscriptions: AggregateMetric = {
  kind: "aggregate",
  key: "active_subscriptions",
  label: "Active subscriptions",
  description: "Count of subscriptions that are live as of a point in time.",
  grain: "snapshot",
  fromSql: "warehouse.subscriptions s",
  measureExpr: "COUNT(DISTINCT s.id)",
  snapshotFilter: (asOf) =>
    `s.start_date <= ${asOf} AND (s.canceled_at IS NULL OR s.canceled_at > ${asOf})`,
  dimensions: { plan: PLAN_DIM_SUBSCRIPTION },
  definition:
    "COUNT(DISTINCT subscription) where start_date <= :asOf and not canceled on/before :asOf.",
};

const mrr: AggregateMetric = {
  kind: "aggregate",
  key: "mrr",
  label: "MRR",
  description: "Monthly recurring revenue (USD) from the monthly invoice covering the as-of date.",
  grain: "snapshot",
  fromSql: INVOICE_LINES,
  measureExpr: "SUM(il.amount) / 100.0",
  baseFilters: ["i.status = 'paid'"],
  snapshotFilter: (asOf) => `i.period_start <= ${asOf} AND i.period_end > ${asOf}`,
  dimensions: { plan: PLAN_DIM_INVOICE },
  definition:
    "SUM(paid invoice line amounts) in USD for the invoice period containing :asOf. Invoices are monthly, so this is MRR.",
};

const arr: AggregateMetric = {
  kind: "aggregate",
  key: "arr",
  label: "ARR",
  description: "Annual recurring revenue = MRR × 12 (USD).",
  grain: "snapshot",
  fromSql: INVOICE_LINES,
  measureExpr: "SUM(il.amount) * 12 / 100.0",
  baseFilters: ["i.status = 'paid'"],
  snapshotFilter: (asOf) => `i.period_start <= ${asOf} AND i.period_end > ${asOf}`,
  dimensions: { plan: PLAN_DIM_INVOICE },
  definition: "MRR × 12 for the invoice period containing :asOf.",
};

const arpu: AggregateMetric = {
  kind: "aggregate",
  key: "arpu",
  label: "ARPU",
  description: "Average recurring revenue per paying customer (USD), as of a point in time.",
  grain: "snapshot",
  fromSql: INVOICE_LINES,
  measureExpr: "SUM(il.amount) / 100.0 / NULLIF(COUNT(DISTINCT i.customer_id), 0)",
  baseFilters: ["i.status = 'paid'"],
  snapshotFilter: (asOf) => `i.period_start <= ${asOf} AND i.period_end > ${asOf}`,
  dimensions: { plan: PLAN_DIM_INVOICE },
  definition: "MRR ÷ distinct paying customers for the invoice period containing :asOf.",
};

const revenue: AggregateMetric = {
  kind: "aggregate",
  key: "revenue",
  label: "Revenue",
  description: "Realized paid revenue (USD) over a period, optionally bucketed by grain.",
  grain: "period",
  fromSql: INVOICE_LINES,
  measureExpr: "SUM(il.amount) / 100.0",
  baseFilters: ["i.status = 'paid'"],
  timeColumn: "i.created",
  dimensions: { plan: PLAN_DIM_INVOICE },
  definition: "SUM(paid invoice line amounts) in USD where invoice.created is within the period.",
};

// --- Custom metrics (movement + retention) -----------------------------------

const newMrr: CustomMetric = {
  kind: "custom",
  key: "new_mrr",
  label: "New MRR",
  description: "MRR added by subscriptions whose first paid invoice falls within the period.",
  grain: "period",
  definition:
    "SUM(first invoice line amount) for subscriptions whose earliest paid invoice month is within the period.",
  build: (plan: QueryPlan): CompiledQuery => {
    const { start, end } = periodWindow(plan);
    const p = new Params();
    const s = p.add(start);
    const e = p.add(end);
    const sql = `WITH first_inv AS (
  SELECT i.subscription_id, MIN(i.period_start) AS first_period
  FROM warehouse.invoices i
  WHERE i.status = 'paid'
  GROUP BY i.subscription_id
)
SELECT COALESCE(SUM(il.amount), 0) / 100.0 AS value
FROM first_inv f
JOIN warehouse.invoices i ON i.subscription_id = f.subscription_id AND i.period_start = f.first_period
JOIN warehouse.invoice_line_items il ON il.invoice_id = i.id
WHERE f.first_period >= ${s} AND f.first_period < ${e}`;
    return { sql, params: p.values };
  },
};

const churnedMrr: CustomMetric = {
  kind: "custom",
  key: "churned_mrr",
  label: "Churned MRR",
  description: "MRR lost from subscriptions canceled within the period (their last invoice amount).",
  grain: "period",
  definition:
    "SUM(last paid invoice line amount) for subscriptions whose canceled_at is within the period.",
  build: (plan: QueryPlan): CompiledQuery => {
    const { start, end } = periodWindow(plan);
    const p = new Params();
    const s = p.add(start);
    const e = p.add(end);
    const sql = `SELECT COALESCE(SUM(il.amount), 0) / 100.0 AS value
FROM warehouse.subscriptions s
JOIN LATERAL (
  SELECT i.id
  FROM warehouse.invoices i
  WHERE i.subscription_id = s.id AND i.status = 'paid'
  ORDER BY i.period_start DESC
  LIMIT 1
) li ON TRUE
JOIN warehouse.invoice_line_items il ON il.invoice_id = li.id
WHERE s.canceled_at >= ${s} AND s.canceled_at < ${e}`;
    return { sql, params: p.values };
  },
};

const logoChurnRate: CustomMetric = {
  kind: "custom",
  key: "logo_churn_rate",
  label: "Logo churn rate",
  description: "Subscriptions canceled during the period ÷ subscriptions active at period start.",
  grain: "period",
  definition:
    "COUNT(subs canceled in period) ÷ COUNT(subs active at period start).",
  build: (plan: QueryPlan): CompiledQuery => {
    const { start, end } = periodWindow(plan);
    const p = new Params();
    const s1 = p.add(start);
    const e1 = p.add(end);
    const s2 = p.add(start);
    const s3 = p.add(start);
    const sql = `SELECT
  (SELECT COUNT(*) FROM warehouse.subscriptions s
     WHERE s.canceled_at >= ${s1} AND s.canceled_at < ${e1})::numeric
  / NULLIF((SELECT COUNT(*) FROM warehouse.subscriptions s
     WHERE s.start_date < ${s2} AND (s.canceled_at IS NULL OR s.canceled_at >= ${s3})), 0) AS value`;
    return { sql, params: p.values };
  },
};

/** Shared cohort scaffold for NRR/GRR: base month vs final month for the same customers. */
function retentionQuery(plan: QueryPlan, mode: "net" | "gross"): CompiledQuery {
  const { start, end } = periodWindow(plan);
  const baseMonth = firstOfMonth(start);
  const finalMonth = lastMonthOf(end);
  const p = new Params();
  const bm = p.add(baseMonth);
  const fm = p.add(finalMonth);
  const finalExpr =
    mode === "gross"
      ? "COALESCE(SUM(LEAST(COALESCE(f.amt, 0), b.amt)), 0)::numeric"
      : "COALESCE(SUM(f.amt), 0)::numeric";
  const sql = `WITH base AS (
  SELECT i.customer_id, SUM(il.amount) AS amt
  FROM warehouse.invoices i JOIN warehouse.invoice_line_items il ON il.invoice_id = i.id
  WHERE i.status = 'paid' AND date_trunc('month', i.period_start) = date_trunc('month', ${bm}::date)
  GROUP BY i.customer_id
), fin AS (
  SELECT i.customer_id, SUM(il.amount) AS amt
  FROM warehouse.invoices i JOIN warehouse.invoice_line_items il ON il.invoice_id = i.id
  WHERE i.status = 'paid' AND date_trunc('month', i.period_start) = date_trunc('month', ${fm}::date)
  GROUP BY i.customer_id
)
SELECT ${finalExpr} / NULLIF(SUM(b.amt), 0) AS value
FROM base b LEFT JOIN fin f ON f.customer_id = b.customer_id`;
  return { sql, params: p.values };
}

const nrr: CustomMetric = {
  kind: "custom",
  key: "net_revenue_retention",
  label: "Net revenue retention (NRR)",
  description:
    "Revenue in the final month from customers active in the base month ÷ their base-month revenue (expansion counts).",
  grain: "cohort",
  definition:
    "SUM(final-month MRR of base cohort) ÷ SUM(base-month MRR of base cohort). Base = first month of window, final = last month.",
  build: (plan: QueryPlan): CompiledQuery => retentionQuery(plan, "net"),
};

const grr: CustomMetric = {
  kind: "custom",
  key: "gross_revenue_retention",
  label: "Gross revenue retention (GRR)",
  description:
    "Like NRR but each customer's final-month revenue is capped at their base-month revenue (no expansion credit).",
  grain: "cohort",
  definition:
    "SUM(LEAST(final-month, base-month) MRR of base cohort) ÷ SUM(base-month MRR of base cohort).",
  build: (plan: QueryPlan): CompiledQuery => retentionQuery(plan, "gross"),
};

export const METRICS: Record<string, Metric> = Object.fromEntries(
  [
    activeSubscriptions,
    mrr,
    arr,
    arpu,
    revenue,
    newMrr,
    churnedMrr,
    logoChurnRate,
    nrr,
    grr,
  ].map((m) => [m.key, m]),
);
