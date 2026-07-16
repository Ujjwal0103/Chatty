import type { Connector, SyncResult, TableInfo } from "./types.js";

/**
 * QuickBooks connector — interface stub for milestone 1. Real OAuth + GL sync
 * (accrual vs cash, chart of accounts) is a later milestone; it lands here so the
 * source-agnostic registry is complete and the shape is agreed.
 */
export class QuickbooksConnector implements Connector {
  readonly kind = "quickbooks" as const;

  async sync(): Promise<SyncResult> {
    throw new Error("QuickBooks connector is not implemented yet (planned for a later milestone)");
  }

  async introspect(): Promise<TableInfo[]> {
    throw new Error("QuickBooks connector is not implemented yet (planned for a later milestone)");
  }
}
