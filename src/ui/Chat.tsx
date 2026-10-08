import { useEffect, useRef, useState, type ReactNode } from 'react';
import { captureLatest } from '../attachments/capture';
import { addFile, addImage, getAttachment, type Attachment } from '../attachments/store';
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

function AttachmentChip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const a = getAttachment(id);
  if (!a) return null;
  return (
    <span className="att-chip" data-testid={onRemove ? 'pending-attachment' : 'msg-attachment'} data-kind={a.kind} title={`${a.id} · ${a.mime}`}>
      {a.kind === 'image' ? <img src={a.data} alt="" /> : <span>{a.kind === 'table' ? '▦' : '¶'}</span>}
      {a.name}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${a.name}`}>
          ✕
        </button>
      )}
    </span>
  );
}

export interface ChatProps {
  messages: UiMessage[];
  toolRows: Map<string, ToolRow>;
  suggestions: string[];
  running: boolean;
  disabledReason?: string;
  errors: string[];
  onSend: (text: string, attachments: string[]) => void;
  /** Show the attach / drop / paste / capture controls (demos with the 'attach' tool group). */
  attachEnabled?: boolean;
  onStop: () => void;
  onClear: () => void;
  blurb: string;
  /** Extra controls above the input (e.g. the map demo's annotation chips). */
  composerExtra?: ReactNode;
}

export function Chat(p: ChatProps) {
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const [attachError, setAttachError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const attach = async (files: FileList | File[] | null) => {
    if (!p.attachEnabled || !files?.length) return;
    setAttachError(undefined);
    for (const f of Array.from(files)) {
      try {
        const a: Attachment = await addFile(f);
        setPending((ids) => [...ids, a.id]);
      } catch (e) {
        setAttachError(e instanceof Error ? e.message : String(e));
      }
    }
  };
  const capture = async () => {
    setAttachError(undefined);
    try {
      const shot = await captureLatest();
      const a = addImage(`${shot.title}.png`, shot.dataUrl);
      setPending((ids) => [...ids, a.id]);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    }
  };
  const last = p.messages[p.messages.length - 1];
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [p.messages.length, last?.parts.length, last?.text.length]);

  const send = (text: string) => {
    if (!text.trim() || p.running || p.disabledReason) return;
    p.onSend(text.trim(), pending);
    setInput('');
    setPending([]);
  };

  return (
    <main
      className="pane chat"
      data-testid="chat"
      onDragOver={(e) => p.attachEnabled && e.preventDefault()}
      onDrop={(e) => {
        if (!p.attachEnabled) return;
        e.preventDefault();
        void attach(e.dataTransfer.files);
      }}
    >
      <div className="messages">
        {p.messages.length === 0 && <div className="muted intro">{p.blurb}</div>}
        {p.messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`} data-testid={`msg-${m.role}`}>
            {m.role === 'user' ? (
              <div className="bubble">
                {!!m.attachments?.length && (
                  <div className="att-chips">{m.attachments.map((id) => <AttachmentChip key={id} id={id} />)}</div>
                )}
                {!!m.annotations?.length && (
                  <div className="att-chips">{m.annotations.map((id) => <span key={id} className="att-chip" data-testid="msg-annotation"><span className="ann-id user">{id}</span></span>)}</div>
                )}
                {m.text}
              </div>
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
        {p.composerExtra}
        {(pending.length > 0 || attachError) && (
          <div className="att-chips">
            {pending.map((id) => <AttachmentChip key={id} id={id} onRemove={() => setPending((ids) => ids.filter((x) => x !== id))} />)}
            {attachError && <span className="error" data-testid="attach-error">{attachError}</span>}
          </div>
        )}
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
            onPaste={(e) => {
              if (p.attachEnabled && e.clipboardData.files.length) {
                e.preventDefault();
                void attach(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={2}
          />
          {p.attachEnabled && (
            <>
              <input ref={fileRef} type="file" multiple hidden data-testid="attach-input"
                accept="image/*,.xlsx,.xlsm,.xls,.ods,.csv,.tsv,.txt,.md,.json"
                onChange={(e) => {
                  void attach(e.target.files);
                  e.target.value = '';
                }}
              />
              <button type="button" className="secondary" onClick={() => fileRef.current?.click()} title="Attach images, Excel, CSV or text (or drop / paste them)" data-testid="attach">
                📎
              </button>
              <button type="button" className="secondary" onClick={capture} title="Capture the latest chart/map as an image attachment" data-testid="capture">
                📷 capture
              </button>
            </>
          )}
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
