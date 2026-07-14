import type { QueryPlan } from "@chatty/shared";
import { describe, expect, it } from "vitest";
import { compile, CompileError } from "./compiler.js";

const CTX = { asOf: "2025-06-30" };

describe("compiler — structure", () => {
  it("compiles a snapshot metric with an as-of filter", () => {
    const plan: QueryPlan = { metrics: ["mrr"], timeRange: { asOf: "2025-06-30" } };
    const { sql, params, metric } = compile(plan, CTX);
    expect(sql).toContain("SUM(il.amount) / 100.0 AS value");
    expect(sql).toContain("i.status = 'paid'");
    expect(sql).toContain("i.period_start <=");
    expect(params).toContain("2025-06-30");
    expect(metric.key).toBe("mrr");
  });

  it("groups a metric by a supported dimension", () => {
    const plan: QueryPlan = { metrics: ["mrr"], dimensions: ["plan"], timeRange: { asOf: "2025-06-30" } };
    const { sql } = compile(plan, CTX);
    expect(sql).toContain("pp.name AS plan");
    expect(sql).toContain("GROUP BY pp.name");
    expect(sql).toContain("JOIN warehouse.products pp");
  });

  it("buckets a period metric by grain", () => {
    const plan: QueryPlan = {
      metrics: ["revenue"],
      timeRange: { start: "2025-01-01", end: "2025-07-01", grain: "month" },
    };
    const { sql } = compile(plan, CTX);
    expect(sql).toContain("date_trunc('month', i.created)::date AS period");
    expect(sql).toContain("i.created >=");
    expect(sql).toContain("i.created <");
  });

  it("renders scalar and IN filters with bound params", () => {
    const plan: QueryPlan = {
      metrics: ["revenue"],
      filters: [{ dimension: "plan", op: "in", value: ["Pro", "Enterprise"] }],
      timeRange: { start: "2025-01-01", end: "2025-07-01" },
    };
    const { sql, params } = compile(plan, CTX);
    expect(sql).toMatch(/pp\.name IN \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(["Pro", "Enterprise"]));
  });
});

describe("compiler — fails closed", () => {
  it("rejects an unknown metric", () => {
    expect(() => compile({ metrics: ["revenoo"] }, CTX)).toThrow(CompileError);
  });

  it("rejects an unsupported dimension", () => {
    const plan: QueryPlan = { metrics: ["mrr"], dimensions: ["region"], timeRange: { asOf: "2025-06-30" } };
    expect(() => compile(plan, CTX)).toThrow(/does not support dimension 'region'/);
  });

  it("rejects group-by on a custom metric", () => {
    const plan: QueryPlan = { metrics: ["net_revenue_retention"], dimensions: ["plan"] };
    expect(() => compile(plan, CTX)).toThrow(/does not support group-by/);
  });

  it("rejects multiple metrics (milestone 1)", () => {
    expect(() => compile({ metrics: ["mrr", "arr"] }, CTX)).toThrow(CompileError);
  });

  it("rejects an unorderable key", () => {
    const plan: QueryPlan = {
      metrics: ["mrr"],
      timeRange: { asOf: "2025-06-30" },
      orderBy: [{ key: "haxx", direction: "asc" }],
    };
    expect(() => compile(plan, CTX)).toThrow(/Cannot order by 'haxx'/);
  });

  it("rejects a non-positive limit", () => {
    const plan: QueryPlan = { metrics: ["mrr"], timeRange: { asOf: "2025-06-30" }, limit: 0 };
    expect(() => compile(plan, CTX)).toThrow(/Invalid limit/);
  });
});
