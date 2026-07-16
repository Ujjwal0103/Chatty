import { config } from "@chatty/shared";

// Voyage is Anthropic's recommended embeddings provider (Anthropic has no
// first-party embeddings API). voyage-3-large returns 1024-dim vectors, matching
// the catalog_embeddings VECTOR(1024) column.
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
}

export function embeddingsAvailable(): boolean {
  return config.voyageApiKey !== "";
}

/** Embed one or more texts. Throws if no Voyage key is configured. */
export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  if (!embeddingsAvailable()) {
    throw new Error("VOYAGE_API_KEY is not set; embeddings are unavailable");
  }
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.voyageApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: config.embeddingModel, input: texts, input_type: inputType }),
  });
  if (!res.ok) {
    throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as VoyageResponse;
  return body.data.map((d) => d.embedding);
}

/** pgvector literal for a float array, e.g. "[0.1,0.2,...]". */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
