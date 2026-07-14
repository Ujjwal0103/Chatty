-- Extensions used across the platform.
-- pgvector powers schema-linking (HNSW index over the semantic-layer catalog).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The warehouse schema holds connector-synced source data (Stripe today,
-- BYO-Postgres tables get introspected in place). Kept separate from platform
-- tables so a read-only role can be scoped to exactly this schema.
CREATE SCHEMA IF NOT EXISTS warehouse;
