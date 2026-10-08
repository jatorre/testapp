import { useEffect, useRef, useState } from 'react';
import { ChartView } from './ChartView';
import { Markdown } from './Markdown';
import { fmtMs, type ToolRow, type UiMessage } from './runlog';

function pretty(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function ToolCard({ row }: { row?: ToolRow }) {
  const [open, setOpen] = useState(false);
  if (!row) return null;
  const running = row.durationMs == null;
  const status = running ? 'running' : row.error ? 'error' : 'ok';
  const summary =
    row.name === 'bash' && row.input && typeof row.input === 'object'
      ? String((row.input as { command?: string }).command ?? '')
      : row.input && typeof row.input === 'object' && 'path' in row.input
        ? String((row.input as { path: string }).path)
        : '';
  return (
    <div className={`tool-card ${status}`} data-testid="tool-card" data-tool={row.name} data-status={status}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{row.name}</span>
        <span className="tool-summary mono">{summary.slice(0, 80)}</span>
        <span className="tool-meta">
          {running ? <span className="spinner" /> : `${fmtMs(row.durationMs!)} · ${row.outputChars} ch`}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="label">input</div>
          <pre>{pretty(row.input)}</pre>
          {!running && (
            <>
              <div className="label">{row.error ? 'error' : 'output'}</div>
              <pre className={row.error ? 'error' : ''}>{row.error ?? pretty(row.output)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface ChatProps {
  messages: UiMessage[];
  toolRows: Map<string, ToolRow>;
  suggestions: string[];
  running: boolean;
  disabledReason?: string;
  errors: string[];
  onSend: (text: string) => void;
  onStop: () => void;
  onClear: () => void;
  blurb: string;
}

export function Chat(p: ChatProps) {
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const last = p.messages[p.messages.length - 1];
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [p.messages.length, last?.parts.length, last?.text.length]);

  const send = (text: string) => {
    if (!text.trim() || p.running || p.disabledReason) return;
    p.onSend(text.trim());
    setInput('');
  };

  return (
    <main className="pane chat" data-testid="chat">
      <div className="messages">
        {p.messages.length === 0 && <div className="muted intro">{p.blurb}</div>}
        {p.messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`} data-testid={`msg-${m.role}`}>
            {m.role === 'user' ? (
              <div className="bubble">{m.text}</div>
            ) : (
              m.parts.map((part, j) =>
                part.kind === 'text' ? (
                  <Markdown key={j} text={part.text} />
                ) : part.kind === 'tool' ? (
                  <ToolCard key={j} row={p.toolRows.get(part.id)} />
                ) : (
                  <ChartView key={j} spec={part.artifact.spec} title={part.artifact.title} />
                ),
              )
            )}
            {m.role === 'assistant' && p.running && i === p.messages.length - 1 && (
              <div className="muted thinking"><span className="spinner" /> working…</div>
            )}
          </div>
        ))}
        {p.errors.map((e, i) => (
          <div key={i} className="error banner" data-testid="chat-error">{e}</div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <div className="chips">
          {p.suggestions.map((s) => (
            <button key={s} className="chip" onClick={() => send(s)} disabled={p.running || !!p.disabledReason} title={s} data-testid="suggestion">
              {s.length > 90 ? s.slice(0, 88) + '…' : s}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            data-testid="prompt"
            value={input}
            placeholder={p.disabledReason ?? 'Ask something… (Enter to send, Shift+Enter for newline)'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={2}
          />
          {p.running ? (
            <button type="button" className="stop" onClick={p.onStop} data-testid="stop">Stop</button>
          ) : (
            <button type="submit" disabled={!input.trim() || !!p.disabledReason} data-testid="send">Send</button>
          )}
          <button type="button" className="secondary" onClick={p.onClear} disabled={p.running} title="Clear conversation">
            Clear
          </button>
        </form>
      </div>
    </main>
  );
}
