-- Platform tables (not source data). Live in the default `public` schema.

-- A connected data source. Single-tenant for milestone 1, but the column shape
-- is already workspace-aware so multi-tenancy is an additive change later.
CREATE TABLE IF NOT EXISTS connections (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID       NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  kind        TEXT        NOT NULL,           -- 'stripe' | 'postgres' | 'quickbooks'
  display_name TEXT       NOT NULL,
  config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ
);

-- Schema-linking index: one row per catalog object (metric, dimension, entity,
-- or raw information_schema column) with its embedding. HNSW for ANN search so
-- the planner only sees the objects relevant to a question.
CREATE TABLE IF NOT EXISTS catalog_embeddings (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID       NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  object_kind TEXT        NOT NULL,           -- 'metric' | 'dimension' | 'entity' | 'column'
  object_key  TEXT        NOT NULL,           -- stable identifier, e.g. 'metric:mrr'
  content     TEXT        NOT NULL,           -- text that was embedded (name + description)
  embedding   VECTOR(1024) NOT NULL,          -- voyage-3-large dimensionality
  UNIQUE (workspace_id, object_key)
);

CREATE INDEX IF NOT EXISTS idx_catalog_embeddings_hnsw
  ON catalog_embeddings USING hnsw (embedding vector_cosine_ops);

-- Ask history + full provenance for auditability (the trust differentiator).
CREATE TABLE IF NOT EXISTS query_history (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  question     TEXT        NOT NULL,
  query_plan   JSONB,                          -- the structured QueryPlan chosen
  compiled_sql TEXT,                           -- exact SQL executed
  sql_fingerprint TEXT,                        -- sqlglot canonical fingerprint (cache key)
  result       JSONB,                          -- rows returned
  provenance   JSONB,                          -- metric defs + source samples
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_query_history_created ON query_history(created_at DESC);
