import { rwPool } from "@chatty/shared";
import { introspectSchema } from "./introspect.js";
import type { Connector, StripeConfig, SyncResult, TableInfo } from "./types.js";

const STRIPE_API = "https://api.stripe.com/v1";

interface StripeListResponse<T> {
  data: T[];
  has_more: boolean;
}

/** Convert a Stripe unix timestamp (seconds) to an ISO string, or null. */
function ts(sec: number | null | undefined): string | null {
  return sec == null ? null : new Date(sec * 1000).toISOString();
}

/**
 * Stripe connector. With a test-mode secret key it syncs the Stripe object model
 * into the warehouse schema; without a key it is a no-op that defers to the seed.
 * Uses the REST API directly (no SDK dependency) with cursor pagination.
 */
export class StripeConnector implements Connector {
  readonly kind = "stripe" as const;
  private readonly secretKey?: string;

  constructor(config: StripeConfig) {
    this.secretKey = config.secretKey || process.env.STRIPE_SECRET_KEY || undefined;
  }

  async introspect(): Promise<TableInfo[]> {
    // Stripe lands in the warehouse schema; report those tables.
    return introspectSchema(rwPool(), "warehouse");
  }

  async sync(): Promise<SyncResult> {
    if (!this.secretKey) {
      return {
        kind: this.kind,
        rowsByTable: {},
        note: "no STRIPE_SECRET_KEY set — warehouse left as-is (use the deterministic seed)",
      };
    }

    const rowsByTable: Record<string, number> = {};
    const pool = rwPool();

    rowsByTable["warehouse.customers"] = await this.syncCustomers(pool);
    rowsByTable["warehouse.products"] = await this.syncProducts(pool);
    rowsByTable["warehouse.prices"] = await this.syncPrices(pool);
    const { subs, items } = await this.syncSubscriptions(pool);
    rowsByTable["warehouse.subscriptions"] = subs;
    rowsByTable["warehouse.subscription_items"] = items;
    const { invoices, lines } = await this.syncInvoices(pool);
    rowsByTable["warehouse.invoices"] = invoices;
    rowsByTable["warehouse.invoice_line_items"] = lines;
    rowsByTable["warehouse.charges"] = await this.syncCharges(pool);

    return { kind: this.kind, rowsByTable };
  }

  // --- REST helpers ---------------------------------------------------------

