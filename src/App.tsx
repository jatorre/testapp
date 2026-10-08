import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HARNESSES } from './agent/harnesses';
import { getCartoInfo, type CartoInfo } from './carto/info';
import { DEMOS } from './demos';
import { writeFile as vfsWriteFile } from './vfs/vfs';
import { Chat } from './ui/Chat';
import { FilePanel } from './ui/FilePanel';
import { RunLogPanel } from './ui/RunLogPanel';
import { TopBar } from './ui/TopBar';
import { applyEventToMessage, type RunLog, type ToolRow, type UiMessage } from './ui/runlog';
import { executeRun, loadDemoTools, msg, runEval, type EvalRequest, type ToolLoad } from './ui/runner';

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

declare global {
  interface Window {
    /** Headless batch-eval hook: runs one prompt and resolves with the run log. */
    __runEval?: (req: EvalRequest) => Promise<RunLog>;
    __evalInfo?: { demos: string[]; harnesses: string[]; models: string[] };
    __runLogs?: RunLog[];
    /** Dev-only: seed files into the VFS for eval scenarios (e.g. prompt-injection probes). */
    __seedFile?: (path: string, content: string) => Promise<void>;
  }
}

async function fetchModels(info: CartoInfo): Promise<string[]> {
  const res = await fetch(`${info.aiBaseUrl}/models`, { headers: { Authorization: `Bearer ${info.accessToken}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return ((j.data ?? []) as { id: string }[]).map((m) => m.id).sort();
}

export default function App() {
  const params = new URLSearchParams(location.search);
  const [info, setInfo] = useState<CartoInfo>();
  const [infoError, setInfoError] = useState<string>();
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string>();
  const [model, setModel] = useState<string>(params.get('model') || store.get('model') || '');
  const [harnessId, setHarnessId] = useState(params.get('harness') || store.get('harness') || HARNESSES[0].id);
  const [demoId, setDemoId] = useState(params.get('demo') || store.get('demo') || DEMOS[0].id);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [runs, setRuns] = useState<RunLog[]>([]);
  const [current, setCurrent] = useState<RunLog>();
  const [toolLoad, setToolLoad] = useState<ToolLoad>();
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const demo = DEMOS.find((d) => d.id === demoId) ?? DEMOS[0];

  useEffect(() => {
    let gotInfo = false;
    getCartoInfo()
      .then(async (i) => {
        gotInfo = true;
        setInfo(i);
        if (!i.aiBaseUrl) throw new Error('No aiBaseUrl configured');
        const list = await fetchModels(i);
        setModels(list);
        setModel((m) => {
          if (m && list.includes(m)) return m;
          const def = import.meta.env.VITE_DEFAULT_MODEL as string | undefined;
          return def || list[0] || m;
        });
      })
      .catch((e) => (gotInfo ? setModelsError(msg(e)) : setInfoError(msg(e))));
  }, []);

  useEffect(() => {
    setToolLoad(undefined);
    let live = true;
    loadDemoTools(demo).then((t) => live && setToolLoad(t));
    return () => {
      live = false;
    };
  }, [demo]);

  // Pyodide takes seconds to boot: start it in the background as soon as a python demo is selected.
  useEffect(() => {
    if (demo.tools.includes('python')) import('./tools/python').then((m) => m.prewarmPython()).catch(() => {});
  }, [demo]);

  // MCP connection diagnostics (demo 2): refresh after tools load and after each run.
  const [mcpDiag, setMcpDiag] = useState<unknown>();
  useEffect(() => {
    if (!demo.tools.includes('mcp') || !toolLoad) return setMcpDiag(undefined);
    import('./tools/mcp').then((m) => setMcpDiag(m.getMcpDiagnostics())).catch((e) => setMcpDiag({ ok: false, error: msg(e) }));
  }, [demo, toolLoad, runs.length]);

  useEffect(() => store.set('harness', harnessId), [harnessId]);
  useEffect(() => store.set('demo', demoId), [demoId]);
  useEffect(() => void (model && store.set('model', model)), [model]);

  const addRun = useCallback((r: RunLog) => {
    setRuns((rs) => {
      const next = [...rs.filter((x) => x.id !== r.id), r];
      window.__runLogs = next;
      return next;
    });
  }, []);

  // Batch-eval hook for Playwright-driven comparisons.
  if (import.meta.env.DEV) window.__seedFile = vfsWriteFile;
  useEffect(() => {
    window.__runEval = async (req) => {
      const r = await runEval(req, setCurrent);
      addRun(r);
      return r;
    };
    window.__evalInfo = { demos: DEMOS.map((d) => d.id), harnesses: HARNESSES.map((h) => h.id), models };
  }, [models, addRun]);

  const send = async (prompt: string) => {
    const history = messages.filter((m) => m.text.trim()).map((m) => ({ role: m.role, content: m.text }));
    setMessages((ms) => [...ms, { role: 'user', text: prompt, parts: [] }, { role: 'assistant', text: '', parts: [] }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    const run = await executeRun({
      demo,
      harnessId,
      model,
      prompt,
      history,
      signal: ctrl.signal,
      onRun: setCurrent,
      onEvent: (e) =>
        setMessages((ms) => {
          const copy = ms.slice();
          copy[copy.length - 1] = applyEventToMessage(copy[copy.length - 1], e);
          return copy;
        }),
    });
    setMessages((ms) => {
      const copy = ms.slice();
      copy[copy.length - 1] = { ...copy[copy.length - 1], runId: run.id };
      return copy;
    });
    addRun(run);
    setCurrent(undefined);
    setRunning(false);
    abortRef.current = null;
  };

  const toolRows = useMemo(() => {
    const m = new Map<string, ToolRow>();
    for (const r of current ? [...runs, current] : runs) for (const t of r.tools) m.set(t.id, t);
    return m;
  }, [runs, current]);

  const errors: string[] = [];
  if (infoError) errors.push(`Connection: ${infoError}`);
  if (toolLoad) for (const [g, e] of Object.entries(toolLoad.errors)) errors.push(`Tool group "${g}" unavailable: ${e}`);
  const lastRun = current ?? runs[runs.length - 1];
  if (lastRun?.status === 'error' && lastRun.error && !running) errors.push(`Run failed: ${lastRun.error}`);

  const disabledReason = infoError
    ? 'Not connected (see error below)'
    : !info?.aiBaseUrl
      ? 'Connecting…'
      : !model
        ? 'No model selected'
        : !toolLoad
          ? 'Loading tools…'
          : undefined;

  return (
    <div className="app">
      <TopBar
        demos={DEMOS}
        demoId={demo.id}
        onDemo={(id) => {
          setDemoId(id);
          setMessages([]);
        }}
        harnesses={HARNESSES}
        harnessId={harnessId}
        onHarness={setHarnessId}
        models={models}
        model={model}
        onModel={setModel}
        modelsError={modelsError}
        info={info}
        infoError={infoError}
        running={running}
      />
      <div className="tools-bar" data-testid="tools-bar">
        <span className="label">Tools:</span>{' '}
        {toolLoad ? toolLoad.tools.map((t) => <code key={t.name}>{t.name}</code>) : <span className="muted">loading…</span>}
        <span className="muted"> · max {demo.maxSteps} steps</span>
        {mcpDiag != null && (
          <details className="diag" data-testid="mcp-diagnostics">
            <summary>
              MCP: {(mcpDiag as { ok?: boolean }).ok ? 'connected' : 'not connected'}
              {(mcpDiag as { toolCount?: number }).toolCount != null && ` · ${(mcpDiag as { toolCount: number }).toolCount} tools`}
            </summary>
            <pre>{JSON.stringify(mcpDiag, null, 2)}</pre>
          </details>
        )}
      </div>
      <div className="panes">
        <FilePanel />
        <Chat
          messages={messages}
          toolRows={toolRows}
          suggestions={demo.suggestions}
          running={running}
          disabledReason={disabledReason}
          errors={errors}
          blurb={demo.blurb}
          onSend={send}
          onStop={() => abortRef.current?.abort()}
          onClear={() => setMessages([])}
        />
        <RunLogPanel runs={runs} current={current} />
      </div>
    </div>
  );
}
