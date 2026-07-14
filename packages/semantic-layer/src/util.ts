import type { PlanFilter } from "@chatty/shared";
import { CompileError } from "./types.js";

/** Accumulates bind parameters and hands back positional placeholders ($1, $2…). */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export const VALID_GRAINS = new Set(["day", "week", "month", "quarter", "year"]);

const OP_SQL: Record<string, string> = {
  "=": "=",
  "!=": "<>",
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
};

/** Render a validated plan filter against a dimension's SQL expression. */
export function renderFilter(expr: string, f: PlanFilter, p: Params): string {
  if (f.op === "in" || f.op === "not_in") {
    if (!Array.isArray(f.value)) {
      throw new CompileError(`Filter on '${f.dimension}' with op '${f.op}' requires an array value`);
    }
    const placeholders = f.value.map((v) => p.add(v)).join(", ");
    const not = f.op === "not_in" ? "NOT " : "";
    return `${expr} ${not}IN (${placeholders})`;
  }
  const sqlOp = OP_SQL[f.op];
  if (!sqlOp) throw new CompileError(`Unsupported filter op '${f.op}'`);
  if (Array.isArray(f.value)) {
    throw new CompileError(`Filter on '${f.dimension}' with op '${f.op}' requires a scalar value`);
  }
  return `${expr} ${sqlOp} ${p.add(f.value)}`;
}

/** First day of the month containing an ISO date, as an ISO date string. */
export function firstOfMonth(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** First day of the month that is `delta` months away from an ISO date. */
export function shiftMonth(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const shifted = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
