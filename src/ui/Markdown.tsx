import { Fragment, type ReactNode } from 'react';

/** Tiny, safe (no innerHTML) markdown subset: headings, lists, code blocks, tables, inline code/bold/italic/links. */
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{s.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{s.slice(1, -1)}</em>);
    else {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(s)!;
      const safe = /^https?:/i.test(href) ? href : undefined;
      out.push(<a key={k} href={safe} target="_blank" rel="noreferrer">{label}</a>);
    }
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={blocks.length}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      const Tag = `h${level}` as 'h3';
      blocks.push(<Tag key={blocks.length}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={blocks.length}>{items.map((it, j) => <li key={j}>{inline(it, j)}</li>)}</List>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      blocks.push(
        <table key={blocks.length} className="md-table">
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, j)}</th>)}</tr></thead>
          <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c, k)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push(
      <p key={blocks.length}>
        {para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, j)}</Fragment>)}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
