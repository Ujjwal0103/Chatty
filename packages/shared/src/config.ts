// Central config loader. Reads env with sensible local-dev defaults so the
// pieces run without a .env during development, but real keys override.

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  databaseUrl: env("DATABASE_URL", "postgres://chatty:chatty@localhost:5433/chatty"),
  databaseUrlRo: env("DATABASE_URL_RO", "postgres://chatty_ro:chatty_ro@localhost:5433/chatty"),
  redisUrl: env("REDIS_URL", "redis://localhost:6380"),
  validatorUrl: env("VALIDATOR_URL", "http://127.0.0.1:7070"),

  anthropicApiKey: env("ANTHROPIC_API_KEY", ""),
  plannerModel: env("PLANNER_MODEL", "claude-opus-4-8"),
  routerModel: env("ROUTER_MODEL", "claude-haiku-4-5-20251001"),

  voyageApiKey: env("VOYAGE_API_KEY", ""),
  embeddingModel: env("EMBEDDING_MODEL", "voyage-3-large"),

  statementTimeoutMs: envNum("QUERY_STATEMENT_TIMEOUT_MS", 15_000),
  rowLimit: envNum("QUERY_ROW_LIMIT", 5_000),

  stripeSecretKey: env("STRIPE_SECRET_KEY", ""),

  /** Dataset reference "today" — the seed spans H1 2025; land inside June's period. */
  datasetAsOf: env("DATASET_AS_OF", "2025-06-30"),
} as const;

export type Config = typeof config;
