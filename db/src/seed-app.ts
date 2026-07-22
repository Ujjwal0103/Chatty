// Deterministic seed for the demo "company" application database (schema `app`).
// This stands in for a customer's own Postgres so the generic BYO-Postgres path
// can be exercised with questions like "how many users on service X". Fixed PRNG
// seed => stable data.
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://chatty:chatty@localhost:5433/chatty";

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
const rng = mulberry32(0x5eed);
const rand = () => rng();
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const N_ACCOUNTS = 80;
const N_USERS = 500;
const N_USAGE = 5000;

const SERVICES = [
  { id: 1, key: "analytics", name: "Analytics" },
  { id: 2, key: "billing", name: "Billing" },
  { id: 3, key: "crm", name: "CRM" },
  { id: 4, key: "messaging", name: "Messaging" },
  { id: 5, key: "search", name: "Search" },
] as const;

const PLANS = ["free", "pro", "enterprise"] as const;
const USER_STATUS = ["active", "active", "active", "active", "active", "invited", "disabled"] as const;
const SUB_STATUS = ["active", "active", "active", "trialing", "canceled"] as const;
const EVENTS = ["login", "action", "export", "invite", "view"] as const;

// Random timestamp within [2024-06-01, 2025-06-30].
function randTs(): Date {
  const start = Date.UTC(2024, 5, 1);
  const end = Date.UTC(2025, 5, 30);
  return new Date(start + rand() * (end - start));
}

interface Row {
  [k: string]: string | number | boolean | Date | null;
}

async function insertMany(client: Client, table: string, cols: string[], rows: Row[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = slice.map((row, r) => {
      const ph = cols.map((c, ci) => {
        values.push(row[c] ?? null);
        return `$${r * cols.length + ci + 1}`;
      });
      return `(${ph.join(",")})`;
    });
    await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")}`, values);
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    console.log("Clearing app schema ...");
    await client.query(
      `TRUNCATE app.usage_events, app.subscriptions, app.users, app.services, app.accounts RESTART IDENTITY CASCADE`,
    );

    await insertMany(client, "app.services", ["id", "key", "name"], SERVICES.map((s) => ({ ...s })));

    const accounts: Row[] = [];
    for (let a = 1; a <= N_ACCOUNTS; a++) {
      accounts.push({ id: a, name: `Account ${a}`, plan: pick(PLANS), created_at: randTs() });
    }
    await insertMany(client, "app.accounts", ["id", "name", "plan", "created_at"], accounts);

    const users: Row[] = [];
    for (let u = 1; u <= N_USERS; u++) {
      const status = pick(USER_STATUS);
      const created = randTs();
      users.push({
        id: u,
        account_id: randInt(1, N_ACCOUNTS),
        email: `user${u}@example.com`,
        name: `User ${u}`,
        status,
        created_at: created,
        last_seen_at: status === "active" ? randTs() : null,
      });
    }
    await insertMany(
      client,
      "app.users",
      ["id", "account_id", "email", "name", "status", "created_at", "last_seen_at"],
      users,
    );

    // Each user subscribes to 1–3 distinct services.
    const subs: Row[] = [];
    let subId = 1;
    for (let u = 1; u <= N_USERS; u++) {
      const n = randInt(1, 3);
      const chosen = new Set<number>();
      while (chosen.size < n) chosen.add(randInt(1, SERVICES.length));
      for (const serviceId of chosen) {
        const status = pick(SUB_STATUS);
        const started = randTs();
        subs.push({
          id: subId++,
          user_id: u,
          service_id: serviceId,
          status,
          started_at: started,
          canceled_at: status === "canceled" ? randTs() : null,
        });
      }
    }
    await insertMany(
      client,
      "app.subscriptions",
      ["id", "user_id", "service_id", "status", "started_at", "canceled_at"],
      subs,
    );

    const usage: Row[] = [];
    for (let e = 1; e <= N_USAGE; e++) {
      const sub = pick(subs);
      usage.push({
        id: e,
        user_id: sub.user_id as number,
        service_id: sub.service_id as number,
        event: pick(EVENTS),
        created_at: randTs(),
      });
    }
    await insertMany(client, "app.usage_events", ["id", "user_id", "service_id", "event", "created_at"], usage);

    // Register the demo source as a BYO-Postgres connection (idempotent).
    await client.query(`DELETE FROM connections WHERE kind = 'postgres' AND config->>'demo' = 'app'`);
    await client.query(
      `INSERT INTO connections (kind, display_name, config, last_synced_at)
       VALUES ('postgres', 'Company Postgres (demo)', '{"schema":"app","demo":"app"}'::jsonb, now())`,
    );

    console.log(
      `App seed complete: ${accounts.length} accounts, ${users.length} users, ` +
        `${subs.length} subscriptions, ${usage.length} usage events.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