  private async *list<T extends { id: string }>(
    path: string,
    params: Record<string, string> = {},
  ): AsyncGenerator<T> {
    let startingAfter: string | undefined;
    for (;;) {
      const q = new URLSearchParams({ limit: "100", ...params });
      if (startingAfter) q.set("starting_after", startingAfter);
      const res = await fetch(`${STRIPE_API}/${path}?${q.toString()}`, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
      });
      if (!res.ok) {
        throw new Error(`Stripe ${path} failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as StripeListResponse<T>;
      for (const item of body.data) yield item;
      if (!body.has_more || body.data.length === 0) break;
      startingAfter = body.data[body.data.length - 1]!.id;
    }
  }

  private async syncCustomers(pool: import("pg").Pool): Promise<number> {
    let n = 0;
    for await (const c of this.list<any>("customers")) {
      await pool.query(
        `INSERT INTO warehouse.customers (id, created, email, name, currency, delinquent, livemode)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name,
           currency=EXCLUDED.currency, delinquent=EXCLUDED.delinquent`,
        [c.id, ts(c.created), c.email, c.name, c.currency ?? "usd", !!c.delinquent, !!c.livemode],
      );
      n++;
    }
    return n;
  }

  private async syncProducts(pool: import("pg").Pool): Promise<number> {
    let n = 0;
    for await (const p of this.list<any>("products")) {
      await pool.query(
        `INSERT INTO warehouse.products (id, created, name, active)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active`,
        [p.id, ts(p.created), p.name, !!p.active],
      );
      n++;
    }
    return n;
  }

  private async syncPrices(pool: import("pg").Pool): Promise<number> {
    let n = 0;
    for await (const pr of this.list<any>("prices")) {
      await pool.query(
        `INSERT INTO warehouse.prices (id, created, product_id, unit_amount, currency, recurring_interval, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET unit_amount=EXCLUDED.unit_amount, active=EXCLUDED.active`,
        [
          pr.id, ts(pr.created), pr.product, pr.unit_amount ?? 0, pr.currency ?? "usd",
          pr.recurring?.interval ?? "month", !!pr.active,
        ],
      );
      n++;
    }
    return n;
  }

  private async syncSubscriptions(pool: import("pg").Pool): Promise<{ subs: number; items: number }> {
    let subs = 0;
    let items = 0;
    for await (const s of this.list<any>("subscriptions", { status: "all" })) {
      await pool.query(
        `INSERT INTO warehouse.subscriptions
           (id, customer_id, created, start_date, status, current_period_start,
            current_period_end, canceled_at, trial_start, trial_end, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,
           current_period_start=EXCLUDED.current_period_start,
           current_period_end=EXCLUDED.current_period_end, canceled_at=EXCLUDED.canceled_at`,
        [
          s.id, s.customer, ts(s.created), ts(s.start_date ?? s.created), s.status,
          ts(s.current_period_start), ts(s.current_period_end), ts(s.canceled_at),
          ts(s.trial_start), ts(s.trial_end), s.currency ?? "usd",
        ],
      );
      subs++;
      for (const it of s.items?.data ?? []) {
        await pool.query(
          `INSERT INTO warehouse.subscription_items (id, subscription_id, price_id, quantity, created)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO UPDATE SET quantity=EXCLUDED.quantity`,
          [it.id, s.id, it.price?.id ?? it.plan?.id, it.quantity ?? 1, ts(it.created ?? s.created)],
        );
        items++;
      }
    }
    return { subs, items };
  }

  private async syncInvoices(pool: import("pg").Pool): Promise<{ invoices: number; lines: number }> {
    let invoices = 0;
    let lines = 0;
    for await (const inv of this.list<any>("invoices")) {
      await pool.query(
        `INSERT INTO warehouse.invoices
           (id, customer_id, subscription_id, created, period_start, period_end,
            status, currency, amount_due, amount_paid, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,
           amount_paid=EXCLUDED.amount_paid, total=EXCLUDED.total`,
        [
          inv.id, inv.customer, inv.subscription, ts(inv.created), ts(inv.period_start),
          ts(inv.period_end), inv.status, inv.currency ?? "usd",
          inv.amount_due ?? 0, inv.amount_paid ?? 0, inv.total ?? 0,
        ],
      );
      invoices++;
      for (const li of inv.lines?.data ?? []) {
        await pool.query(
          `INSERT INTO warehouse.invoice_line_items
             (id, invoice_id, price_id, quantity, amount, currency, period_start, period_end)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET amount=EXCLUDED.amount`,
          [
            li.id, inv.id, li.price?.id ?? null, li.quantity ?? 1, li.amount ?? 0,
            li.currency ?? "usd", ts(li.period?.start), ts(li.period?.end),
          ],
        );
        lines++;
      }
    }
    return { invoices, lines };
  }

  private async syncCharges(pool: import("pg").Pool): Promise<number> {
    let n = 0;
    for await (const ch of this.list<any>("charges")) {
      await pool.query(
        `INSERT INTO warehouse.charges
           (id, customer_id, invoice_id, created, amount, currency, status, refunded, amount_refunded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,
           refunded=EXCLUDED.refunded, amount_refunded=EXCLUDED.amount_refunded`,
        [
          ch.id, ch.customer, ch.invoice, ts(ch.created), ch.amount ?? 0, ch.currency ?? "usd",
          ch.status, !!ch.refunded, ch.amount_refunded ?? 0,
        ],
      );
      n++;
    }
    return n;
  }
}
