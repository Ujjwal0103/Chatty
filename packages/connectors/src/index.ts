import { PostgresConnector } from "./postgres.js";
import { QuickbooksConnector } from "./quickbooks.js";
import { StripeConnector } from "./stripe.js";
import type { Connector, ConnectorConfig } from "./types.js";

export * from "./types.js";
export { StripeConnector } from "./stripe.js";
export { PostgresConnector } from "./postgres.js";
export { QuickbooksConnector } from "./quickbooks.js";
export { introspectSchema } from "./introspect.js";

/** Build the right connector for a config. Keeps callers source-agnostic. */
export function createConnector(config: ConnectorConfig): Connector {
  switch (config.kind) {
    case "stripe":
      return new StripeConnector(config);
    case "postgres":
      return new PostgresConnector(config);
    case "quickbooks":
      return new QuickbooksConnector();
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown connector kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
