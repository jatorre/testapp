/** Message protocol between src/tools/python.ts (main thread) and pyodide.worker.ts. */

export interface PyFile {
  path: string;
  bytes: Uint8Array;
}

export interface PyInitTimings {
  /** pyodide.mjs import + loadPyodide() (downloads wasm + stdlib, instantiates). */
  coreMs: number;
  /** Per-package load time (ms), in the order they were loaded. */
  packages: Record<string, number>;
}

export type ToWorker =
  | { type: 'init'; indexURL: string; preload: string[] }
  | { type: 'load'; id: number; packages: string[] }
  | {
      type: 'run';
      id: number;
      code: string;
      /** Files to (over)write into MEMFS before running. */
      files: PyFile[];
      /** Paths to delete from MEMFS before running (deleted on the main-thread VFS). */
      deletes: string[];
      /** Max chars of stdout / stderr kept. */
      maxOutput: number;
    }
  | { type: 'stats'; id: number };

export interface PyRunResult {
  stdout: string;
  stderr: string;
  /** repr() of the last expression (null if the cell ends in a statement / `;`). */
  result: string | null;
  /** Trimmed traceback, or null on success. */
  error: string | null;
  /** Files under /data or /work created or modified by the run. */
  changedFiles: PyFile[];
  /** Files under /data or /work removed by the run. */
  deletedFiles: string[];
  /** Time spent executing user code (excludes file sync + package loading). */
  durationMs: number;
  /** Time spent loading packages detected from imports for this run. */
  loadMs: number;
  loadedPackages: string[];
}

export interface PyStats {
  wasmHeapBytes: number;
  timings: PyInitTimings;
  loadedPackages: string[];
}

export type FromWorker =
  | { type: 'ready'; timings: PyInitTimings; version: string }
  | { type: 'init-error'; error: string }
  | { type: 'loaded'; id: number; timings: Record<string, number>; error?: string }
  /** Sent once file sync + package loading is done and user code starts executing (starts the exec timeout). */
  | { type: 'exec-start'; id: number }
  | { type: 'run-result'; id: number; result: PyRunResult }
  | { type: 'stats'; id: number; stats: PyStats };
