-- Warehouse tables mirroring the Stripe object model. Monetary amounts are stored
-- in the smallest currency unit (cents), exactly like Stripe, as BIGINT. Timestamps
-- are stored as timestamptz. This is the SQL substrate the semantic layer plans over.

-- FX rates so measures can normalize to a single reporting currency (USD). The
-- seed loads USD at 1.0; the normalization code path is exercised regardless.
CREATE TABLE IF NOT EXISTS warehouse.fx_rates (
  currency     TEXT        NOT NULL,
  as_of        DATE        NOT NULL,
  rate_to_usd  NUMERIC(18,8) NOT NULL,
  PRIMARY KEY (currency, as_of)
);

CREATE TABLE IF NOT EXISTS warehouse.customers (
  id          TEXT        PRIMARY KEY,
  created     TIMESTAMPTZ NOT NULL,
  email       TEXT,
  name        TEXT,
  currency    TEXT        NOT NULL DEFAULT 'usd',
  delinquent  BOOLEAN     NOT NULL DEFAULT FALSE,
  livemode    BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS warehouse.products (
  id       TEXT        PRIMARY KEY,
  created  TIMESTAMPTZ NOT NULL,
  name     TEXT        NOT NULL,
  active   BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS warehouse.prices (
  id                 TEXT        PRIMARY KEY,
  created            TIMESTAMPTZ NOT NULL,
  product_id         TEXT        NOT NULL REFERENCES warehouse.products(id),
  unit_amount        BIGINT      NOT NULL,          -- cents
  currency           TEXT        NOT NULL DEFAULT 'usd',
  recurring_interval TEXT        NOT NULL,          -- 'month' | 'year'
  active             BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS warehouse.subscriptions (
  id                   TEXT        PRIMARY KEY,
  customer_id          TEXT        NOT NULL REFERENCES warehouse.customers(id),
  created              TIMESTAMPTZ NOT NULL,
  start_date           TIMESTAMPTZ NOT NULL,
  status               TEXT        NOT NULL,        -- active|trialing|past_due|canceled|unpaid
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  canceled_at          TIMESTAMPTZ,
  trial_start          TIMESTAMPTZ,
  trial_end            TIMESTAMPTZ,
  currency             TEXT        NOT NULL DEFAULT 'usd'
);

CREATE TABLE IF NOT EXISTS warehouse.subscription_items (
  id              TEXT        PRIMARY KEY,
  subscription_id TEXT        NOT NULL REFERENCES warehouse.subscriptions(id),
  price_id        TEXT        NOT NULL REFERENCES warehouse.prices(id),
  quantity        INTEGER     NOT NULL DEFAULT 1,
  created         TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouse.invoices (
  id              TEXT        PRIMARY KEY,
  customer_id     TEXT        NOT NULL REFERENCES warehouse.customers(id),
  subscription_id TEXT        REFERENCES warehouse.subscriptions(id),
  created         TIMESTAMPTZ NOT NULL,
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  status          TEXT        NOT NULL,             -- draft|open|paid|void|uncollectible
  currency        TEXT        NOT NULL DEFAULT 'usd',
  amount_due      BIGINT      NOT NULL DEFAULT 0,   -- cents
  amount_paid     BIGINT      NOT NULL DEFAULT 0,   -- cents
  total           BIGINT      NOT NULL DEFAULT 0    -- cents
);

CREATE TABLE IF NOT EXISTS warehouse.invoice_line_items (
  id           TEXT        PRIMARY KEY,
  invoice_id   TEXT        NOT NULL REFERENCES warehouse.invoices(id),
  price_id     TEXT        REFERENCES warehouse.prices(id),
  quantity     INTEGER     NOT NULL DEFAULT 1,
  amount       BIGINT      NOT NULL DEFAULT 0,      -- cents
  currency     TEXT        NOT NULL DEFAULT 'usd',
  period_start TIMESTAMPTZ,
  period_end   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS warehouse.charges (
  id              TEXT        PRIMARY KEY,
  customer_id     TEXT        NOT NULL REFERENCES warehouse.customers(id),
  invoice_id      TEXT        REFERENCES warehouse.invoices(id),
  created         TIMESTAMPTZ NOT NULL,
  amount          BIGINT      NOT NULL DEFAULT 0,   -- cents
  currency        TEXT        NOT NULL DEFAULT 'usd',
  status          TEXT        NOT NULL,             -- succeeded|pending|failed
  refunded        BOOLEAN     NOT NULL DEFAULT FALSE,
  amount_refunded BIGINT      NOT NULL DEFAULT 0    -- cents
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON warehouse.subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status   ON warehouse.subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subitems_subscription  ON warehouse.subscription_items(subscription_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer      ON warehouse.invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_created       ON warehouse.invoices(created);
CREATE INDEX IF NOT EXISTS idx_charges_customer       ON warehouse.charges(customer_id);
