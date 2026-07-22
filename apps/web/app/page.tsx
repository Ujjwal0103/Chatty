"use client";

import { useEffect, useRef, useState } from "react";
import { askStream, fetchMetrics } from "../lib/api";
import { formatValue, metricLabel } from "../lib/format";
import type { AnswerEnvelope, CatalogMetric, Stage } from "../lib/types";
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

const SUGGESTIONS = [
  "What was our MRR at the end of H1 2025?",
  "What was net revenue retention over H1 2025?",
  "How much new MRR did we add in Q2 2025?",
  "How many active subscriptions did we have as of June 30, 2025?",
];

const STAGE_ORDER = ["planning", "planned", "compiled", "validated", "cache", "result", "done"];

function Answer({ turn }: { turn: Turn }) {
  if (turn.error) return <p className="error">⚠ {turn.error}</p>;
  if (!turn.envelope) return <p className="def body">Working…</p>;

  const { result, provenance } = turn.envelope;
  const metricKey = provenance.metrics[0]?.key ?? turn.metric ?? "";
  const scalar =
    result.rows.length === 1 && "value" in (result.rows[0] ?? {}) ? result.rows[0]!.value : undefined;

  return (
    <>
      {scalar !== undefined ? (
        <div className="headline">
          <span className="lbl">{metricLabel(metricKey)}</span>
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
  const [metrics, setMetrics] = useState<CatalogMetric[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchMetrics().then(setMetrics).catch(() => setMetrics([]));
  }, []);

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
      for await (const s of askStream(q)) {
        applyStage(update, s);
      }
    } catch (err) {
      update((t) => ({ ...t, error: err instanceof Error ? err.message : String(err), running: false }));
    } finally {
      update((t) => ({ ...t, running: false }));
      setBusy(false);
    }
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          Chatty
          <small>Correctness-first finance analyst</small>
        </div>
        <div className="section-title">Metrics ({metrics.length})</div>
        {metrics.map((m) => (
          <div className="metric-item" key={m.key}>
            <div className="k">{m.key}</div>
            <div className="d">{m.description}</div>
            <span className="g">{m.grain}</span>
          </div>
        ))}
      </aside>

      <main className="main">
        <div className="header">
          <h1>Ask your finance data</h1>
          <p>Every answer is planned over a semantic layer, executed as validated read-only SQL, and shown with its provenance.</p>
        </div>

        <div className="stream" ref={streamRef}>
          {turns.length === 0 ? (
            <div className="empty">
              <p>Ask a question about MRR, ARR, retention, churn, revenue, or subscriptions over the H1 2025 dataset.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
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
            placeholder="e.g. What was our gross revenue retention over H1 2025?"
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
