import type { Harness } from '../agent/types';
import type { CartoInfo } from '../carto/info';
import type { Demo } from '../demos';

export interface TopBarProps {
  demos: Demo[];
  demoId: string;
  onDemo: (id: string) => void;
  harnesses: Harness[];
  harnessId: string;
  onHarness: (id: string) => void;
  models: string[];
  model: string;
  onModel: (m: string) => void;
  modelsError?: string;
  info?: CartoInfo;
  infoError?: string;
  running: boolean;
}

function expiry(info: CartoInfo): string {
  if (!info.expiresAt) return 'no expiry info';
  const ms = info.expiresAt < 1e12 ? info.expiresAt * 1000 : info.expiresAt;
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins < 0) return 'token expired';
  return mins > 120 ? `expires in ${Math.round(mins / 60)}h` : `expires in ${mins}m`;
}

export function TopBar(p: TopBarProps) {
  const ok = !!p.info && !p.infoError;
  return (
    <header className="topbar">
      <div className="row">
        <strong className="brand">Browser Agent Eval</strong>
        <label>
          Harness
          <select value={p.harnessId} onChange={(e) => p.onHarness(e.target.value)} disabled={p.running} data-testid="harness-select">
            {p.harnesses.map((h) => (
              <option key={h.id} value={h.id}>{h.label}</option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select value={p.model} onChange={(e) => p.onModel(e.target.value)} disabled={p.running} data-testid="model-select">
            {!p.models.includes(p.model) && p.model && <option value={p.model}>{p.model}</option>}
            {p.models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        {p.modelsError && <span className="error small-text" title={p.modelsError}>models: {p.modelsError.slice(0, 60)}</span>}
        <span className="spacer" />
        <span
          className={`conn ${ok ? 'ok' : 'bad'}`}
          data-testid="connection"
          title={p.infoError ?? `${p.info?.apiBaseUrl}\nAI: ${p.info?.aiBaseUrl ?? '(none)'}`}
        >
          <span className="dot" />
          {p.infoError
            ? 'not connected'
            : p.info
              ? `${p.info.source} · ${p.info.user?.email ?? 'local dev'} · ${expiry(p.info)}`
              : 'connecting…'}
        </span>
      </div>
      <nav className="tabs" role="tablist">
        {p.demos.map((d) => (
          <button
            key={d.id}
            role="tab"
            aria-selected={d.id === p.demoId}
            className={d.id === p.demoId ? 'tab active' : 'tab'}
            onClick={() => p.onDemo(d.id)}
            disabled={p.running}
            title={d.blurb}
            data-testid={`demo-tab-${d.id}`}
          >
            {d.title}
          </button>
        ))}
      </nav>
    </header>
  );
}
