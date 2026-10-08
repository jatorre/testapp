// Test harness page for the run_python tool. Exposes window.__pyTest for Playwright.
import { configurePython, createPythonTools, getPythonClient, prewarmPython } from '../../src/tools/python';
import { fs, listFiles, notifyFsChange, readBytes, writeFile } from '../../src/vfs/vfs';

const params = new URLSearchParams(location.search);
if (params.get('indexURL')) configurePython({ indexURL: params.get('indexURL')! });

const [tool] = createPythonTools();

const api = {
  configure: configurePython,
  prewarm: async () => {
    const t0 = performance.now();
    const r = await prewarmPython();
    return { ...r, wallMs: performance.now() - t0 };
  },
  run: async (code: string, opts: { timeoutMs?: number } = {}) => {
    const r = await getPythonClient().run(code, opts);
    return { ...r, changedFiles: r.changedFiles.map((f) => ({ path: f.path, size: f.bytes.byteLength })) };
  },
  /** Through the AgentTool interface, i.e. exactly what the model sees. */
  tool: (code: string) => tool.execute({ code }, { emitArtifact: () => {} }),
  toolMeta: () => ({ name: tool.name, description: tool.description }),
  loadPackages: (p: string[]) => getPythonClient().loadPackages(p),
  stats: () => getPythonClient().stats(),
  restart: () => getPythonClient().restart(true),
  writeFile: (path: string, data: string | number[]) =>
    writeFile(path, typeof data === 'string' ? data : new Uint8Array(data)),
  writeFixture: async (path: string, url: string) => {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    await writeFile(path, buf);
    return buf.byteLength;
  },
  readText: async (path: string) => new TextDecoder().decode(await readBytes(path)),
  exists: (path: string) => fs.exists(path),
  rm: async (path: string) => {
    await fs.rm(path);
    notifyFsChange();
  },
  listFiles,
  jsHeap: () => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize } : null;
  },
};

(window as unknown as { __pyTest: typeof api }).__pyTest = api;
document.getElementById('status')!.textContent = 'ready';
