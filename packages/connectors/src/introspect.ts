import type pg from "pg";
import type { TableInfo } from "./types.js";

/** Read table/column metadata from information_schema for a given schema. */
export async function introspectSchema(pool: pg.Pool, schema: string): Promise<TableInfo[]> {
  const { rows } = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [schema],
  );

  const byTable = new Map<string, TableInfo>();
  for (const r of rows) {
    let t = byTable.get(r.table_name);
    if (!t) {
      t = { schema, name: r.table_name, columns: [] };
      byTable.set(r.table_name, t);
    }
    t.columns.push({
      name: r.column_name,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
    });
  }
  return [...byTable.values()];
}
