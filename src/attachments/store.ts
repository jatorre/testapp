/**
 * In-memory store for user uploads (no filesystem). Images stay as data URLs and go to the model as image parts;
 * spreadsheets/CSV are parsed with SheetJS into sheets of rows that tools read or load (DuckDB / warehouse).
 */
import type { ChatMessage, ModelImage } from '../agent/types';

export interface Sheet {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

interface Base {
  id: string;
  name: string;
  mime: string;
  size: number;
}
export type Attachment =
  | (Base & { kind: 'image'; data: string /* data URL */ })
  | (Base & { kind: 'table'; data: Sheet[] })
  | (Base & { kind: 'text'; data: string });

const items = new Map<string, Attachment>();
const listeners = new Set<() => void>();
let seq = 0;

export const listAttachments = () => [...items.values()];
export const getAttachment = (id: string) => items.get(id);
export function onAttachmentsChange(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function add(a: Omit<Base, 'id'> & Pick<Attachment, 'kind' | 'data'>): Attachment {
  const att = { ...a, id: `a${++seq}` } as Attachment;
  items.set(att.id, att);
  listeners.forEach((l) => l());
  return att;
}

const TABLE_EXT = /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i;
const TEXT_EXT = /\.(txt|md|json|geojson|xml|html|sql|log)$/i;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Parse a workbook (xlsx/xls/ods/csv) into sheets of rows (header = first row). SheetJS is loaded lazily. */
export async function parseWorkbook(bytes: ArrayBuffer | Uint8Array): Promise<Sheet[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { defval: null, raw: true });
    const columns = rows.length ? Object.keys(rows[0]) : [];
    // Dates → ISO strings so every consumer (CSV, DuckDB, BigQuery literals) sees plain scalars.
    for (const r of rows) for (const c of columns) if (r[c] instanceof Date) r[c] = (r[c] as Date).toISOString().replace('T00:00:00.000Z', '');
    return { name, columns, rows };
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * Rows from common JSON data shapes: [{…}], [meta, [{…}]] (World Bank), {data|results|value|items: [{…}]},
 * GeoJSON features (properties). Nested values are kept as JSON. null when it isn't tabular.
 */
function jsonRows(text: string): Record<string, unknown>[] | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const arrs: unknown[] = Array.isArray(v) ? [v, ...v.filter(Array.isArray)] : isRecord(v) ? ['features', 'data', 'results', 'value', 'items', 'rows'].map((k) => v && (v as any)[k]) : [];
  const arr = arrs.find((a): a is unknown[] => Array.isArray(a) && a.length > 0 && a.every(isRecord));
  if (!arr) return null;
  return (arr as Record<string, unknown>[]).map((r) => {
    const flat = r.type === 'Feature' && isRecord(r.properties) ? r.properties : r;
    return Object.fromEntries(Object.entries(flat).map(([k, x]) => [k, x && typeof x === 'object' ? JSON.stringify(x) : x]));
  });
}

export async function addFile(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  const base = { name: file.name, mime: file.type || 'application/octet-stream', size: file.size };
  if (file.type.startsWith('image/')) {
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    return add({ ...base, kind: 'image', data });
  }
  if (TABLE_EXT.test(file.name)) return add({ ...base, kind: 'table', data: await parseWorkbook(await file.arrayBuffer()) });
  if (/\.(geo)?json$/i.test(file.name)) {
    const text = await file.text();
    const rows = jsonRows(text);
    if (rows) return add({ ...base, kind: 'table', data: [{ name: 'data', columns: [...new Set(rows.slice(0, 200).flatMap(Object.keys))], rows }] });
    return add({ ...base, kind: 'text', data: text });
  }
  if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) return add({ ...base, kind: 'text', data: await file.text() });
  throw new Error(`Unsupported attachment type: ${file.name} (${file.type || 'unknown'})`);
}

/** Add an image from a data URL (chart/map capture). */
export function addImage(name: string, dataUrl: string): Attachment {
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  return add({ name, mime, size: Math.round((dataUrl.length * 3) / 4), kind: 'image', data: dataUrl });
}

export function attachmentSummary(a: Attachment) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    bytes: a.size,
    ...(a.kind === 'table' && { sheets: a.data.map((s) => ({ name: s.name, rows: s.rows.length, columns: s.columns })) }),
    ...(a.kind === 'text' && { chars: a.data.length }),
  };
}

/** Pick a sheet by name (case-insensitive) or default to the first one. */
export function getSheet(a: Attachment, sheet?: string): Sheet {
  if (a.kind !== 'table') throw new Error(`${a.id} (${a.name}) is not a table`);
  if (!sheet) return a.data[0];
  const s = a.data.find((x) => x.name.toLowerCase() === sheet.toLowerCase());
  if (!s) throw new Error(`No sheet "${sheet}" in ${a.name}. Sheets: ${a.data.map((x) => x.name).join(', ')}`);
  return s;
}

/**
 * Build the user message for a prompt with attachments: images go as image parts; tables/text are only announced
 * (id, sheets, size) so the model reads them with tools instead of the whole file landing in context.
 */
export function toUserMessage(prompt: string, ids: string[] = []): ChatMessage {
  const atts = ids.map((id) => items.get(id)).filter((a): a is Attachment => !!a);
  if (!atts.length) return { role: 'user', content: prompt };
  const images: ModelImage[] = atts.flatMap((a) => (a.kind === 'image' ? [{ mime: a.mime, dataUrl: a.data }] : []));
  const lines = atts.map((a) => {
    if (a.kind === 'image') return `- ${a.id}: ${a.name} (image, included below)`;
    if (a.kind === 'text') return `- ${a.id}: ${a.name} (text, ${a.data.length} chars; read with read_attachment)`;
    return `- ${a.id}: ${a.name} (spreadsheet; sheets: ${a.data.map((s) => `${s.name} ${s.rows.length} rows [${s.columns.join(', ')}]`).join('; ')})`;
  });
  return { role: 'user', content: `${prompt}\n\nAttachments:\n${lines.join('\n')}`, ...(images.length && { images }) };
}
