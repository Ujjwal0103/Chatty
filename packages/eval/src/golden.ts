import type { QueryPlan } from "@chatty/shared";

// Golden finance questions. Each carries:
//  - question: the NL prompt (fed to the planner in LLM mode)
//  - expectedMetric: the metric the planner MUST choose
//  - expectedPlan: a known-good plan (used directly in compiler-only mode, i.e.
//    when no ANTHROPIC_API_KEY is set) so the harness runs offline too
//  - referenceSql: an INDEPENDENT truth query (invoice-level, hand-written — not
//    the compiler's line-item path) that computes the correct number to compare against
//
// This set is the product's proof: "we answer these N finance questions provably
// correctly, and here is the SQL behind each."

export interface GoldenItem {
  id: string;
  question: string;
  expectedMetric: string;
  expectedPlan: QueryPlan;
  referenceSql: string;
}

const JUNE = "date_trunc('month', i.period_start) = date '2025-06-01'";
const JAN = "date_trunc('month', i.period_start) = date '2025-01-01'";

export const GOLDEN: GoldenItem[] = [
  {
    id: "mrr-h1-end",
    question: "What was our MRR at the end of H1 2025?",
    expectedMetric: "mrr",
    expectedPlan: { metrics: ["mrr"], timeRange: { asOf: "2025-06-30" } },
    referenceSql: `SELECT SUM(amount_paid) / 100.0 AS value FROM warehouse.invoices
                   WHERE status = 'paid' AND period_start <= '2025-06-30' AND period_end > '2025-06-30'`,
  },
  {
    id: "active-subs-jun30",
    question: "How many active subscriptions did we have as of June 30, 2025?",
    expectedMetric: "active_subscriptions",
    expectedPlan: { metrics: ["active_subscriptions"], timeRange: { asOf: "2025-06-30" } },
    referenceSql: `SELECT COUNT(*) AS value FROM warehouse.subscriptions s
                   WHERE s.start_date <= '2025-06-30' AND (s.canceled_at IS NULL OR s.canceled_at > '2025-06-30')`,
  },
  {
    id: "arr-current",
    question: "What is our ARR right now?",
    expectedMetric: "arr",
    expectedPlan: { metrics: ["arr"] },
    referenceSql: `SELECT SUM(amount_paid) * 12 / 100.0 AS value FROM warehouse.invoices
                   WHERE status = 'paid' AND period_start <= '2025-06-30' AND period_end > '2025-06-30'`,
  },
  {
    id: "revenue-q2",
    question: "What was total revenue in Q2 2025?",
    expectedMetric: "revenue",
    expectedPlan: { metrics: ["revenue"], timeRange: { start: "2025-04-01", end: "2025-07-01" } },
    referenceSql: `SELECT SUM(amount_paid) / 100.0 AS value FROM warehouse.invoices
                   WHERE status = 'paid' AND created >= '2025-04-01' AND created < '2025-07-01'`,
  },
  {
    id: "revenue-h1",
    question: "What was total revenue in H1 2025?",
    expectedMetric: "revenue",
    expectedPlan: { metrics: ["revenue"], timeRange: { start: "2025-01-01", end: "2025-07-01" } },
    referenceSql: `SELECT SUM(amount_paid) / 100.0 AS value FROM warehouse.invoices
                   WHERE status = 'paid' AND created >= '2025-01-01' AND created < '2025-07-01'`,
  },
  {
    id: "revenue-jan",
    question: "How much paid revenue did we collect in January 2025?",
    expectedMetric: "revenue",
    expectedPlan: { metrics: ["revenue"], timeRange: { start: "2025-01-01", end: "2025-02-01" } },
    referenceSql: `SELECT SUM(amount_paid) / 100.0 AS value FROM warehouse.invoices
                   WHERE status = 'paid' AND created >= '2025-01-01' AND created < '2025-02-01'`,
  },
  {
    id: "mrr-q1-end",
    question: "What was MRR at the end of Q1 2025?",
    expectedMetric: "mrr",
    expectedPlan: { metrics: ["mrr"], timeRange: { asOf: "2025-03-31" } },
    referenceSql: `SELECT SUM(amount_paid) / 100.0 AS value FROM warehouse.invoices
                   WHERE status = 'paid' AND period_start <= '2025-03-31' AND period_end > '2025-03-31'`,
  },
  {
    id: "active-subs-mar31",
    question: "How many active subscriptions were there on March 31, 2025?",
    expectedMetric: "active_subscriptions",
    expectedPlan: { metrics: ["active_subscriptions"], timeRange: { asOf: "2025-03-31" } },
    referenceSql: `SELECT COUNT(*) AS value FROM warehouse.subscriptions s
                   WHERE s.start_date <= '2025-03-31' AND (s.canceled_at IS NULL OR s.canceled_at > '2025-03-31')`,
  },
  {
    id: "arpu-h1-end",
    question: "What is our ARPU as of the end of H1 2025?",
    expectedMetric: "arpu",
    expectedPlan: { metrics: ["arpu"], timeRange: { asOf: "2025-06-30" } },
    referenceSql: `SELECT SUM(amount_paid) / 100.0 / NULLIF(COUNT(DISTINCT customer_id), 0) AS value
                   FROM warehouse.invoices
                   WHERE status = 'paid' AND period_start <= '2025-06-30' AND period_end > '2025-06-30'`,
  },
  {
    id: "new-mrr-q2",
    question: "How much new MRR did we add in Q2 2025?",
    expectedMetric: "new_mrr",
    expectedPlan: { metrics: ["new_mrr"], timeRange: { start: "2025-04-01", end: "2025-07-01" } },
    referenceSql: `WITH first_inv AS (
                     SELECT subscription_id, MIN(period_start) AS fp FROM warehouse.invoices
                     WHERE status = 'paid' GROUP BY subscription_id)
                   SELECT COALESCE(SUM(i.amount_paid), 0) / 100.0 AS value
                   FROM first_inv f JOIN warehouse.invoices i
                     ON i.subscription_id = f.subscription_id AND i.period_start = f.fp
                   WHERE f.fp >= '2025-04-01' AND f.fp < '2025-07-01'`,
  },
  {
    id: "new-mrr-h1",
    question: "How much new MRR did we add across H1 2025?",
    expectedMetric: "new_mrr",
    expectedPlan: { metrics: ["new_mrr"], timeRange: { start: "2025-01-01", end: "2025-07-01" } },
    referenceSql: `WITH first_inv AS (
                     SELECT subscription_id, MIN(period_start) AS fp FROM warehouse.invoices
                     WHERE status = 'paid' GROUP BY subscription_id)
                   SELECT COALESCE(SUM(i.amount_paid), 0) / 100.0 AS value
                   FROM first_inv f JOIN warehouse.invoices i
                     ON i.subscription_id = f.subscription_id AND i.period_start = f.fp
                   WHERE f.fp >= '2025-01-01' AND f.fp < '2025-07-01'`,
  },
  {
    id: "churned-mrr-q2",
    question: "How much MRR did we lose to churn in Q2 2025?",
    expectedMetric: "churned_mrr",
    expectedPlan: { metrics: ["churned_mrr"], timeRange: { start: "2025-04-01", end: "2025-07-01" } },
    referenceSql: `SELECT COALESCE(SUM(li.amount_paid), 0) / 100.0 AS value
                   FROM warehouse.subscriptions s
                   JOIN LATERAL (SELECT amount_paid FROM warehouse.invoices i
                                 WHERE i.subscription_id = s.id AND i.status = 'paid'
                                 ORDER BY i.period_start DESC LIMIT 1) li ON TRUE
                   WHERE s.canceled_at >= '2025-04-01' AND s.canceled_at < '2025-07-01'`,
  },
  {
    id: "logo-churn-feb-jun",
    question: "What was the logo churn rate from February through June 2025?",
    expectedMetric: "logo_churn_rate",
    expectedPlan: { metrics: ["logo_churn_rate"], timeRange: { start: "2025-02-01", end: "2025-07-01" } },
    referenceSql: `SELECT (SELECT COUNT(*) FROM warehouse.subscriptions s
                            WHERE s.canceled_at >= '2025-02-01' AND s.canceled_at < '2025-07-01')::numeric
                          / NULLIF((SELECT COUNT(*) FROM warehouse.subscriptions s
                            WHERE s.start_date < '2025-02-01'
                              AND (s.canceled_at IS NULL OR s.canceled_at >= '2025-02-01')), 0) AS value`,
  },
  {
    id: "nrr-h1",
    question: "What was our net revenue retention over H1 2025?",
    expectedMetric: "net_revenue_retention",
    expectedPlan: {
      metrics: ["net_revenue_retention"],
      timeRange: { start: "2025-01-01", end: "2025-07-01" },
    },
    referenceSql: `WITH base AS (
                     SELECT i.customer_id, SUM(il.amount) amt
                     FROM warehouse.invoices i JOIN warehouse.invoice_line_items il ON il.invoice_id = i.id
                     WHERE i.status = 'paid' AND ${JAN} GROUP BY i.customer_id),
                   fin AS (
                     SELECT i.customer_id, SUM(il.amount) amt
                     FROM warehouse.invoices i JOIN warehouse.invoice_line_items il ON il.invoice_id = i.id
                     WHERE i.status = 'paid' AND ${JUNE} GROUP BY i.customer_id)
                   SELECT COALESCE(SUM(f.amt), 0)::numeric / NULLIF(SUM(b.amt), 0) AS value
                   FROM base b LEFT JOIN fin f ON f.customer_id = b.customer_id`,
  },
  {
    id: "grr-h1",
    question: "What was our gross revenue retention over H1 2025?",
    expectedMetric: "gross_revenue_retention",
    expectedPlan: {
      metrics: ["gross_revenue_retention"],
      timeRange: { start: "2025-01-01", end: "2025-07-01" },
    },
    referenceSql: `WITH base AS (
                     SELECT i.customer_id, SUM(il.amount) amt
                     FROM warehouse.invoices i JOIN warehouse.invoice_line_items il ON il.invoice_id = i.id
                     WHERE i.status = 'paid' AND ${JAN} GROUP BY i.customer_id),
                   fin AS (
                     SELECT i.customer_id, SUM(il.amount) amt
                     FROM warehouse.invoices i JOIN warehouse.invoice_line_items il ON il.invoice_id = i.id
                     WHERE i.status = 'paid' AND ${JUNE} GROUP BY i.customer_id)
                   SELECT COALESCE(SUM(LEAST(COALESCE(f.amt, 0), b.amt)), 0)::numeric / NULLIF(SUM(b.amt), 0) AS value
                   FROM base b LEFT JOIN fin f ON f.customer_id = b.customer_id`,
  },
];
