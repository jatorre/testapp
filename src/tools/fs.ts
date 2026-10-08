import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import { bash, fs, listFiles, notifyFsChange, readBytes, writeFile } from '../vfs/vfs';

const MAX_STREAM_CHARS = 6000;
const DEFAULT_READ_LINES = 400;

function clip(s: string, max = MAX_STREAM_CHARS) {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

const BINARY_EXT = /\.(parquet|arrow|feather|duckdb|db|sqlite|png|jpe?g|gif|webp|pdf|zip|gz|xlsx|pkl|npy|wasm)$/i;

/** Binary if known extension or contains NUL bytes in the first 8 KB. */
export async function isBinaryFile(path: string): Promise<boolean> {
  if (BINARY_EXT.test(path)) return true;
  const bytes = await readBytes(path);
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function abs(p: string) {
  return p.startsWith('/') ? p : `/work/${p}`;
}

export function createFsTools(): AgentTool[] {
  const bashTool: AgentTool<{ command: string }> = {
    name: 'bash',
    description:
      'Run a command in a sandboxed in-browser bash (just-bash). cwd is /work. Supports pipes, redirects and coreutils ' +
      '(ls, cat, head, tail, grep, sed, awk, jq, sort, uniq, wc, cut, tr, find, mkdir, cp, mv, rm...). ' +
      'No network, no real processes. Output is truncated.',
    inputSchema: z.object({ command: z.string().describe('The bash command line to run') }),
    async execute({ command }, ctx) {
      try {
        const r = await bash.exec(command, { cwd: '/work', signal: ctx.signal });
        return { stdout: clip(r.stdout), stderr: clip(r.stderr, 2000), exitCode: r.exitCode };
      } finally {
        notifyFsChange();
      }
    },
  };

  const readFileTool: AgentTool<{ path: string; offset?: number; limit?: number }> = {
    name: 'read_file',
    description:
      'Read a text file from the virtual filesystem. Returns numbered lines. Use offset (0-based line) and limit ' +
      `(default ${DEFAULT_READ_LINES}) to page through large files. Binary files (e.g. Parquet) cannot be read; ` +
      'query them with duckdb_query or run_python instead.',
    inputSchema: z.object({
      path: z.string().describe('Absolute path, e.g. /work/notes.md'),
      offset: z.number().int().min(0).optional().describe('First line to return (0-based)'),
      limit: z.number().int().min(1).max(5000).optional().describe('Max lines to return'),
    }),
    async execute({ path, offset = 0, limit = DEFAULT_READ_LINES }) {
      path = abs(path);
      if (!(await fs.exists(path))) throw new Error(`File not found: ${path}`);
      if ((await fs.stat(path)).isDirectory) throw new Error(`${path} is a directory; use list_files`);
      if (await isBinaryFile(path)) {
        return `${path} is a binary file (${(await fs.stat(path)).size} bytes) and cannot be read as text. ` +
          'Use duckdb_query (e.g. SELECT * FROM \'' + path + '\' LIMIT 10) or run_python (pandas.read_parquet) instead.';
      }
      const lines = (await fs.readFile(path)).split('\n');
      const slice = lines.slice(offset, offset + limit);
      const body = slice.map((l, i) => `${String(offset + i + 1).padStart(5)}\t${l}`).join('\n');
      const more = offset + limit < lines.length ? `\n…[${lines.length - offset - limit} more lines; use offset=${offset + limit}]` : '';
      return clip(body) + more;
    },
  };

  const writeFileTool: AgentTool<{ path: string; content: string }> = {
    name: 'write_file',
    description: 'Create or overwrite a text file (parent directories are created). Prefer /work for outputs.',
    inputSchema: z.object({
      path: z.string().describe('Absolute path, e.g. /work/report.md'),
      content: z.string().describe('Full file content'),
    }),
    async execute({ path, content }) {
      path = abs(path);
      await writeFile(path, content);
      return `Wrote ${content.length} chars (${content.split('\n').length} lines) to ${path}`;
    },
  };

  const listFilesTool: AgentTool<{ path?: string; recursive?: boolean }> = {
    name: 'list_files',
    description: 'List files in a directory of the virtual filesystem with sizes in bytes.',
    inputSchema: z.object({
      path: z.string().optional().describe('Directory, default /'),
      recursive: z.boolean().optional().describe('Recurse into subdirectories (default true)'),
    }),
    async execute({ path = '/', recursive = true }) {
      path = abs(path);
      if (!(await fs.exists(path))) throw new Error(`Directory not found: ${path}`);
      if (recursive) {
        const files = await listFiles(path);
        if (!files.length) return `(no files under ${path})`;
        return clip(files.map((f) => `${f.size}\t${f.path}`).join('\n'));
      }
      const out: string[] = [];
      for (const name of await fs.readdir(path)) {
        const p = path === '/' ? `/${name}` : `${path.replace(/\/$/, '')}/${name}`;
        const st = await fs.stat(p);
        out.push(st.isDirectory ? `dir\t${p}/` : `${st.size}\t${p}`);
      }
      return out.length ? clip(out.join('\n')) : `(empty directory ${path})`;
    },
  };

  const editFileTool: AgentTool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
    name: 'edit_file',
    description:
      'Edit a text file by exact string replacement. old_string must match exactly (including whitespace) and be ' +
      'unique in the file unless replace_all is true. Read the file first.',
    inputSchema: z.object({
      path: z.string(),
      old_string: z.string().describe('Exact text to replace'),
      new_string: z.string().describe('Replacement text'),
      replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
    }),
    async execute({ path, old_string, new_string, replace_all = false }) {
      path = abs(path);
      if (!(await fs.exists(path))) throw new Error(`File not found: ${path}`);
      if (await isBinaryFile(path)) throw new Error(`${path} is binary and cannot be edited`);
      if (!old_string) throw new Error('old_string must not be empty');
      if (old_string === new_string) throw new Error('old_string and new_string are identical');
      const text = await fs.readFile(path);
      const count = text.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${path}`);
      if (count > 1 && !replace_all) {
        throw new Error(`old_string occurs ${count} times in ${path}; add surrounding context to make it unique or set replace_all`);
      }
      const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
      await writeFile(path, next);
      return `Edited ${path}: replaced ${replace_all ? count : 1} occurrence(s)`;
    },
  };

  return [bashTool, readFileTool, writeFileTool, listFilesTool, editFileTool];
}
