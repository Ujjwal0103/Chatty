export { compile, CompileError, type CompileOutput } from "./compiler.js";
export { METRICS } from "./metrics.js";
export {
  catalogMetrics,
  catalogDimensions,
  fullCatalog,
  type CatalogMetric,
  type CatalogDimension,
} from "./catalog.js";
export type { Metric, MetricGrain, CompileContext } from "./types.js";
