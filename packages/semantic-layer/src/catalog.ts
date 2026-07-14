import { METRICS } from "./metrics.js";
import type { Metric } from "./types.js";

export interface CatalogMetric {
  objectKind: "metric";
  key: string;
  label: string;
  description: string;
  grain: string;
  /** Dimensions this metric can be grouped/filtered by. */
  supportedDimensions: string[];
  /** Text used both for the planner prompt and for embedding (schema linking). */
  content: string;
}

export interface CatalogDimension {
  objectKind: "dimension";
  key: string;
  label: string;
  description: string;
  content: string;
}

function metricSupportedDimensions(m: Metric): string[] {
  return m.kind === "aggregate" ? Object.keys(m.dimensions) : [];
}

/** Flat list of every metric in the semantic layer. */
export function catalogMetrics(): CatalogMetric[] {
  return Object.values(METRICS).map((m) => {
    const dims = metricSupportedDimensions(m);
    return {
      objectKind: "metric",
      key: m.key,
      label: m.label,
      description: m.description,
      grain: m.grain,
      supportedDimensions: dims,
      content: `${m.label} (${m.key}) — ${m.description} Grain: ${m.grain}.${
        dims.length ? ` Group/filter by: ${dims.join(", ")}.` : ""
      }`,
    };
  });
}

/** Deduped list of dimensions across all metrics. */
export function catalogDimensions(): CatalogDimension[] {
  const seen = new Map<string, CatalogDimension>();
  for (const m of Object.values(METRICS)) {
    if (m.kind !== "aggregate") continue;
    for (const b of Object.values(m.dimensions)) {
      if (seen.has(b.key)) continue;
      seen.set(b.key, {
        objectKind: "dimension",
        key: b.key,
        label: b.label,
        description: b.description,
        content: `${b.label} (${b.key}) — ${b.description}`,
      });
    }
  }
  return [...seen.values()];
}

/** Everything embeddable/promptable, for schema linking. */
export function fullCatalog(): Array<CatalogMetric | CatalogDimension> {
  return [...catalogMetrics(), ...catalogDimensions()];
}
