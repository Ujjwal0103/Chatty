import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "@chatty/shared";
import { z } from "zod";

// The generic BYO-Postgres planner. Unlike the curated finance planner (which
// picks vetted metrics), this writes freeform read-only SQL grounded in an
// introspected schema. Correctness here comes from grounding + downstream
// validation (read-only, schema/table allowlist, LIMIT) + provenance — NOT from
// vetted metric definitions. The SQL is always surfaced for a human to verify.

export interface SqlSchema {
  schemaName: string;
  tables: Array<{ name: string; columns: Array<{ name: string; dataType: string }> }>;
}

const SqlOut = z.object({
  sql: z
    .string()
    .describe("A single read-only Postgres SELECT answering the question, or '' if unanswerable."),
  explanation: z.string().describe("One sentence: what the query computes, or why it can't be answered."),
});

export interface SqlPlanResult {
  sql: string;
  explanation: string;
}

function renderSchema(schema: SqlSchema): string {
  const lines = schema.tables.map(
    (t) => `- ${schema.schemaName}.${t.name}(${t.columns.map((c) => `${c.name} ${c.dataType}`).join(", ")})`,
  );
  return `Schema: ${schema.schemaName}\nTables:\n${lines.join("\n")}`;
}

function systemPrompt(schema: SqlSchema): string {
  return `You answer questions about a company's database by writing ONE read-only
PostgreSQL SELECT statement. You must only use the tables and columns listed below.

${renderSchema(schema)}

RULES
- Output a single SELECT statement. Never write INSERT/UPDATE/DELETE/DDL or multiple statements.
- Use ONLY the tables and columns above, and schema-qualify every table (e.g. ${schema.schemaName}.users).
- When the answer is a single number, alias that column AS "value" (e.g. SELECT COUNT(*) AS value ...).
- When the answer is a breakdown (per group), select the grouping column(s) plus the aggregate;
  give aggregates clear aliases and add ORDER BY.
- Add a sensible LIMIT to row-returning queries.
- Prefer counting DISTINCT users where the question is about "how many users".
- If the question cannot be answered from this schema, return sql = "" and explain why.
- Postgres dialect. Do not invent tables or columns.`;
}

/** Generate a grounded read-only SQL query for a question over the given schema. */
export async function planSql(question: string, schema: SqlSchema): Promise<SqlPlanResult> {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set; the SQL planner cannot run");
  }
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.parse({
    model: config.plannerModel,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: systemPrompt(schema),
    messages: [{ role: "user", content: question }],
    output_config: { format: zodOutputFormat(SqlOut) },
  });
  const out = response.parsed_output;
  if (!out) {
    throw new Error(`SQL planner returned no structured output (stop_reason: ${response.stop_reason})`);
  }
  return { sql: out.sql.trim(), explanation: out.explanation };
}
