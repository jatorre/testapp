/**
 * Pyodide (CPython on WASM) in a dedicated worker. The main thread (src/tools/python.ts) owns
 * the shared VFS; before each run it ships changed /data + /work files here, and we send back
 * whatever the user code created/modified/deleted under those roots.
 *
 * Stopping a runaway Python loop is only possible by terminating this worker (no
 * SharedArrayBuffer interrupt buffer, since hosted apps are not cross-origin isolated).
 */
import type { PyodideAPI } from 'pyodide';
import type { FromWorker, PyFile, PyInitTimings, PyRunResult, ToWorker } from './pyodide-protocol';

const SYNC_ROOTS = ['/data', '/work'];

const scope = self as unknown as {
  postMessage: (m: FromWorker, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

let py: PyodideAPI | null = null;
const timings: PyInitTimings = { coreMs: 0, packages: {} };
const loaded = new Set<string>();

// Output capture: batched handlers append into capped buffers for the current run.
let outBuf = '';
let errBuf = '';
let maxOut = 20000;
const append = (buf: string, s: string) => (buf.length >= maxOut ? buf : (buf + s + '\n').slice(0, maxOut + 1));

const HELPER = String.raw`
import os, sys, traceback
os.environ.setdefault("MPLBACKEND", "Agg")
for _d in ("/data", "/work"):
    os.makedirs(_d, exist_ok=True)
os.chdir("/work")
from pyodide.code import eval_code_async as _eval

_user_ns = {"__name__": "__main__", "__builtins__": __builtins__}

def _fmt_exc(e):
    tb = e.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != "<cell>":
        tb = tb.tb_next
    lines = "".join(traceback.format_exception(type(e), e, tb)).rstrip().split("\n")
    if len(lines) > 40:
        lines = lines[:8] + ["  ... (%d lines omitted) ..." % (len(lines) - 33)] + lines[-25:]
    return "\n".join(lines)

async def _run_cell(code):
    try:
        r = await _eval(code, _user_ns, filename="<cell>")
    except BaseException as e:
        return (None, _fmt_exc(e))
    if r is None:
        return (None, None)
    try:
        s = repr(r)
    except Exception as e:
        s = "<repr failed: %r>" % (e,)
    return (s, None)

def _configure_pandas():
    import pandas as pd
    pd.set_option("display.max_rows", 30)
    pd.set_option("display.max_columns", 20)
    pd.set_option("display.width", 140)
`;

async function loadPkgs(names: string[]): Promise<Record<string, number>> {
  const t: Record<string, number> = {};
  for (const n of names) {
    if (loaded.has(n)) continue;
    const t0 = performance.now();
    await py!.loadPackage(n, { messageCallback: () => {}, errorCallback: (m) => (errBuf = append(errBuf, m)) });
    if (n === 'pandas') {
      const t1 = performance.now();
      t['pandas'] = t1 - t0;
      py!.runPython('_configure_pandas()');
      t['import pandas'] = performance.now() - t1;
    } else {
      t[n] = performance.now() - t0;
    }
    loaded.add(n);
  }
  Object.assign(timings.packages, t);
  return t;
}

async function init(indexURL: string, preload: string[]) {
  const t0 = performance.now();
  const mod = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as typeof import('pyodide');
  py = await mod.loadPyodide({ indexURL });
  py.setStdout({ batched: (s) => (outBuf = append(outBuf, s)) });
  py.setStderr({ batched: (s) => (errBuf = append(errBuf, s)) });
  py.runPython(HELPER);
  timings.coreMs = performance.now() - t0;
  await loadPkgs(preload);
  post({ type: 'ready', timings, version: py.version });
}

// ---- MEMFS helpers -------------------------------------------------------------------------

type Sig = Map<string, string>;

function walk(root: string, out: Sig) {
  const FS = py!.FS;
  if (!FS.analyzePath(root).exists) return;
  for (const name of FS.readdir(root) as string[]) {
    if (name === '.' || name === '..') continue;
    const p = `${root}/${name}`;
    const st = FS.stat(p);
    if (FS.isDir(st.mode)) walk(p, out);
    else if (FS.isFile(st.mode)) out.set(p, `${st.size}:${+new Date(st.mtime)}`);
  }
}
function snapshot(): Sig {
  const s: Sig = new Map();
  for (const r of SYNC_ROOTS) walk(r, s);
  return s;
}
function writeIn(f: PyFile) {
  const FS = py!.FS;
  FS.mkdirTree(f.path.slice(0, f.path.lastIndexOf('/')) || '/');
  FS.writeFile(f.path, f.bytes);
  // Epoch mtime: any write by user code (even same-millisecond, same-size) changes the signature.
  FS.utime(f.path, 0, 0);
}

const PARQUET_HINT = /parquet|pyarrow|feather|\.arrow\b/i;

async function run(msg: Extract<ToWorker, { type: 'run' }>): Promise<PyRunResult> {
  const FS = py!.FS;
  maxOut = msg.maxOutput;
  outBuf = '';
  errBuf = '';
  for (const p of msg.deletes) if (FS.analyzePath(p).exists) FS.unlink(p);
  for (const f of msg.files) writeIn(f);
  const before = snapshot();

  // Lazy package loading: imports in the code (+ pyarrow when parquet is mentioned, since
  // pandas.read_parquet imports it internally and loadPackagesFromImports can't see that).
  const tl = performance.now();
  const newly: string[] = [];
  const beforePk = new Set(Object.keys(py!.loadedPackages));
  try {
    await py!.loadPackagesFromImports(msg.code, { messageCallback: () => {}, errorCallback: () => {} });
    const extra: string[] = [];
    if (PARQUET_HINT.test(msg.code) && !loaded.has('pyarrow')) extra.push('pyarrow');
    if (/\bpandas\b|\bpd\./.test(msg.code) && !loaded.has('pandas')) extra.unshift('pandas');
    await loadPkgs(extra);
  } catch (e) {
    errBuf = append(errBuf, `package load failed: ${e}`);
  }
  for (const k of Object.keys(py!.loadedPackages)) if (!beforePk.has(k)) newly.push(k);
  const loadMs = performance.now() - tl;

  post({ type: 'exec-start', id: msg.id });
  const t0 = performance.now();
  const runCell = py!.globals.get('_run_cell');
  const r = await runCell(msg.code);
  runCell.destroy();
  const tuple = r.toJs() as [string | null, string | null];
  r.destroy();
  const durationMs = performance.now() - t0;

  const after = snapshot();
  const changedFiles: PyFile[] = [];
  for (const [p, sig] of after) {
    if (before.get(p) !== sig) changedFiles.push({ path: p, bytes: FS.readFile(p) as Uint8Array });
  }
  const deletedFiles = [...before.keys()].filter((p) => !after.has(p));
  // Rebase signatures so the next run doesn't resend these as changed.
  for (const f of changedFiles) FS.utime(f.path, 0, 0);

  return {
    stdout: outBuf,
    stderr: errBuf,
    result: tuple[0],
    error: tuple[1],
    changedFiles,
    deletedFiles,
    durationMs,
    loadMs,
    loadedPackages: newly,
  };
}

// ---- message loop (serialized) --------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
scope.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    if (msg.type === 'init') {
      try {
        await init(msg.indexURL, msg.preload);
      } catch (err) {
        post({ type: 'init-error', error: String((err as Error)?.stack ?? err) });
      }
    } else if (msg.type === 'load') {
      try {
        post({ type: 'loaded', id: msg.id, timings: await loadPkgs(msg.packages) });
      } catch (err) {
        post({ type: 'loaded', id: msg.id, timings: {}, error: String(err) });
      }
    } else if (msg.type === 'run') {
      let result: PyRunResult;
      try {
        result = await run(msg);
      } catch (err) {
        result = {
          stdout: outBuf, stderr: errBuf, result: null, error: `Internal error: ${err}`,
          changedFiles: [], deletedFiles: [], durationMs: 0, loadMs: 0, loadedPackages: [],
        };
      }
      post({ type: 'run-result', id: msg.id, result }, result.changedFiles.map((f) => f.bytes.buffer as ArrayBuffer));
    } else if (msg.type === 'stats') {
      const heap = (py as unknown as { _module?: { HEAP8?: Int8Array } })?._module?.HEAP8?.byteLength ?? 0;
      post({ type: 'stats', id: msg.id, stats: { wasmHeapBytes: heap, timings, loadedPackages: Object.keys(py?.loadedPackages ?? {}) } });
    }
  });
};
