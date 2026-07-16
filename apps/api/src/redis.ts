import { config } from "@chatty/shared";
import { Redis } from "ioredis";

// Result cache keyed by the sqlglot structural fingerprint + bind params. Two
// questions that compile to the same query (regardless of literal formatting)
// share a cache entry; different param values key separately.
let _redis: Redis | undefined;

function redis(): Redis {
  _redis ??= new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  return _redis;
}

const TTL_SECONDS = 300;

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const raw = await redis().get(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined; // cache is best-effort; never fail a query on Redis issues
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    await redis().set(key, JSON.stringify(value), "EX", TTL_SECONDS);
  } catch {
    // ignore
  }
}

export async function closeRedis(): Promise<void> {
  await _redis?.quit();
  _redis = undefined;
}
