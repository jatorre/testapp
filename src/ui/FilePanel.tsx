import { useCallback, useEffect, useState } from 'react';
import { isBinaryFile } from '../tools/fs';
import { fs, listFiles, notifyFsChange, onFsChange, readBytes, readText, type FileEntry } from '../vfs/vfs';
import { downloadBlob, fmtBytes } from './runlog';

type Preview =
  | { path: string; kind: 'text'; text: string; truncated: boolean }
  | { path: string; kind: 'table'; header: string[]; rows: string[][]; total: number }
  | { path: string; kind: 'binary'; size: number }
  | { path: string; kind: 'error'; message: string };

/** Minimal CSV line splitter with quote support (preview only). */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function loadPreview(path: string): Promise<Preview> {
  try {
    if (await isBinaryFile(path)) return { path, kind: 'binary', size: (await fs.stat(path)).size };
    const text = await readText(path);
    if (/\.(csv|tsv)$/i.test(path)) {
      const sep = path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
      const lines = text.split('\n').filter((l) => l.length);
      return {
        path,
        kind: 'table',
        header: splitCsvLine(lines[0] ?? '', sep),
        rows: lines.slice(1, 21).map((l) => splitCsvLine(l, sep)),
        total: Math.max(0, lines.length - 1),
      };
    }
    const max = 20000;
    return { path, kind: 'text', text: text.slice(0, max), truncated: text.length > max };
  } catch (e) {
    return { path, kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

export function FilePanel() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);

  const refresh = useCallback(async () => {
    const list = (await listFiles('/')).filter((f) => !/^\/(bin|usr|dev|proc)\//.test(f.path));
    setFiles(list);
    setPreview((p) => (p && !list.some((f) => f.path === p.path) ? null : p));
  }, []);

  useEffect(() => {
    refresh();
    const off = onFsChange(() => void refresh());
    return () => void off();
  }, [refresh]);

  // Keep an open preview in sync with file changes.
  useEffect(() => {
    if (!preview) return;
    const off = onFsChange(() => {
      void fs.exists(preview.path).then(async (ok) => { if (ok) setPreview(await loadPreview(preview.path)); });
    });
    return () => void off();
  }, [preview?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = async (path: string) => {
    downloadBlob(path.split('/').pop() || 'file', (await readBytes(path)) as BlobPart);
  };

  const reset = async () => {
    for (const dir of await fs.readdir('/')) await fs.rm(`/${dir}`, { recursive: true, force: true });
    await fs.mkdir('/data', { recursive: true });
    await fs.mkdir('/work', { recursive: true });
    setPreview(null);
    notifyFsChange();
  };

  const total = files.reduce((n, f) => n + f.size, 0);
  return (
    <aside className="pane files" data-testid="file-panel">
      <div className="pane-head">
        <span>Files <small>({files.length}, {fmtBytes(total)})</small></span>
        <button className="small" onClick={reset} data-testid="reset-fs" title="Delete everything in the virtual FS">
          Reset FS
        </button>
      </div>
      <ul className="file-list">
        {files.length === 0 && <li className="muted">Empty. Files the agent writes appear here.</li>}
        {files.map((f) => {
          const depth = f.path.split('/').length - 2;
          return (
            <li
              key={f.path}
              className={preview?.path === f.path ? 'active' : ''}
              style={{ paddingLeft: 6 + depth * 10 }}
              data-testid="file-entry"
              data-path={f.path}
            >
              <button className="link file-name" onClick={() => loadPreview(f.path).then(setPreview)} title={f.path}>
                {f.path}
              </button>
              <span className="size">{fmtBytes(f.size)}</span>
              <button className="icon" onClick={() => download(f.path)} title="Download" aria-label={`Download ${f.path}`}>
                ⤓
              </button>
            </li>
          );
        })}
      </ul>
      {preview && (
        <div className="preview" data-testid="file-preview">
          <div className="pane-head">
            <span className="mono">{preview.path}</span>
            <button className="icon" onClick={() => setPreview(null)} aria-label="Close preview">×</button>
          </div>
          {preview.kind === 'text' && (
            <pre>{preview.text}{preview.truncated && '\n…[truncated]'}</pre>
          )}
          {preview.kind === 'table' && (
            <div className="table-wrap">
              <table>
                <thead><tr>{preview.header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
              </table>
              <div className="muted">{Math.min(20, preview.total)} of {preview.total} rows</div>
            </div>
          )}
          {preview.kind === 'binary' && (
            <div className="muted">Binary file ({fmtBytes(preview.size)}). Query it with DuckDB or Python, or download it.</div>
          )}
          {preview.kind === 'error' && <div className="error">{preview.message}</div>}
        </div>
      )}
    </aside>
  );
}
