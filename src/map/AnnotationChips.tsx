import { useSyncExternalStore } from 'react';
import { listAnnotations, mapVersion, selectedAnnotations, setAnnotationSelected, subscribeMap } from './store';

/**
 * Composer chips for map annotations (light: no map code). Selected annotations are sent with the next message as
 * structured context (id, note, bbox, compact GeoJSON); click a chip to include/exclude it.
 */
export function AnnotationChips() {
  useSyncExternalStore(subscribeMap, mapVersion);
  const anns = listAnnotations().filter((a) => a.author === 'user');
  if (!anns.length) return null;
  const sel = new Set(selectedAnnotations());
  return (
    <div className="att-chips" data-testid="annotation-chips">
      {anns.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`att-chip ann-chip ${sel.has(a.id) ? 'selected' : ''}`}
          data-testid="annotation-chip"
          data-id={a.id}
          data-selected={sel.has(a.id)}
          title={sel.has(a.id) ? 'Included in the next message (click to exclude)' : 'Click to include in the next message'}
          onClick={() => setAnnotationSelected(a.id, !sel.has(a.id))}
        >
          <span className="ann-id user">{a.id}</span>
          {a.note ? (a.note.length > 30 ? a.note.slice(0, 28) + '…' : a.note) : a.geometry.type}
        </button>
      ))}
    </div>
  );
}
