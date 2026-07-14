-- Least-privilege role used to EXECUTE planned queries. It can only SELECT from
-- the warehouse schema — never write, and never touch platform tables. This is a
-- defense-in-depth layer behind the sqlglot read-only validation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chatty_ro') THEN
    CREATE ROLE chatty_ro LOGIN PASSWORD 'chatty_ro';
  END IF;
END $$;

-- Can connect and see the warehouse schema, nothing more.
GRANT CONNECT ON DATABASE chatty TO chatty_ro;
REVOKE ALL ON SCHEMA public FROM chatty_ro;
GRANT USAGE ON SCHEMA warehouse TO chatty_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA warehouse TO chatty_ro;

-- Future warehouse tables (e.g. after a fresh sync) are readable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA warehouse GRANT SELECT ON TABLES TO chatty_ro;

-- Belt and suspenders: keep the role read-only even if it somehow gets other grants.
ALTER ROLE chatty_ro SET default_transaction_read_only = on;
