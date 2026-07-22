"""sqlglot-backed validation for compiler-produced SQL.

The compiler already emits SQL from vetted metric definitions, but this is the
independent trust gate in front of execution: it guarantees the statement is a
single read-only query, only touches allow-listed schemas, calls no dangerous
functions, and carries an enforced row LIMIT. It also produces a canonical
fingerprint used as the Redis cache key (stable across bind-parameter values).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp

# Statement node types that mean "this is not a pure read".
_WRITE_NODES = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Merge,
    exp.Create,
    exp.Drop,
    exp.Alter,
    exp.TruncateTable,
    exp.Command,   # raw passthrough: SET, COPY, VACUUM, CALL, ...
    exp.Grant,
)

# Functions that can read files, sleep, or reach the network — never allowed.
_FUNCTION_DENYLIST = {
    "pg_sleep",
    "pg_read_file",
    "pg_read_binary_file",
    "lo_import",
    "lo_export",
    "dblink",
    "dblink_exec",
    "copy",
    "pg_ls_dir",
    "pg_stat_file",
    "set_config",
    "current_setting",
}


@dataclass
class ValidationResult:
    ok: bool
    fingerprint: str | None = None
    safe_sql: str | None = None
    violations: list[str] = field(default_factory=list)


def _cte_names(tree: exp.Expression) -> set[str]:
    names: set[str] = set()
    for cte in tree.find_all(exp.CTE):
        alias = cte.alias
        if alias:
            names.add(alias.lower())
    return names


def _referenced_tables(tree: exp.Expression) -> list[exp.Table]:
    ctes = _cte_names(tree)
    tables: list[exp.Table] = []
    for tbl in tree.find_all(exp.Table):
        # Skip references that resolve to a CTE rather than a real table.
        if tbl.name.lower() in ctes and tbl.db == "":
            continue
        tables.append(tbl)
    return tables


def validate(
    sql: str,
    allowed_schemas: list[str],
    max_rows: int,
    allowed_tables: list[str] | None = None,
) -> ValidationResult:
    violations: list[str] = []
    # Optional exact table allowlist (schema.table, lowercased). Used by the generic
    # BYO-Postgres path so freeform SQL that references a hallucinated table fails
    # closed instead of erroring at execution. None = skip (curated finance path).
    allowed_table_set = {t.lower() for t in allowed_tables} if allowed_tables is not None else None

    try:
        statements = sqlglot.parse(sql, dialect="postgres")
    except Exception as err:  # noqa: BLE001 - surface any parse failure as a violation
        return ValidationResult(ok=False, violations=[f"parse_error: {err}"])

    statements = [s for s in statements if s is not None]
    if len(statements) == 0:
        return ValidationResult(ok=False, violations=["empty_statement"])
    if len(statements) > 1:
        return ValidationResult(ok=False, violations=["multiple_statements_forbidden"])

    tree = statements[0]

    # 1. Must be a read (SELECT / WITH ... SELECT).
    if not isinstance(tree, (exp.Select, exp.Subquery, exp.With, exp.Union)):
        violations.append(f"not_a_select: {type(tree).__name__}")

    # 2. No write/DDL/command nodes anywhere.
    for node_type in _WRITE_NODES:
        if tree.find(node_type) is not None:
            violations.append(f"write_operation_forbidden: {node_type.__name__}")

    # 3. SELECT INTO is a write.
    if tree.find(exp.Into) is not None:
        violations.append("select_into_forbidden")

    # 4. Schema allowlist for every real table.
    allowed = {s.lower() for s in allowed_schemas}
    for tbl in _referenced_tables(tree):
        schema = (tbl.db or "").lower()
        if schema == "":
            violations.append(f"unqualified_table_forbidden: {tbl.name}")
            continue
        if schema not in allowed:
            violations.append(f"table_not_allowed: {schema}.{tbl.name}")
        elif allowed_table_set is not None and f"{schema}.{tbl.name}".lower() not in allowed_table_set:
            violations.append(f"table_not_in_schema: {schema}.{tbl.name}")

    # 5. Dangerous functions.
    for fn in tree.find_all(exp.Anonymous):
        name = (fn.this or "").lower() if isinstance(fn.this, str) else ""
        if name in _FUNCTION_DENYLIST:
            violations.append(f"function_not_allowed: {name}")
    for fn in tree.find_all(exp.Func):
        name = fn.sql_name().lower()
        if name in _FUNCTION_DENYLIST:
            violations.append(f"function_not_allowed: {name}")

    if violations:
        return ValidationResult(ok=False, violations=violations)

    # 6. Enforce a row cap. Clamp an existing LIMIT or add one.
    safe_tree = _enforce_limit(tree, max_rows)
    safe_sql = safe_tree.sql(dialect="postgres")

    return ValidationResult(
        ok=True,
        fingerprint=fingerprint(tree),
        safe_sql=safe_sql,
        violations=[],
    )


def _enforce_limit(tree: exp.Expression, max_rows: int) -> exp.Expression:
    # Only SELECT/Union carry a top-level LIMIT we can reason about.
    limit = tree.args.get("limit") if hasattr(tree, "args") else None
    if limit is not None and isinstance(limit, exp.Limit):
        try:
            current = int(limit.expression.name)
            if current <= max_rows:
                return tree
        except (AttributeError, ValueError):
            pass
    if isinstance(tree, (exp.Select, exp.Union, exp.Subquery, exp.With)):
        return tree.limit(max_rows)
    return tree


def _mask_literal(node: exp.Expression) -> exp.Expression:
    # Replace literal values with a placeholder so the fingerprint captures query
    # STRUCTURE only. Callers cache-key on (fingerprint + bind params), so two
    # queries differing only in literal/param values share a structural fingerprint.
    if isinstance(node, exp.Literal):
        return exp.Placeholder()
    return node


def fingerprint(tree: exp.Expression) -> str:
    """Canonical, literal-independent structural fingerprint for cache keying."""
    masked = tree.copy().transform(_mask_literal)
    canonical = masked.sql(dialect="postgres", normalize=True, comments=False).lower()
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
