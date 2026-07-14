// Numeric correctness against the seeded warehouse. Gated on RUN_DB_TESTS=1 so a
// plain `pnpm test` stays green offline; the eval/infra path enables it. Assertions
// use invariants + independent reference SQL rather than fragile magic numbers.
import type { QueryPlan } from "@chatty/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "./compiler.js";

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://chatty:chatty@localhost:5433/chatty";
const CTX = { asOf: "2025-06-30" };

let pool: pg.Pool;

async function value(plan: QueryPlan): Promise<number> {
  const { sql, params } = compile(plan, CTX);
  const res = await pool.query(sql, params);
  return Number((res.rows[0] as { value: string | number }).value);
}

async function scalar(sql: string): Promise<number> {
  const res = await pool.query(sql);
  return Number((res.rows[0] as { value: string | number }).value);
}

describe.runIf(RUN)("compiler — numeric correctness (seeded)", () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("MRR total matches an independent invoice-level reference", async () => {
    const mrr = await value({ metrics: ["mrr"], timeRange: { asOf: "2025-06-30" } });
    const ref = await scalar(`
      SELECT SUM(amount_paid) / 100.0 AS value
      FROM warehouse.invoices
      WHERE status = 'paid' AND period_start <= '2025-06-30' AND period_end > '2025-06-30'
    `);
    expect(mrr).toBeGreaterThan(0);
    expect(mrr).toBeCloseTo(ref, 2);
  });

  it("MRR is additive across the plan dimension", async () => {
    const total = await value({ metrics: ["mrr"], timeRange: { asOf: "2025-06-30" } });
    const { sql, params } = compile(
      { metrics: ["mrr"], dimensions: ["plan"], timeRange: { asOf: "2025-06-30" } },
      CTX,
    );
    const res = await pool.query(sql, params);
    const sum = res.rows.reduce((a, r) => a + Number((r as { value: string }).value), 0);
    expect(sum).toBeCloseTo(total, 2);
  });

  it("active subscriptions matches a reference count", async () => {
    const n = await value({ metrics: ["active_subscriptions"], timeRange: { asOf: "2025-06-30" } });
    const ref = await scalar(`
      SELECT COUNT(*) AS value FROM warehouse.subscriptions s
      WHERE s.start_date <= '2025-06-30' AND (s.canceled_at IS NULL OR s.canceled_at > '2025-06-30')
    `);
    expect(n).toBe(ref);
    expect(n).toBeGreaterThan(0);
  });

  it("ARR equals MRR × 12", async () => {
    const mrr = await value({ metrics: ["mrr"], timeRange: { asOf: "2025-06-30" } });
    const arr = await value({ metrics: ["arr"], timeRange: { asOf: "2025-06-30" } });
    expect(arr).toBeCloseTo(mrr * 12, 2);
  });

  it("monthly revenue buckets sum to total revenue", async () => {
    const total = await value({ metrics: ["revenue"], timeRange: { start: "2025-01-01", end: "2025-07-01" } });
    const { sql, params } = compile(
      { metrics: ["revenue"], timeRange: { start: "2025-01-01", end: "2025-07-01", grain: "month" } },
      CTX,
    );
    const res = await pool.query(sql, params);
    const sum = res.rows.reduce((a, r) => a + Number((r as { value: string }).value), 0);
    expect(res.rows.length).toBeGreaterThan(1);
    expect(sum).toBeCloseTo(total, 2);
  });

  it("GRR ≤ NRR and both are positive", async () => {
    const nrr = await value({ metrics: ["net_revenue_retention"], timeRange: { start: "2025-01-01", end: "2025-07-01" } });
    const grr = await value({ metrics: ["gross_revenue_retention"], timeRange: { start: "2025-01-01", end: "2025-07-01" } });
    expect(nrr).toBeGreaterThan(0);
    expect(grr).toBeGreaterThan(0);
    expect(grr).toBeLessThanOrEqual(nrr + 1e-9);
  });

  it("logo churn rate is a fraction in [0, 1]", async () => {
    const rate = await value({ metrics: ["logo_churn_rate"], timeRange: { start: "2025-02-01", end: "2025-07-01" } });
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  });

  it("new MRR over the full window is positive", async () => {
    const v = await value({ metrics: ["new_mrr"], timeRange: { start: "2025-01-01", end: "2025-07-01" } });
    expect(v).toBeGreaterThan(0);
  });
});
