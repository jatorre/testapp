import { Bash, InMemoryFs } from 'just-bash/browser';

/**
 * Single shared virtual filesystem for the whole page. just-bash, DuckDB-WASM and
 * Pyodide all read/write through this; the file panel subscribes to changes.
 * Convention: query results land in /data, scratch/outputs in /work.
 */
export const fs = new InMemoryFs();
export const bash = new Bash({ fs, cwd: '/work' });

type Listener = () => void;
const listeners = new Set<Listener>();
export function onFsChange(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function notifyFsChange() {
  listeners.forEach((l) => l());
}

export async function writeFile(path: string, data: string | Uint8Array) {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, data);
  notifyFsChange();
}
export async function readText(path: string): Promise<string> {
  return fs.readFile(path);
}
export async function readBytes(path: string): Promise<Uint8Array> {
  return fs.readFileBuffer(path);
}

export interface FileEntry { path: string; size: number }
export async function listFiles(root = '/'): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (dir: string) => {
    for (const name of await fs.readdir(dir)) {
      const p = dir === '/' ? `/${name}` : `${dir}/${name}`;
      const st = await fs.stat(p);
      if (st.isDirectory) await walk(p);
      else out.push({ path: p, size: st.size });
    }
  };
  if (await fs.exists(root)) await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

await fs.mkdir('/data', { recursive: true });
await fs.mkdir('/work', { recursive: true });
