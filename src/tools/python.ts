import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import { fs, listFiles, notifyFsChange } from '../vfs/vfs';
import type { FromWorker, PyFile, PyInitTimings, PyRunResult, PyStats, ToWorker } from '../workers/pyodide-protocol';

/** Must match the installed `pyodide` npm package (only its types are bundled; runtime comes from indexURL). */
export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_CDN_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export interface PythonConfig {
  /**
   * Where pyodide.mjs, pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json and the wheels live.
   * Default: jsDelivr CDN. For self-hosting use e.g. './pyodide/' (resolved against document.baseURI,
   * so it works under /app/<slug>/). Can also be set with VITE_PYODIDE_INDEX_URL at build time.
   */
  indexURL: string;
  /**
   * Packages loaded right after the interpreter (prewarm). pyarrow must come before pandas: pandas
   * decides at import time whether pyarrow exists, so it can't be added after `import pandas`.
   */
  preload: string[];
  /** Max wall time for executing user code (excludes package loading), then the worker is killed. */
  timeoutMs: number;
  /** Max time for interpreter + preload download/init. */
  initTimeoutMs: number;
  /** Max chars of stdout/stderr captured in the worker. */
  maxOutputChars: number;
}

const config: PythonConfig = {
  indexURL: (import.meta.env.VITE_PYODIDE_INDEX_URL as string | undefined) ?? PYODIDE_CDN_URL,
  preload: ['numpy', 'pyarrow', 'pandas'],
  timeoutMs: 60_000,
  initTimeoutMs: 180_000,
  maxOutputChars: 20_000,
};

export function configurePython(c: Partial<PythonConfig>) {
  Object.assign(config, c);
}

export interface RunOutcome extends PyRunResult {
  /** True if the worker was killed (timeout/abort) and recreated; Python globals are lost. */
  restarted: boolean;
  /** True if this run is the first one in a fresh interpreter after an earlier restart. */
  freshAfterRestart: boolean;
  /** Ms spent syncing files main → worker → main (excluding exec). */
  syncMs: number;
  /** Ms waited for interpreter init (0 when already warm). */
  initWaitMs: number;
}

type Pending = { resolve: (m: FromWorker) => void };

class PythonClient {
  private worker: Worker | null = null;
  private ready: Promise<{ timings: PyInitTimings; version: string }> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** path → "size:mtime" of what the current worker's MEMFS holds. */
  private synced = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  generation = 0;
  private lastRunGeneration = 0;
  private execStart: ((id: number) => void) | null = null;

