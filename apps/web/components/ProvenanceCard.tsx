import type { Provenance } from "../lib/types";

function Grid({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) return <p className="def body">No source rows.</p>;
  const cols = Object.keys(rows[0]!);
  return (
    <div className="scroll">
      <table className="grid">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{String(r[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The trust surface: exact SQL, the metric definitions used, and sample source rows. */
export function ProvenanceCard({ provenance }: { provenance: Provenance }) {
  return (
    <details className="prov">
      <summary>How this was computed — SQL, metric definitions, and source rows</summary>

      <div className="prov-block">
        <h4>Metric definitions</h4>
        {provenance.metrics.map((m) => (
          <div className="def" key={m.key}>
            <span className="name">{m.key}</span> — <span className="body">{m.definition}</span>
          </div>
        ))}
      </div>

      <div className="prov-block">
        <h4>Executed SQL (read-only, validated)</h4>
        <pre className="sql">{provenance.compiledSql}</pre>
        <div className="def body">fingerprint: {provenance.sqlFingerprint.slice(0, 24)}…</div>
      </div>

      <div className="prov-block">
        <h4>Sample source rows</h4>
        <Grid rows={provenance.sampleRows ?? []} />
      </div>
    </details>
  );
}
