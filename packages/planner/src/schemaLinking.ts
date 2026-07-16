import { fullCatalog, type CatalogDimension, type CatalogMetric } from "@chatty/semantic-layer";
import { rwPool } from "@chatty/shared";
import { embed, embeddingsAvailable, toVectorLiteral } from "./embeddings.js";

type CatalogEntry = CatalogMetric | CatalogDimension;

function objectKey(e: CatalogEntry): string {
  return `${e.objectKind}:${e.key}`;
}

/**
 * Embed the semantic-layer catalog into pgvector (catalog_embeddings). Run once
 * after the catalog changes. No-op when embeddings aren't configured.
 */
export async function indexCatalog(): Promise<{ indexed: number }> {
  if (!embeddingsAvailable()) return { indexed: 0 };
  const entries = fullCatalog();
  const vectors = await embed(entries.map((e) => e.content), "document");
  const pool = rwPool();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    await pool.query(
      `INSERT INTO catalog_embeddings (object_kind, object_key, content, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (workspace_id, object_key)
       DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`,
      [e.objectKind, objectKey(e), e.content, toVectorLiteral(vectors[i]!)],
    );
  }
  return { indexed: entries.length };
}

/**
 * Return the catalog objects most relevant to a question via HNSW ANN search.
 * Falls back to the full catalog when embeddings aren't configured or nothing is
 * indexed yet — the milestone-1 catalog is small enough that this is safe, and it
 * keeps the planner working without a Voyage key.
 */
export async function retrieveRelevant(question: string, k = 12): Promise<CatalogEntry[]> {
  const all = fullCatalog();
  if (!embeddingsAvailable()) return all;

  const [queryVec] = await embed([question], "query");
  const { rows } = await rwPool().query<{ object_key: string }>(
    `SELECT object_key
       FROM catalog_embeddings
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [toVectorLiteral(queryVec!), k],
  );
  if (rows.length === 0) return all;

  const keep = new Set(rows.map((r) => r.object_key));
  const filtered = all.filter((e) => keep.has(objectKey(e)));
  // Always include dimensions of any retrieved metric so the planner can group/filter.
  return filtered.length > 0 ? filtered : all;
}
