// Deterministic Stripe-shaped seed. A fixed PRNG seed means every run produces
// byte-identical data, so eval expected numbers are stable. Revenue flows through
// MONTHLY invoices — the single source of truth for MRR / NRR / churn / cohorts.
//
// Window: 2025-01 .. 2025-06 (H1 2025). Reference "today" = 2025-07-01.
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://chatty:chatty@localhost:5433/chatty";

// --- deterministic PRNG (mulberry32) ---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xc0ffee);
const rand = (): number => rng();
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const N_CUSTOMERS = 150;
const MONTHS = 6; // Jan..Jun 2025 => index 0..5

// Month index -> first-of-month timestamp (UTC).
function monthStart(m: number): Date {
  return new Date(Date.UTC(2025, m, 1, 0, 0, 0));
}
function monthEnd(m: number): Date {
  return new Date(Date.UTC(2025, m + 1, 1, 0, 0, 0));
}

interface Plan {
  productId: string;
  productName: string;
  monthlyPriceId: string;
  annualPriceId: string;
  monthlyCents: number;
}

const PLAN_DEFS = [
  { key: "starter", name: "Starter", monthly: 2900 },
  { key: "pro", name: "Pro", monthly: 9900 },
  { key: "enterprise", name: "Enterprise", monthly: 49900 },
] as const;

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

interface Row {
  [k: string]: string | number | boolean | Date | null;
}

