-- A demo "company" application database, representing a customer's own Postgres
-- that non-technical staff want to query in plain English ("how many users",
-- "how many users on service X"). This is the target of the GENERIC BYO-Postgres
-- path — the planner writes read-only SQL grounded in this schema; it is NOT the
-- curated finance warehouse. Lives in its own schema so it reads like a separate
-- database and the read-only role can be scoped to exactly it.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.accounts (
  id         INTEGER PRIMARY KEY,
  name       TEXT        NOT NULL,
  plan       TEXT        NOT NULL,            -- free | pro | enterprise
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS app.users (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER     NOT NULL REFERENCES app.accounts(id),
  email      TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  status     TEXT        NOT NULL,            -- active | invited | disabled
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS app.services (
  id   INTEGER PRIMARY KEY,
  key  TEXT NOT NULL UNIQUE,                  -- 'analytics', 'billing', ...
  name TEXT NOT NULL
);

-- Which users have access to which services (a user can be on several services).
CREATE TABLE IF NOT EXISTS app.subscriptions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES app.users(id),
  service_id  INTEGER     NOT NULL REFERENCES app.services(id),
  status      TEXT        NOT NULL,           -- active | trialing | canceled
  started_at  TIMESTAMPTZ NOT NULL,
  canceled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS app.usage_events (
  id         BIGINT PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES app.users(id),
  service_id INTEGER     NOT NULL REFERENCES app.services(id),
  event      TEXT        NOT NULL,            -- 'login', 'action', 'export', ...
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_users_account ON app.users(account_id);
CREATE INDEX IF NOT EXISTS idx_app_subs_user ON app.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_app_subs_service ON app.subscriptions(service_id);
CREATE INDEX IF NOT EXISTS idx_app_usage_service ON app.usage_events(service_id);

-- The generic planner executes as the least-privilege read-only role, scoped to
-- this schema (defense-in-depth behind the sqlglot read-only validation).
GRANT USAGE ON SCHEMA app TO chatty_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO chatty_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO chatty_ro;
