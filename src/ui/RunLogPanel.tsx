import type { ReactNode } from 'react';
import { downloadBlob, fmtMs, type RunLog } from './runlog';

const n = (x: number) => x.toLocaleString('en-US');

export function RunLogPanel({ runs, current }: { runs: RunLog[]; current?: RunLog }) {
  const run = current ?? runs[runs.length - 1];
  const exportAll = () =>
    downloadBlob(`agent-eval-runs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(runs, null, 2), 'application/json');

  // Interleave tool and step rows chronologically.
  type Row = { at: number; kind: 'tool' | 'step'; el: ReactNode };
  const rows: Row[] = [];
  if (run) {
    run.tools.forEach((t) =>
      rows.push({
        at: t.startedAt,
        kind: 'tool',
        el: (
          <tr key={`t${t.id}`} className={t.error ? 'err' : ''} data-testid="log-tool-row">
            <td>🔧 {t.name}</td>
            <td className="num">{t.durationMs != null ? fmtMs(t.durationMs) : '…'}</td>
            <td className="num">{t.outputChars != null ? n(t.outputChars) : ''}</td>
            <td />
          </tr>
        ),
      }),
    );
    run.steps.forEach((s) =>
      rows.push({
        at: s.at - 0.5,
        kind: 'step',
        el: (
          <tr key={`s${s.step}`} className="step-row" data-testid="log-step-row">
            <td>step {s.step}</td>
            <td className="num">{fmtMs(s.durationMs)}</td>
            <td />
            <td className="num">
              {n(s.usage.inputTokens)} / {n(s.usage.outputTokens)}
              {s.usage.cachedInputTokens ? <small> ({n(s.usage.cachedInputTokens)} cached)</small> : null}
            </td>
          </tr>
        ),
      }),
    );
    rows.sort((a, b) => a.at - b.at);
  }

  return (
    <aside className="pane log" data-testid="run-log">
      <div className="pane-head">
        <span>Run log</span>
        <button className="small" onClick={exportAll} disabled={!runs.length} data-testid="export-log">
          Export run log (JSON)
        </button>
      </div>
      {!run ? (
        <div className="muted">No runs yet.</div>
      ) : (
        <>
          <div className="run-meta">
            <div><b>{run.harnessId}</b> · {run.model}</div>
            <div className={`status ${run.status}`} data-testid="run-status">{run.status}</div>
          </div>
          <dl className="totals" data-testid="totals">
            <dt>Tokens in / out</dt>
            <dd data-testid="total-tokens">
              {n(run.totals.usage.inputTokens)} / {n(run.totals.usage.outputTokens)}
            </dd>
            <dt>Cached input</dt>
            <dd>{n(run.totals.usage.cachedInputTokens ?? 0)}</dd>
            <dt>Steps</dt>
            <dd data-testid="total-steps">{run.totals.steps}</dd>
            <dt>Tool calls</dt>
            <dd>{run.totals.toolCalls}{run.totals.toolErrors ? ` (${run.totals.toolErrors} err)` : ''}</dd>
            <dt>Wall time</dt>
            <dd data-testid="total-wall">{fmtMs(run.totals.wallMs)}</dd>
            <dt>Tool time</dt>
            <dd>{fmtMs(run.totals.toolMs)}</dd>
            <dt>LLM + harness</dt>
            <dd>{fmtMs(run.totals.llmMs)}</dd>
            <dt>Tool output chars</dt>
            <dd>{n(run.totals.outputChars)}</dd>
          </dl>
          {run.error && <div className="error">{run.error}</div>}
          <table className="log-table">
            <thead>
              <tr><th>event</th><th className="num">time</th><th className="num">out ch</th><th className="num">tok in/out</th></tr>
            </thead>
            <tbody>{rows.map((r) => r.el)}</tbody>
          </table>
        </>
      )}
      {runs.length > 1 && (
        <div className="history">
          <div className="label">Session runs ({runs.length})</div>
          <table className="log-table">
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.harnessId}</td>
                  <td>{r.status}</td>
                  <td className="num">{fmtMs(r.totals.wallMs)}</td>
                  <td className="num">{n(r.totals.usage.inputTokens + r.totals.usage.outputTokens)} tok</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}
