import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MapEngine } from './engine';
import {
  listAnnotations,
  listLayerInfos,
  mapVersion,
  removeAnnotation,
  setMapController,
  subscribeMap,
  updateAnnotationNote,
} from './store';

type Mode = 'static' | 'polygon' | 'rectangle' | 'circle' | 'point' | 'freehand';
const TOOLS: { mode: Mode; icon: string; title: string }[] = [
  { mode: 'static', icon: '✋', title: 'Pan (stop drawing)' },
  { mode: 'polygon', icon: '⬠', title: 'Draw a polygon (click points, click the first point to close)' },
  { mode: 'rectangle', icon: '▭', title: 'Draw a rectangle' },
  { mode: 'circle', icon: '◯', title: 'Draw a circle' },
  { mode: 'freehand', icon: '✎', title: 'Draw freehand' },
  { mode: 'point', icon: '•', title: 'Drop a point' },
];

/** Demo 10: the live map pane (basemap + deck.gl layers + annotations), with drawing tools and a legend. */
export default function MapPane() {
  const ref = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<Mode>('static');
  const [editing, setEditing] = useState<string>();
  const [note, setNote] = useState('');
  const [ready, setReady] = useState(false);
  useSyncExternalStore(subscribeMap, mapVersion);

  useEffect(() => {
    let engine: MapEngine;
    try {
      engine = new MapEngine(ref.current!, {
        onAnnotationDrawn: (id) => {
          setEditing(id);
          setNote('');
        },
        onError: (m) => setError(m.slice(0, 300)),
      });
    } catch (e) {
      setError(`The map failed to start (WebGL unavailable?): ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    engineRef.current = engine;
    setMapController(engine);
    if (import.meta.env.DEV) (window as unknown as { __mapEngine?: MapEngine }).__mapEngine = engine; // tests only
    void engine.ready.then(() => engineRef.current === engine && setReady(true));
    const off = engine.onDrawMode((m) => setMode(m as Mode));
    return () => {
      off();
      setMapController(null);
      engineRef.current = null;
      engine.destroy();
    };
  }, []);

  const layers = listLayerInfos();
  const annotations = listAnnotations();
  const saveNote = () => {
    if (editing) updateAnnotationNote(editing, note.trim());
    setEditing(undefined);
  };

  return (
    <section className="pane map-pane" data-testid="map-pane" data-ready={ready}>
      <div ref={ref} className="map-canvas" data-testid="map" />
      <div className="map-toolbar" role="toolbar" aria-label="Annotate the map">
        {TOOLS.map((t) => (
          <button
            key={t.mode}
            className={mode === t.mode ? 'active' : ''}
            title={t.title}
            aria-pressed={mode === t.mode}
            data-testid={`draw-${t.mode}`}
            disabled={!ready}
            onClick={() => engineRef.current?.setDrawMode(t.mode)}
          >
            {t.icon}
          </button>
        ))}
      </div>
      {editing && (
        <form
          className="map-note"
          data-testid="annotation-note-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveNote();
          }}
        >
          <span className="ann-id user">{editing}</span>
          <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a short note (optional), Enter to save" data-testid="annotation-note" maxLength={200} />
          <button type="submit">Save</button>
        </form>
      )}
      <div className="map-legend" data-testid="map-legend">
        {layers.length === 0 && annotations.length === 0 && <div className="muted">No layers yet. Draw on the map to annotate it.</div>}
        {layers.map((l) => (
          <div key={l.id} className={`legend-layer ${l.status}`} data-testid="map-layer" data-layer={l.id} data-status={l.status}>
            <div className="legend-head">
              <input
                type="checkbox"
                checked={l.visible}
                title="Show/hide"
                onChange={(e) => engineRef.current?.setLayerVisible(l.id, e.target.checked)}
              />
              <span className="legend-name" title={l.source}>{l.legend.title ?? l.name}</span>
              {l.status === 'loading' && <span className="spinner" />}
              {l.featureCount !== undefined && <small className="muted">{l.featureCount.toLocaleString()}</small>}
              <button className="icon" title="Remove layer" onClick={() => engineRef.current?.removeLayer(l.id)}>✕</button>
            </div>
            {l.error && <div className="error small-text">{l.error}</div>}
            {l.legend.items.length > 1 && (
              <ul className="legend-items">
                {l.legend.items.map((it, i) => (
                  <li key={i}><span className="swatch" style={{ background: it.color }} />{it.label}</li>
                ))}
              </ul>
            )}
            {l.legend.items.length === 1 && <span className="swatch inline" style={{ background: l.legend.items[0].color }} />}
          </div>
        ))}
        {annotations.length > 0 && (
          <ul className="legend-annotations">
            {annotations.map((a) => (
              <li key={a.id} data-testid="map-annotation" data-id={a.id}>
                <span className={`ann-id ${a.author}`}>{a.id}</span>
                <span className="ann-note" onDoubleClick={() => a.author === 'user' && (setEditing(a.id), setNote(a.note))}>{a.note || <i className="muted">no note</i>}</span>
                <button className="icon" title="Delete annotation" onClick={() => removeAnnotation(a.id)}>✕</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <div className="map-error error banner" data-testid="map-error">
          {error} <button className="icon" onClick={() => setError(undefined)}>✕</button>
        </div>
      )}
    </section>
  );
}
