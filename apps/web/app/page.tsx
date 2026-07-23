"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  askStream,
  connectSource,
  deleteConnection,
  fetchConnections,
  fetchMetrics,
  fetchSchema,
} from "../lib/api";
import { formatValue, metricLabel } from "../lib/format";
import type { AnswerEnvelope, CatalogMetric, Connection, SchemaInfo, Stage } from "../lib/types";
import { ProvenanceCard } from "../components/ProvenanceCard";

interface Turn {
  question: string;
  stages: string[];
  cacheHit?: boolean;
  metric?: string;
  envelope?: AnswerEnvelope;
  error?: string;
  running: boolean;
}

const FINANCE_SUGGESTIONS = [
  "What was our MRR at the end of H1 2025?",
  "What was net revenue retention over H1 2025?",
  "How much new MRR did we add in Q2 2025?",
  "How many active subscriptions did we have as of June 30, 2025?",
];

const COMPANY_SUGGESTIONS = [
  "How many users do we have?",
  "How many active users are on the Analytics service?",
  "How many users are on each service?",
  "How many users signed up in 2025?",
];

const STAGE_ORDER = ["planning", "planned", "compiled", "validated", "cache", "result", "done"];

function Answer({ turn }: { turn: Turn }) {
  if (turn.error) return <p className="error">⚠ {turn.error}</p>;
  if (!turn.envelope) return <p className="def body">Working…</p>;

  const { result, provenance } = turn.envelope;
  const metricKey = provenance.metrics[0]?.key ?? turn.metric ?? "";
  const label = metricKey === "sql" ? "Result" : metricLabel(metricKey);
  const scalar =
    result.rows.length === 1 && "value" in (result.rows[0] ?? {}) ? result.rows[0]!.value : undefined;

  return (
    <>
      {scalar !== undefined ? (
        <div className="headline">
          <span className="lbl">{label}</span>
          {formatValue(metricKey, scalar)}
        </div>
      ) : (
        <div className="scroll">
          <table className="grid">
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={i}>
                  {result.columns.map((c) => (
                    <td key={c}>{String(r[c] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ProvenanceCard provenance={provenance} />
    </>
  );
}

export default function Page() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [metrics, setMetrics] = useState<CatalogMetric[]>([]);
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [form, setForm] = useState({ displayName: "", connectionString: "", schema: "public" });
  const [connectErr, setConnectErr] = useState("");
  const [connecting, setConnecting] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => connections.find((c) => c.id === activeId), [connections, activeId]);
  const isGeneric = active?.mode === "generic";

  async function reloadConnections(selectId?: string): Promise<void> {
    const c = await fetchConnections();
    setConnections(c);
    if (selectId) setActiveId(selectId);
    else if (c.length > 0 && !c.some((x) => x.id === activeId)) setActiveId(c[0]!.id);
  }

  useEffect(() => {
    fetchMetrics().then(setMetrics).catch(() => setMetrics([]));
    fetchConnections()
      .then((c) => {
        setConnections(c);
        if (c.length > 0) setActiveId(c[0]!.id);
      })
      .catch(() => setConnections([]));
  }, []);

  async function submitConnect(): Promise<void> {
    setConnectErr("");
    if (!form.connectionString.trim()) {
      setConnectErr("Enter a read-only postgres:// connection string.");
      return;
    }
    setConnecting(true);
    try {
      const conn = await connectSource({
        displayName: form.displayName.trim() || "Company Postgres",
        connectionString: form.connectionString.trim(),
        schema: form.schema.trim() || "public",
      });
      await reloadConnections(conn.id);
      setShowConnect(false);
      setForm({ displayName: "", connectionString: "", schema: "public" });
    } catch (err) {
      setConnectErr(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  async function removeSource(id: string): Promise<void> {
    await deleteConnection(id);
    await reloadConnections();
  }

  useEffect(() => {
    if (active?.mode === "generic") {
      fetchSchema(active.id).then(setSchema).catch(() => setSchema(null));
    } else {
      setSchema(null);
    }
  }, [active]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const index = turns.length;
    setTurns((t) => [...t, { question: q, stages: [], running: true }]);

    const update = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t, i) => (i === index ? fn(t) : t)));

    try {
      for await (const s of askStream(q, activeId)) {
        applyStage(update, s);
      }
    } catch (err) {
      update((t) => ({ ...t, error: err instanceof Error ? err.message : String(err), running: false }));
    } finally {
      update((t) => ({ ...t, running: false }));
      setBusy(false);
    }
  }

  const suggestions = isGeneric ? COMPANY_SUGGESTIONS : FINANCE_SUGGESTIONS;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          Chatty
          <small>Ask your finance & product data</small>
        </div>

        <div className="section-title">Sources</div>
        {connections.map((c) => (
          <div key={c.id} className={`source ${c.id === activeId ? "active" : ""}`}>
            <button className="source-main" onClick={() => setActiveId(c.id)}>
              <span className="name">{c.display_name}</span>
              <span className={`mode ${c.mode}`}>{c.mode === "finance" ? "metrics" : "SQL"}</span>
            </button>
            {c.kind === "postgres" ? (
              <button className="remove" title="Remove source" onClick={() => removeSource(c.id)}>
                ×
              </button>
            ) : null}
          </div>
        ))}

        <button className="connect-toggle" onClick={() => setShowConnect((v) => !v)}>
          {showConnect ? "Cancel" : "+ Connect Postgres"}
        </button>
        {showConnect ? (
          <div className="connect-form">
            <input
              placeholder="Display name (e.g. Prod DB)"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <input
              placeholder="postgres://readonly:…@host:5432/db"
              value={form.connectionString}
              onChange={(e) => setForm({ ...form, connectionString: e.target.value })}
            />
            <input
              placeholder="schema (e.g. public)"
              value={form.schema}
              onChange={(e) => setForm({ ...form, schema: e.target.value })}
            />
            <p className="hint">Use a read-only credential. Queries run read-only regardless.</p>
            {connectErr ? <p className="error small">{connectErr}</p> : null}
            <button className="connect-submit" onClick={submitConnect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect & introspect"}
            </button>
          </div>
        ) : null}

        {isGeneric ? (
          <>
            <div className="section-title">Tables{schema?.schemaName ? ` · ${schema.schemaName}` : ""}</div>
            {(schema?.tables ?? []).map((t) => (
              <div className="metric-item" key={t.name}>
                <div className="k">{t.name}</div>
                <div className="d">{t.columns.join(", ")}</div>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="section-title">Metrics ({metrics.length})</div>
            {metrics.map((m) => (
              <div className="metric-item" key={m.key}>
                <div className="k">{m.key}</div>
                <div className="d">{m.description}</div>
                <span className="g">{m.grain}</span>
              </div>
            ))}
          </>
        )}
      </aside>

      <main className="main">
        <div className="header">
          <h1>{isGeneric ? `Ask ${active?.display_name}` : "Ask your finance data"}</h1>
          <p>
            {isGeneric
              ? "Plain-English questions become validated, read-only SQL over your schema — shown with the exact query."
              : "Every answer is planned over a semantic layer, executed as validated read-only SQL, and shown with its provenance."}
          </p>
        </div>

        <div className="stream" ref={streamRef}>
          {turns.length === 0 ? (
            <div className="empty">
              <p>
                {isGeneric
                  ? "Ask about users, accounts, services, subscriptions, or usage in the company database."
                  : "Ask about MRR, ARR, retention, churn, revenue, or subscriptions over the H1 2025 dataset."}
              </p>
              <div className="suggestions">
                {suggestions.map((s) => (
                  <button className="suggestion" key={s} onClick={() => ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn, i) => (
              <div className="turn" key={i}>
                <div className="q">{turn.question}</div>
                <div className="stages">
                  {STAGE_ORDER.filter((s) => turn.stages.includes(s)).map((s) => (
                    <span className={`chip ${turn.cacheHit && s === "cache" ? "hit" : "active"}`} key={s}>
                      {s === "cache" ? (turn.cacheHit ? "cache hit" : "cache miss") : s}
                    </span>
                  ))}
                </div>
                <div className="answer">
                  <Answer turn={turn} />
                </div>
              </div>
            ))
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isGeneric ? "e.g. How many users are on the Search service?" : "e.g. What was our gross revenue retention over H1 2025?"}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !input.trim()}>
            {busy ? "…" : "Ask"}
          </button>
        </form>
      </main>
    </div>
  );
}

function applyStage(update: (fn: (t: Turn) => Turn) => void, s: Stage): void {
  switch (s.stage) {
    case "planning":
      update((t) => ({ ...t, stages: [...t.stages, "planning"] }));
      break;
    case "planned":
      update((t) => ({ ...t, stages: [...t.stages, "planned"] }));
      break;
    case "compiled":
      update((t) => ({ ...t, stages: [...t.stages, "compiled"], metric: s.metric }));
      break;
    case "validated":
      update((t) => ({ ...t, stages: [...t.stages, "validated"] }));
      break;
    case "cache":
      update((t) => ({ ...t, stages: [...t.stages, "cache"], cacheHit: s.hit }));
      break;
    case "result":
      update((t) => ({ ...t, stages: [...t.stages, "result"] }));
      break;
    case "done":
      update((t) => ({ ...t, stages: [...t.stages, "done"], envelope: s.envelope, running: false }));
      break;
    case "error":
      update((t) => ({ ...t, error: s.message, running: false }));
      break;
  }
}
