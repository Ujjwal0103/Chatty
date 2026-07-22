from validator.checks import validate

ALLOWED = ["warehouse"]


def v(sql, max_rows=5000):
    return validate(sql, ALLOWED, max_rows)


def test_allows_plain_select():
    r = v("SELECT SUM(il.amount) FROM warehouse.invoice_line_items il")
    assert r.ok, r.violations
    assert r.fingerprint
    assert "LIMIT 5000" in r.safe_sql


def test_allows_cte_without_flagging_cte_names_as_tables():
    sql = (
        "WITH base AS (SELECT customer_id, amount FROM warehouse.invoice_line_items) "
        "SELECT SUM(amount) FROM base"
    )
    r = v(sql)
    assert r.ok, r.violations


def test_rejects_insert():
    r = v("INSERT INTO warehouse.customers (id) VALUES ('x')")
    assert not r.ok
    assert any("write_operation_forbidden" in x for x in r.violations)


def test_rejects_update_and_delete():
    assert not v("UPDATE warehouse.customers SET name = 'x'").ok
    assert not v("DELETE FROM warehouse.customers").ok


def test_rejects_drop_and_truncate():
    assert not v("DROP TABLE warehouse.customers").ok
    assert not v("TRUNCATE warehouse.customers").ok


def test_rejects_table_outside_allowlist():
    r = v("SELECT * FROM public.query_history")
    assert not r.ok
    assert any("table_not_allowed" in x for x in r.violations)


def test_rejects_pg_catalog_and_functions():
    r = v("SELECT pg_sleep(10)")
    assert not r.ok


def test_rejects_multiple_statements():
    r = v("SELECT 1 FROM warehouse.customers; DROP TABLE warehouse.customers")
    assert not r.ok
    assert "multiple_statements_forbidden" in r.violations


def test_clamps_oversized_limit():
    r = v("SELECT id FROM warehouse.customers LIMIT 999999", max_rows=100)
    assert r.ok
    assert "LIMIT 100" in r.safe_sql


def test_table_allowlist_rejects_unknown_table():
    allowed = ["app.users", "app.services"]
    ok = validate("SELECT count(*) AS value FROM app.users", ["app"], 5000, allowed)
    assert ok.ok, ok.violations
    bad = validate("SELECT count(*) AS value FROM app.invoices", ["app"], 5000, allowed)
    assert not bad.ok
    assert any("table_not_in_schema" in v for v in bad.violations)


def test_fingerprint_ignores_literal_values():
    a = v("SELECT id FROM warehouse.customers WHERE id = 'a'")
    b = v("SELECT id FROM warehouse.customers WHERE id = 'b'")
    assert a.ok and b.ok
    # Literal-normalized canonical form => same fingerprint regardless of value.
    assert a.fingerprint == b.fingerprint
