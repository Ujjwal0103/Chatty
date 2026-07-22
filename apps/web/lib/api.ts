import type { CatalogMetric, Stage } from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787";

/** Stream pipeline stages from the API's SSE /ask endpoint. */
export async function* askStream(question: string, signal?: AbortSignal): AsyncGenerator<Stage> {
  const res = await fetch(`${API_URL}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ask failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice("data:".length).trim();
      if (json) yield JSON.parse(json) as Stage;
    }
  }
}

export async function fetchMetrics(): Promise<CatalogMetric[]> {
  const res = await fetch(`${API_URL}/metrics`);
  if (!res.ok) throw new Error(`metrics failed: ${res.status}`);
  const body = (await res.json()) as { metrics: CatalogMetric[] };
  return body.metrics;
}
