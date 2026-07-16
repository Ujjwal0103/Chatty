import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { CatalogDimension, CatalogMetric } from "@chatty/semantic-layer";
import { config, type QueryPlan } from "@chatty/shared";
import { PlanSchema, toQueryPlan, type RawPlan } from "./schema.js";
import { retrieveRelevant } from "./schemaLinking.js";

export interface PlanResult {
  plan: QueryPlan;
  rawPlan: RawPlan;
  /** The catalog objects shown to the model (schema linking). */
  retrievedKeys: string[];
}

function renderCatalog(entries: Array<CatalogMetric | CatalogDimension>): string {
  const metrics = entries.filter((e): e is CatalogMetric => e.objectKind === "metric");
  const dims = entries.filter((e): e is CatalogDimension => e.objectKind === "dimension");
  const metricLines = metrics
    .map(
      (m) =>
        `- ${m.key} — ${m.description} [grain: ${m.grain}${
          m.supportedDimensions.length ? `; group/filter by: ${m.supportedDimensions.join(", ")}` : ""
        }]`,
    )
    .join("\n");
  const dimLines = dims.map((d) => `- ${d.key} — ${d.description}`).join("\n");
  return `METRICS:\n${metricLines}\n\nDIMENSIONS:\n${dimLines}`;
}

function systemPrompt(catalogText: string): string {
  return `You are the query planner for a finance analytics agent. You NEVER write SQL.
You translate the user's question into a structured query plan by choosing exactly one
metric from the catalog below and setting the time window, dimensions, and filters.

${catalogText}

RULES
- Choose exactly one metric whose definition matches the question.
- Snapshot metrics (grain: snapshot) answer "as of a point in time": set "asOf" to an
  ISO date; leave "start"/"end" empty. If the question doesn't specify a date, leave
  "asOf" empty and the system will use the dataset's current date.
- Period metrics (grain: period) answer "over a window": set "start" (inclusive) and
  "end" (EXCLUSIVE) ISO dates. Use "timeGrain" to bucket into a trend (e.g. "month").
- Cohort metrics (grain: cohort, e.g. NRR/GRR) compare a base month to a later month:
  set "start" to the first day of the base month and "end" to the exclusive end of the
  window.
- Only use dimensions the chosen metric lists as supported. Custom metrics
  (new_mrr, churned_mrr, logo_churn_rate, retention) support NO dimensions or filters.
- Dates are ISO YYYY-MM-DD. The dataset covers H1 2025 (2025-01-01 .. 2025-07-01).
  Interpret quarters as calendar quarters: Q1 = 2025-01-01..2025-04-01,
  Q2 = 2025-04-01..2025-07-01, H1 = 2025-01-01..2025-07-01.
- Set every field you don't use to its sentinel: "none", "" (empty string), 0, or [].`;
}

/**
 * Plan a natural-language finance question into a validated QueryPlan. The model
 * selects vetted metrics/dimensions only — the deterministic compiler downstream
 * turns the plan into SQL, so a bad plan fails closed rather than fabricating a number.
 */
export async function plan(question: string): Promise<PlanResult> {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set; the planner cannot run");
  }
  const retrieved = await retrieveRelevant(question);
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.parse({
    model: config.plannerModel,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: systemPrompt(renderCatalog(retrieved)),
    messages: [{ role: "user", content: question }],
    output_config: { format: zodOutputFormat(PlanSchema, "query_plan") },
  });

  const rawPlan = response.parsed_output;
  if (!rawPlan) {
    throw new Error(`Planner did not return a structured plan (stop_reason: ${response.stop_reason})`);
  }
  return {
    plan: toQueryPlan(rawPlan),
    rawPlan,
    retrievedKeys: retrieved.map((e) => `${e.objectKind}:${e.key}`),
  };
}
