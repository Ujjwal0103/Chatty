// Metric-aware formatting so the headline number reads the way a finance team
// expects (currency vs count vs percentage), driven by the metric key.

const CURRENCY = new Set(["mrr", "arr", "arpu", "revenue", "new_mrr", "churned_mrr"]);
const PERCENT = new Set(["logo_churn_rate", "net_revenue_retention", "gross_revenue_retention"]);
const COUNT = new Set(["active_subscriptions"]);

export function formatValue(metricKey: string, raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw ?? "—");
  if (CURRENCY.has(metricKey)) {
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  }
  if (PERCENT.has(metricKey)) {
    return `${(n * 100).toFixed(1)}%`;
  }
  if (COUNT.has(metricKey)) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function metricLabel(metricKey: string): string {
  return metricKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