  start() {
    if (this.ready) return this.ready;
    const w = new Worker(new URL('../workers/pyodide.worker.ts', import.meta.url), { type: 'module', name: 'pyodide' });
    this.worker = w;
    this.synced.clear();
    this.generation++;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pyodide init timed out after ${config.initTimeoutMs} ms`)), config.initTimeoutMs);
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          resolve({ timings: m.timings, version: m.version });
        } else if (m.type === 'init-error') {
          clearTimeout(timer);
          reject(new Error(`Pyodide failed to load: ${m.error}`));
        } else if (m.type === 'exec-start') {
          this.execStart?.(m.id);
        } else if ('id' in m) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          p?.resolve(m);
        }
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`Pyodide worker error: ${e.message}`));
      };
    });
    // Avoid unhandled-rejection noise when nobody awaits a failed prewarm; callers still see the error.
    this.ready.catch(() => {});
    const indexURL = new URL(config.indexURL, document.baseURI).href;
    this.post({ type: 'init', indexURL, preload: config.preload });
    return this.ready;
  }

  /** Kill the worker (only way to stop running Python) and optionally boot a fresh one. */
  restart(rebootNow = true) {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) p.resolve({ type: 'loaded', id: -1, timings: {}, error: 'worker terminated' });
    this.pending.clear();
    this.synced.clear();
    if (rebootNow) this.start();
  }

  private post(m: ToWorker, transfer: Transferable[] = []) {
    this.worker!.postMessage(m, transfer);
  }

  private request<T extends FromWorker>(m: ToWorker & { id: number }, transfer: Transferable[] = []): Promise<T> {
    return new Promise((resolve) => {
      this.pending.set(m.id, { resolve: resolve as (m: FromWorker) => void });
      this.post(m, transfer);
    });
  }

  async loadPackages(packages: string[]) {
    await this.start();
    const r = await this.request<Extract<FromWorker, { type: 'loaded' }>>({ type: 'load', id: this.nextId++, packages });
    if (r.error) throw new Error(r.error);
    return r.timings;
  }

  async stats(): Promise<PyStats & { version: string }> {
    const { version } = await this.start();
    const r = await this.request<Extract<FromWorker, { type: 'stats' }>>({ type: 'stats', id: this.nextId++ });
    return { ...r.stats, version };
  }

  /** Runs are serialized: Python state is shared, so concurrent cells would race anyway. */
  run(code: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunOutcome> {
    const p = this.queue.then(() => this.runNow(code, opts));
    this.queue = p.catch(() => {});
    return p;
  }

  private async collectChanges(): Promise<{ files: PyFile[]; deletes: string[] }> {
    const files: PyFile[] = [];
    const seen = new Set<string>();
    for (const root of ['/data', '/work']) {
      for (const { path } of await listFiles(root)) {
        seen.add(path);
        const st = await fs.stat(path);
        const sig = `${st.size}:${+st.mtime}`;
        if (this.synced.get(path) === sig) continue;
        const bytes = await fs.readFileBuffer(path);
        // Copy: the VFS keeps its buffer, the worker gets a transferable one.
        files.push({ path, bytes: bytes.slice() });
        this.synced.set(path, sig);
      }
    }
    const deletes = [...this.synced.keys()].filter((p) => !seen.has(p));
    for (const p of deletes) this.synced.delete(p);
    return { files, deletes };
  }

  private async applyChanges(r: PyRunResult) {
    for (const f of r.changedFiles) {
      const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(f.path, f.bytes);
      const st = await fs.stat(f.path);
      this.synced.set(f.path, `${st.size}:${+st.mtime}`);
    }
    for (const p of r.deletedFiles) {
      if (await fs.exists(p)) await fs.rm(p);
      this.synced.delete(p);
    }
    if (r.changedFiles.length || r.deletedFiles.length) notifyFsChange();
  }

  private async runNow(code: string, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<RunOutcome> {
    const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
    const tInit = performance.now();
    await this.start();
    const initWaitMs = performance.now() - tInit;
    const freshAfterRestart = this.lastRunGeneration !== 0 && this.lastRunGeneration !== this.generation;
    this.lastRunGeneration = this.generation;

    const tSync = performance.now();
    const { files, deletes } = await this.collectChanges();
    let syncMs = performance.now() - tSync;
    const id = this.nextId++;

    let killed: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveKill: (m: FromWorker) => void = () => {};
    const killP = new Promise<FromWorker>((r) => (resolveKill = r));
    const kill = (why: string) => {
      if (killed) return;
      killed = why;
      this.restart(true);
      resolveKill({ type: 'loaded', id, timings: {} });
    };
    // Exec timeout starts when user code starts (package downloads don't count), with a generous
    // overall cap so a stuck package download can't hang forever.
    const overall = setTimeout(() => kill(`timed out (including package loading) after ${(timeoutMs + config.initTimeoutMs) / 1000}s`), timeoutMs + config.initTimeoutMs);
    this.execStart = (startedId) => {
      if (startedId === id) timer = setTimeout(() => kill(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
    };
    const onAbort = () => kill('aborted');
    opts.signal?.addEventListener('abort', onAbort);
    if (opts.signal?.aborted) onAbort();

    const t0 = performance.now();
    const msg = killed
      ? await killP
      : await Promise.race([
          this.request<FromWorker>({ type: 'run', id, code, files, deletes, maxOutput: config.maxOutputChars }, files.map((f) => f.bytes.buffer as ArrayBuffer)),
          killP,
        ]);
    clearTimeout(timer);
    clearTimeout(overall);
    this.execStart = null;
    opts.signal?.removeEventListener('abort', onAbort);

    if (killed || msg.type !== 'run-result') {
      const elapsed = performance.now() - t0;
      return {
        stdout: '', stderr: '', result: null,
        error: `Execution ${killed ?? 'failed'}. The Python worker was terminated and restarted: all Python variables/imports are lost (files in /data and /work are kept).`,
        changedFiles: [], deletedFiles: [], durationMs: elapsed, loadMs: 0, loadedPackages: [],
        restarted: true, freshAfterRestart, syncMs, initWaitMs,
      };
    }
    const r = msg.result;
    const tApply = performance.now();
    await this.applyChanges(r);
    syncMs += performance.now() - tApply;
    return { ...r, restarted: false, freshAfterRestart, syncMs, initWaitMs };
  }
}

let client: PythonClient | null = null;
export function getPythonClient(): PythonClient {
  return (client ??= new PythonClient());
}

/** Start downloading/initializing Pyodide + numpy/pandas in the background. Safe to call repeatedly. */
export function prewarmPython() {
  return getPythonClient().start();
}

function clip(s: string | null, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

export function createPythonTools(): AgentTool[] {
  const runPython: AgentTool<{ code: string }> = {
    name: 'run_python',
    description:
      'Execute Python 3 code in an in-browser Pyodide (CPython/WASM) sandbox. pandas and numpy are preloaded; ' +
      'pyarrow is available (pd.read_parquet works); other pure-Python/Pyodide packages are auto-loaded from imports. ' +
      'No network access. Files: query results are in /data/*.parquet, your workspace is /work (cwd). ' +
      'Write any output files (CSV, Parquet, JSON, PNG) to /work — they appear in the shared filesystem for the ' +
      'other tools. State persists between calls (variables, imports, DataFrames kept) unless the worker is ' +
      'restarted after a timeout (~60s). Print concise summaries (df.head(), df.describe(), aggregates), never ' +
      'whole large DataFrames; the value of the last expression is returned like in a notebook. Output is truncated.',
    inputSchema: z.object({
      code: z.string().describe('Python source to execute. The last expression\'s repr is returned.'),
    }),
    async execute({ code }, ctx) {
      const r = await getPythonClient().run(code, { signal: ctx.signal });
      const out: Record<string, unknown> = {};
      const stdout = clip(r.stdout, 4000);
      if (stdout) out.stdout = stdout;
      const result = clip(r.result, 2000);
      if (result) out.result = result;
      const stderr = clip(r.stderr, 1000);
      if (stderr) out.stderr = stderr;
      if (r.error) out.error = clip(r.error, 3000);
      if (r.changedFiles.length) out.newFiles = r.changedFiles.map((f) => ({ path: f.path, size: f.bytes.byteLength }));
      if (r.deletedFiles.length) out.deletedFiles = r.deletedFiles;
      if (r.freshAfterRestart) out.note = 'Python was restarted before this call; earlier variables were lost.';
      out.durationMs = Math.round(r.durationMs);
      return out;
    },
  };
  return [runPython];
}
