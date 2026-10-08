import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import { toolImages } from '../agent/types';
import { captureLatest } from '../attachments/capture';
import { addImage, attachmentSummary, getAttachment, getSheet, listAttachments } from '../attachments/store';
import { toCsv } from './sqldirect';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_TEXT = 6000;

function mustGet(id: string) {
  const a = getAttachment(id);
  if (!a) throw new Error(`No attachment "${id}". Call list_attachments.`);
  return a;
}

/** Tools over the in-memory attachment store (user uploads and chart captures). No filesystem involved. */
export function createAttachTools(): AgentTool[] {
  const list: AgentTool<Record<string, never>> = {
    name: 'list_attachments',
    description: 'List the files the user attached (id, name, kind image|table|text, sheets with row counts and columns).',
    inputSchema: z.object({}),
    async execute() {
      const all = listAttachments();
      return all.length ? all.map(attachmentSummary) : 'No attachments.';
    },
  };

  const read: AgentTool<{ id: string; sheet?: string; offset?: number; limit?: number }> = {
    name: 'read_attachment',
    description:
      `Read an attachment. Spreadsheets/CSV: rows of one sheet as CSV (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT} rows per call; ` +
      'page with offset). Text files: up to 6000 chars from offset. Images: use view_image instead.',
    inputSchema: z.object({
      id: z.string().describe('Attachment id, e.g. "a1"'),
      sheet: z.string().optional().describe('Sheet name (default: first sheet)'),
      offset: z.number().int().min(0).optional().describe('First row (tables) or character (text) to return'),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Rows to return'),
    }),
    async execute({ id, sheet, offset = 0, limit = DEFAULT_LIMIT }) {
      const a = mustGet(id);
      if (a.kind === 'image') return `${id} is an image: call view_image({"id":"${id}"}) to look at it.`;
      if (a.kind === 'text') {
        const end = Math.min(a.data.length, offset + MAX_TEXT);
        return `chars ${offset}-${end} of ${a.data.length}\n${a.data.slice(offset, end)}`;
      }
      const s = getSheet(a, sheet);
      const rows = s.rows.slice(offset, offset + limit);
      const more = offset + rows.length < s.rows.length;
      return `sheet=${s.name} rows ${offset}-${offset + rows.length} of ${s.rows.length}${more ? ' (more: use offset)' : ''}\n${toCsv(rows)}`;
    },
  };

  const view: AgentTool<{ id: string }> = {
    name: 'view_image',
    description: 'Look at an image attachment (or a captured chart). The image is shown to you.',
    inputSchema: z.object({ id: z.string() }),
    async execute({ id }) {
      const a = mustGet(id);
      if (a.kind !== 'image') throw new Error(`${id} is a ${a.kind}, not an image; use read_attachment.`);
      return toolImages(`Image ${id} (${a.name}).`, [{ mime: a.mime, dataUrl: a.data }]);
    },
  };

  const capture: AgentTool<{ title?: string }> = {
    name: 'capture_chart',
    description:
      'Take a PNG screenshot of a chart or map rendered on the page (the latest, or the latest whose title contains `title`), ' +
      'save it as an image attachment and look at it. Use it to check what the user actually sees.',
    inputSchema: z.object({ title: z.string().optional() }),
    async execute({ title }) {
      const shot = await captureLatest(title);
      const a = addImage(`${shot.title}.png`, shot.dataUrl);
      return toolImages(`Captured "${shot.title}" as attachment ${a.id}.`, [{ mime: a.mime, dataUrl: shot.dataUrl }]);
    },
  };

  return [list, read, view, capture];
}
