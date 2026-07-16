// Golden eval runner. For each question: obtain a plan (from the LLM planner when
// ANTHROPIC_API_KEY is set, otherwise the known-good expectedPlan), compile it to
// SQL, validate through the sqlglot sidecar, execute read-only, and compare the
// number to an independent reference query. Prints a pass/N scoreboard.
//
//   pnpm --filter @chatty/eval run
//
// Requires: infra up, migrations + seed applied, and the validator sidecar running.
import { compile } from "@chatty/semantic-layer";
import { closePools, config, execReadOnly, validateSql, type QueryPlan } from "@chatty/shared";
import { GOLDEN, type GoldenItem } from "./golden.js";

const REL_TOL = 0.01; // 1% relative tolerance
const ABS_TOL = 0.01; // absolute floor for near-zero values

interface Outcome {
  id: string;
  metricOk: boolean;
  validateOk: boolean;
  numericOk: boolean;
  got?: number;
  truth?: number;
  error?: string;
}

function numericClose(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  return diff <= ABS_TOL || diff <= REL_TOL * Math.abs(b);
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await execReadOnly(sql, params);
  if (rows.length === 0) return Number.NaN;
  return Number((rows[0] as { value: unknown }).value);
}

async function getPlan(item: GoldenItem, usePlanner: boolean): Promise<QueryPlan> {
  if (!usePlanner) return item.expectedPlan;
  const { plan } = await import("@chatty/planner");
  const result = await plan(item.question);
  return result.plan;
}

async function runItem(item: GoldenItem, usePlanner: boolean): Promise<Outcome> {
  try {
    const plan = await getPlan(item, usePlanner);
    const compiled = compile(plan, { asOf: config.datasetAsOf });
    const metricOk = compiled.metric.key === item.expectedMetric;

    const validation = await validateSql(compiled.sql);
    if (!validation.ok || !validation.safeSql) {
      return { id: item.id, metricOk, validateOk: false, numericOk: false,
        error: `validation: ${validation.violations.join(", ")}` };
    }

    const got = await scalar(validation.safeSql, compiled.params);
    const truth = await scalar(item.referenceSql);
    const numericOk = Number.isFinite(got) && Number.isFinite(truth) && numericClose(got, truth);

    return { id: item.id, metricOk, validateOk: true, numericOk, got, truth };
  } catch (err) {
    return { id: item.id, metricOk: false, validateOk: false, numericOk: false,
      error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const usePlanner = config.anthropicApiKey !== "";
  console.log(`\nChatty eval — ${usePlanner ? "LLM planner" : "compiler-only (no ANTHROPIC_API_KEY)"} mode`);
  console.log(`Dataset as-of: ${config.datasetAsOf}\n`);

  const outcomes: Outcome[] = [];
  for (const item of GOLDEN) {
    const o = await runItem(item, usePlanner);
    outcomes.push(o);
    const pass = o.metricOk && o.validateOk && o.numericOk;
    const mark = pass ? "PASS" : "FAIL";
    const detail = o.error
      ? `  (${o.error})`
      : `  got=${o.got?.toFixed(2)} truth=${o.truth?.toFixed(2)}` +
        `${usePlanner ? ` metric=${o.metricOk ? "ok" : "WRONG"}` : ""}`;
    console.log(`  [${mark}] ${item.id}${detail}`);
  }

  const passed = outcomes.filter((o) => o.metricOk && o.validateOk && o.numericOk).length;
  console.log(`\nScore: ${passed}/${GOLDEN.length} passed\n`);

  await closePools();
  process.exit(passed === GOLDEN.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await closePools();
  process.exit(1);
});