async function insertMany(client: Client, table: string, cols: string[], rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = slice.map((row, r) => {
      const placeholders = cols.map((c, ci) => {
        values.push(row[c] ?? null);
        return `$${r * cols.length + ci + 1}`;
      });
      return `(${placeholders.join(",")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")} ON CONFLICT DO NOTHING`,
      values,
    );
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    console.log("Clearing warehouse ...");
    await client.query(`
      TRUNCATE warehouse.charges, warehouse.invoice_line_items, warehouse.invoices,
               warehouse.subscription_items, warehouse.subscriptions,
               warehouse.prices, warehouse.products, warehouse.customers,
               warehouse.fx_rates RESTART IDENTITY CASCADE
    `);

    // --- FX: USD anchor at 1.0 so the normalization code path is real but math stays clean.
    await insertMany(client, "warehouse.fx_rates", ["currency", "as_of", "rate_to_usd"], [
      { currency: "usd", as_of: "2025-01-01", rate_to_usd: 1 },
    ]);

    // --- Products + prices (monthly and annual; seed subs use monthly).
    const products: Row[] = [];
    const prices: Row[] = [];
    const plans: Plan[] = [];
    PLAN_DEFS.forEach((p, i) => {
      const productId = `prod_${p.key}`;
      const monthlyPriceId = `price_${p.key}_m`;
      const annualPriceId = `price_${p.key}_y`;
      products.push({ id: productId, created: monthStart(0), name: p.name, active: true });
      prices.push({
        id: monthlyPriceId, created: monthStart(0), product_id: productId,
        unit_amount: p.monthly, currency: "usd", recurring_interval: "month", active: true,
      });
      prices.push({
        id: annualPriceId, created: monthStart(0), product_id: productId,
        unit_amount: p.monthly * 10, currency: "usd", recurring_interval: "year", active: true,
      });
      plans.push({
        productId, productName: p.name, monthlyPriceId, annualPriceId, monthlyCents: p.monthly,
      });
      void i;
    });
    await insertMany(client, "warehouse.products", ["id", "created", "name", "active"], products);
    await insertMany(client, "warehouse.prices",
      ["id", "created", "product_id", "unit_amount", "currency", "recurring_interval", "active"], prices);

    // --- Customers, subscriptions, monthly invoices + line items + charges.
    const customers: Row[] = [];
    const subscriptions: Row[] = [];
    const subItems: Row[] = [];
    const invoices: Row[] = [];
    const lineItems: Row[] = [];
    const charges: Row[] = [];

    let invSeq = 0;
    let chgSeq = 0;
    let liSeq = 0;

    for (let c = 0; c < N_CUSTOMERS; c++) {
      const custId = `cus_${pad(c + 1, 4)}`;
      const cohortMonth = randInt(0, MONTHS - 1); // month they first subscribe
      const plan = pick(plans);

      customers.push({
        id: custId,
        created: monthStart(cohortMonth),
        email: `customer${c + 1}@example.com`,
        name: `Customer ${c + 1}`,
        currency: "usd",
        delinquent: false,
        livemode: false,
      });

      // Churn: each active month after the first has a small chance to be the last.
      let churnMonth: number | null = null;
      for (let m = cohortMonth + 1; m < MONTHS; m++) {
        if (rand() < 0.08) { churnMonth = m; break; }
      }
      const lastActiveMonth = churnMonth === null ? MONTHS - 1 : churnMonth - 1;

      // Expansion/contraction: at most one step change during the lifetime.
      let stepMonth: number | null = null;
      let stepFactor = 1;
      if (rand() < 0.25 && lastActiveMonth > cohortMonth) {
        stepMonth = randInt(cohortMonth + 1, lastActiveMonth);
        stepFactor = rand() < 0.7 ? 2 : 0.5; // expand (add a seat) or contract
      }

      const subId = `sub_${pad(c + 1, 4)}`;
      const status = churnMonth === null ? "active" : "canceled";
      const canceledAt = churnMonth === null ? null : monthStart(churnMonth);
      subscriptions.push({
        id: subId,
        customer_id: custId,
        created: monthStart(cohortMonth),
        start_date: monthStart(cohortMonth),
        status,
        current_period_start: monthStart(lastActiveMonth),
        current_period_end: monthEnd(lastActiveMonth),
        canceled_at: canceledAt,
        trial_start: null,
        trial_end: null,
        currency: "usd",
      });

      const finalQty = stepMonth !== null && stepFactor === 2 ? 2 : 1;
      subItems.push({
        id: `si_${pad(c + 1, 4)}`,
        subscription_id: subId,
        price_id: plan.monthlyPriceId,
        quantity: finalQty,
        created: monthStart(cohortMonth),
      });

      // Monthly invoices for each active month.
      for (let m = cohortMonth; m <= lastActiveMonth; m++) {
        let amount = plan.monthlyCents;
        if (stepMonth !== null && m >= stepMonth) amount = Math.round(plan.monthlyCents * stepFactor);

        invSeq++;
        const invId = `in_${pad(invSeq, 6)}`;
        invoices.push({
          id: invId,
          customer_id: custId,
          subscription_id: subId,
          created: monthStart(m),
          period_start: monthStart(m),
          period_end: monthEnd(m),
          status: "paid",
          currency: "usd",
          amount_due: amount,
          amount_paid: amount,
          total: amount,
        });

        liSeq++;
        lineItems.push({
          id: `il_${pad(liSeq, 6)}`,
          invoice_id: invId,
          price_id: plan.monthlyPriceId,
          quantity: amount === plan.monthlyCents ? 1 : Math.round(amount / plan.monthlyCents),
          amount,
          currency: "usd",
          period_start: monthStart(m),
          period_end: monthEnd(m),
        });

        chgSeq++;
        charges.push({
          id: `ch_${pad(chgSeq, 6)}`,
          customer_id: custId,
          invoice_id: invId,
          created: monthStart(m),
          amount,
          currency: "usd",
          status: "succeeded",
          refunded: false,
          amount_refunded: 0,
        });
      }
    }

    console.log(
      `Inserting: ${customers.length} customers, ${subscriptions.length} subs, ` +
      `${invoices.length} invoices ...`,
    );
    await insertMany(client, "warehouse.customers",
      ["id", "created", "email", "name", "currency", "delinquent", "livemode"], customers);
    await insertMany(client, "warehouse.subscriptions",
      ["id", "customer_id", "created", "start_date", "status", "current_period_start",
       "current_period_end", "canceled_at", "trial_start", "trial_end", "currency"], subscriptions);
    await insertMany(client, "warehouse.subscription_items",
      ["id", "subscription_id", "price_id", "quantity", "created"], subItems);
    await insertMany(client, "warehouse.invoices",
      ["id", "customer_id", "subscription_id", "created", "period_start", "period_end",
       "status", "currency", "amount_due", "amount_paid", "total"], invoices);
    await insertMany(client, "warehouse.invoice_line_items",
      ["id", "invoice_id", "price_id", "quantity", "amount", "currency", "period_start", "period_end"],
      lineItems);
    await insertMany(client, "warehouse.charges",
      ["id", "customer_id", "invoice_id", "created", "amount", "currency", "status",
       "refunded", "amount_refunded"], charges);

    // Register the seeded source as a connection so the app has something to show.
    await client.query(
      `INSERT INTO connections (kind, display_name, config, last_synced_at)
       VALUES ('stripe', 'Stripe (seed)', '{"mode":"seed"}'::jsonb, now())
       ON CONFLICT DO NOTHING`,
    );

    console.log("Seed complete.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
