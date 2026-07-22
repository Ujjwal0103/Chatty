# Chatty — Correctness-First Finance Analyst

An LLM agent that answers natural-language finance questions (MRR, ARR, NRR/GRR,
churn, revenue, ARPU, active subscriptions) over a company's billing data. Its
wedge is **provable correctness**: the model never writes raw SQL. It selects
vetted metrics from a **semantic layer**, a deterministic compiler emits the SQL,
a **sqlglot** validator enforces read-only safety, and every answer ships with the
exact SQL, the metric definitions used, and sample source rows.

```
NL question
  → schema-linking (pgvector HNSW over the catalog)
  → planner (Claude Opus 4.8, structured output → QueryPlan; never raw SQL)
  → compiler (deterministic QueryPlan → SQL; fails closed on unknown metrics)
  → validator (sqlglot: read-only + schema allowlist + LIMIT + fingerprint)
  → Redis cache (keyed by structural fingerprint + params)
  → read-only Postgres exec (least-privilege role, statement timeout)
  → answer + provenance (SQL, metric defs, source rows)
```

## Layout

| Path | What |
|---|---|
| `infra/` | docker-compose: Postgres+pgvector, Redis |
| `db/` | warehouse schema, migrations, deterministic Stripe-shaped seed |
| `packages/shared` | `QueryPlan`/`Provenance` types, pooled RW + read-only db access, validator client |
| `packages/semantic-layer` | 10 vetted finance metrics + `QueryPlan`→SQL compiler |
| `packages/validator` | Python FastAPI sidecar wrapping sqlglot (guards + fingerprints) |
| `packages/connectors` | source-agnostic connector interface: Stripe / BYO-Postgres / QuickBooks (stub) |
| `packages/planner` | schema-linking retrieval + Claude → `QueryPlan` (Voyage embeddings, catalog fallback) |
| `packages/eval` | golden finance questions scored against independent reference queries |
| `apps/api` | Fastify: answer engine + SSE `/ask`, `/metrics`, `/connections`, `/history` |
| `apps/web` | Next.js provenance-forward chat UI |

## Prerequisites

- Node 20+, pnpm (via `corepack enable`), Docker, Python 3.9+.

## Quickstart

```bash
pnpm install

# 1. Infra + schema + seed
pnpm infra:up
pnpm db:migrate
pnpm db:seed

# 2. Validator sidecar (separate terminal)
cd packages/validator && python -m venv .venv && . .venv/bin/activate \
  && pip install -r requirements.txt && cd ../..
pnpm validator

# 3. Eval — proves the compile→validate→execute pipeline is correct (15/15)
pnpm eval

# 4. Run the app (API + web in separate terminals)
pnpm dev:api
pnpm dev:web        # http://localhost:3000
```

`pnpm eval` runs **compiler-only** mode offline (no LLM). Set `ANTHROPIC_API_KEY`
to run the full **LLM-planner** mode end-to-end; set `VOYAGE_API_KEY` for real
schema-linking embeddings (otherwise the small catalog is passed in full).

## Configuration

Copy `.env.example`. Notable vars: `DATABASE_URL` / `DATABASE_URL_RO`, `REDIS_URL`,
`VALIDATOR_URL`, `ANTHROPIC_API_KEY`, `PLANNER_MODEL` (`claude-opus-4-8`),
`VOYAGE_API_KEY`, `DATASET_AS_OF` (default `2025-06-30`, inside the seed's window).

## Tests

```bash
pnpm --filter @chatty/semantic-layer test      # 18: structure + numeric correctness vs seed
RUN_DB_TESTS=1 pnpm --filter @chatty/semantic-layer test   # includes DB numeric checks
cd packages/validator && . .venv/bin/activate && pytest    # 10: read-only guards + fingerprint
pnpm eval                                       # 15/15 golden finance questions
```

## Status

Milestone 1 (single-tenant vertical slice) is complete. Deferred: multi-tenant RLS
+ per-workspace warehouse connections, OAuth doc sync (Slack/Notion/Drive) with
hybrid retrieval + reranking, write/action paths, and real QuickBooks/NetSuite sync.
