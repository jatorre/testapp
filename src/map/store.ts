/**
 * Map workspace state that must stay LIGHT (no deck.gl / MapLibre imports): annotations, layer metadata for the
 * legend, and the registry through which tools reach the live map. The heavy engine (src/map/engine.ts) is only
 * loaded with the map pane (React.lazy), so the other demos never download deck.gl or MapLibre.
 */
import type { ModelImage } from '../agent/types';

export type Geometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString' | 'MultiPoint'; coordinates: number[][] }
  | { type: 'Polygon' | 'MultiLineString'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };
export type BBox = [number, number, number, number];

export interface Annotation {
  /** A1, A2… (drawn by the user) or M1, M2… (created by the agent with map_annotate). */
  id: string;
  author: 'user' | 'agent';
  note: string;
  geometry: Geometry;
  createdAt: number;
}

export interface LegendItem {
  color: string;
  label: string;
}
export interface LayerInfo {
  id: string;
  name: string;
  /** points | lines | polygons | h3 | geojson */
  kind: string;
  source: string;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  warning?: string;
  featureCount?: number;
  bbox?: BBox;
  columns?: string[];
  visible: boolean;
  legend: { title?: string; items: LegendItem[] };
}

// ───────────────────────────── annotations ─────────────────────────────

const annotations = new Map<string, Annotation>();
const selected = new Set<string>();
let seq = { user: 0, agent: 0 };
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
export const subscribeMap = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** Changes whenever annotations, the selection or layer metadata change (for useSyncExternalStore). */
export const mapVersion = () => version;

export const listAnnotations = () => [...annotations.values()];
export const getAnnotation = (id: string) => annotations.get(id.toUpperCase());

export function addAnnotation(geometry: Geometry, note = '', author: Annotation['author'] = 'user'): Annotation {
  validateGeometry(geometry);
  const id = author === 'user' ? `A${++seq.user}` : `M${++seq.agent}`;
  const a: Annotation = { id, author, note: note.slice(0, 500), geometry, createdAt: Date.now() };
  annotations.set(id, a);
  if (author === 'user') selected.add(id); // a new user annotation is attached to the next message by default
  emit();
  return a;
}
export function updateAnnotationNote(id: string, note: string) {
  const a = annotations.get(id);
  if (!a) return;
  annotations.set(id, { ...a, note: note.slice(0, 500) });
  emit();
}
export function removeAnnotation(id: string) {
  annotations.delete(id);
  selected.delete(id);
  emit();
}
export function clearAgentAnnotations() {
  for (const a of annotations.values()) if (a.author === 'agent') annotations.delete(a.id);
  emit();
}
export const selectedAnnotations = () => [...selected].filter((id) => annotations.has(id));
export function setAnnotationSelected(id: string, on: boolean) {
  if (on && annotations.has(id)) selected.add(id);
  else selected.delete(id);
  emit();
}
export function clearAnnotationSelection() {
  selected.clear();
  emit();
}

function validateGeometry(g: Geometry) {
  const ok = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];
  if (!g || !ok.includes(g.type) || !Array.isArray(g.coordinates)) throw new Error(`Invalid geometry: expected a GeoJSON geometry (${ok.join(', ')})`);
  const pts = positions(g);
  if (!pts.length || pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) {
    throw new Error('Invalid geometry coordinates: expected [longitude, latitude] pairs in degrees');
  }
}

// ───────────────────────────── geometry helpers ─────────────────────────────

export function positions(g: Geometry): number[][] {
  switch (g.type) {
    case 'Point':
      return [g.coordinates];
    case 'MultiPoint':
    case 'LineString':
      return g.coordinates;
    case 'Polygon':
    case 'MultiLineString':
      return g.coordinates.flat();
    case 'MultiPolygon':
      return g.coordinates.flat(2);
  }
}
export function bboxOf(points: number[][]): BBox | undefined {
  if (!points.length) return undefined;
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    if (x < w) w = x;
    if (y < s) s = y;
    if (x > e) e = x;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}
export const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
export const roundBBox = (b: BBox, d = 3): BBox => b.map((v) => round(v, d)) as BBox;

/** Keep at most `max` vertices of a ring/line (always keeps the first and last). */
function decimate(coords: number[][], max: number): number[][] {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => coords[Math.round(i * step)]);
}
/** Compact copy of a geometry for the model: rounded coordinates, long rings decimated. */
export function compactGeometry(g: Geometry, digits = 4, maxVertices = 64): { geometry: Geometry; simplified: boolean } {
  let simplified = false;
  const line = (c: number[][]) => {
    const d = decimate(c, maxVertices);
    if (d.length < c.length) simplified = true;
    return d.map((p) => [round(p[0], digits), round(p[1], digits)]);
  };
  const ring = (c: number[][]) => {
    const r = line(c);
    const [f, l] = [r[0], r[r.length - 1]];
    if (f[0] !== l[0] || f[1] !== l[1]) r.push(f);
    return r;
  };
  let out: Geometry;
  switch (g.type) {
    case 'Point':
      out = { type: 'Point', coordinates: [round(g.coordinates[0], digits), round(g.coordinates[1], digits)] };
      break;
    case 'MultiPoint':
    case 'LineString':
      out = { type: g.type, coordinates: line(g.coordinates) };
      break;
    case 'Polygon':
      out = { type: 'Polygon', coordinates: g.coordinates.map(ring) };
      break;
    case 'MultiLineString':
      out = { type: 'MultiLineString', coordinates: g.coordinates.map(line) };
      break;
    case 'MultiPolygon':
      out = { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(ring)) };
      break;
  }
  return { geometry: out, simplified };
}

/** Planar-ish area in km² (equirectangular at the ring's mean latitude); good enough for orientation. */
export function areaKm2(g: Geometry): number | undefined {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  if (!polys) return undefined;
  let total = 0;
  for (const poly of polys) {
    poly.forEach((r, i) => {
      const lat0 = (r.reduce((s, p) => s + p[1], 0) / r.length) * (Math.PI / 180);
      const kx = 111.32 * Math.cos(lat0);
      let a = 0;
      for (let j = 0; j < r.length - 1; j++) a += r[j][0] * kx * r[j + 1][1] * 110.57 - r[j + 1][0] * kx * r[j][1] * 110.57;
      total += (i === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return Math.round(total);
}

/** WKT for BigQuery's ST_GEOGFROMTEXT (shorter than GeoJSON for the same geometry). */
export function toWkt(g: Geometry): string {
  const pt = (c: number[]) => `${c[0]} ${c[1]}`;
  const ring = (r: number[][]) => `(${r.map(pt).join(', ')})`;
  const poly = (p: number[][][]) => `(${p.map(ring).join(', ')})`;
  const c = (g as { coordinates: any }).coordinates;
  switch (g.type) {
    case 'Point': return `POINT(${pt(c)})`;
    case 'LineString': return `LINESTRING${ring(c)}`;
    case 'Polygon': return `POLYGON${poly(c)}`;
    case 'MultiPolygon': return `MULTIPOLYGON(${c.map(poly).join(', ')})`;
    default: return '';
  }
}

/** One annotation as compact structured context for the model. */
export function describeAnnotation(a: Annotation) {
  const { geometry, simplified } = compactGeometry(a.geometry);
  const area = areaKm2(a.geometry);
  return {
    id: a.id,
    by: a.author,
    note: a.note || undefined,
    type: a.geometry.type,
    bbox: roundBBox(bboxOf(positions(a.geometry))!),
    ...(area !== undefined && { area_km2: area }),
    geojson: JSON.stringify(geometry),
    wkt: toWkt(geometry),
    ...(simplified && { simplified: true }),
  };
}

/**
 * Text appended to the user's message for the selected annotations: id, note, bbox and the geometry as compact
 * GeoJSON the agent can paste into BigQuery (ST_GEOGFROMGEOJSON) or reuse on the map.
 */
export function annotationContext(ids: string[], withScreenshot = false): string {
  const list = ids.map((id) => annotations.get(id)).filter((a): a is Annotation => !!a);
  if (!list.length) return '';
  const lines = list.map((a) => {
    const d = describeAnnotation(a);
    return `- ${d.id}${d.note ? ` "${d.note}"` : ''}: ${d.type}, bbox [${d.bbox.join(', ')}]` +
      `${d.area_km2 !== undefined ? `, ~${d.area_km2.toLocaleString('en-US')} km²` : ''}${d.simplified ? ' (simplified)' : ''}\n  wkt: ${d.wkt}`;
  });
  return `\n\nMap annotations marked by the user (refer to them by id; WKT is lon lat, use ST_GEOGFROMTEXT(wkt) in BigQuery; ` +
    `get_annotations returns GeoJSON for map layers):\n${lines.join('\n')}` +
    (withScreenshot ? `\nAttached: a screenshot of the map as the user sees it, with the marked area(s) labelled by id.` : '');
}

// ───────────────────────────── layers (metadata only) ─────────────────────────────

const layerInfos = new Map<string, LayerInfo>();
export const listLayerInfos = () => [...layerInfos.values()];
export function setLayerInfo(info: LayerInfo) {
  layerInfos.set(info.id, info);
  emit();
}
export function deleteLayerInfo(id: string) {
  layerInfos.delete(id);
  emit();
}

// ───────────────────────────── controller registry ─────────────────────────────

export type ColorScheme = 'bins' | 'categories' | 'continuous';
export interface LayerStyle {
  color?: string;
  color_by_column?: string;
  color_scheme?: ColorScheme;
  palette?: string;
  domain?: (number | string)[];
  bins?: number;
  radius?: number;
  opacity?: number;
  outline_color?: string;
  outline_width?: number;
  legend_title?: string;
  visible?: boolean;
}
export interface AddCartoLayerInput {
  id?: string;
  name?: string;
  kind: 'points' | 'lines' | 'polygons' | 'h3';
  sql?: string;
  table?: string;
  geom_column?: string;
  h3_column?: string;
  aggregation_exp?: string;
  aggregation_res_level?: number;
  style?: LayerStyle;
}
export interface AddGeojsonInput {
  id?: string;
  name?: string;
  geojson?: unknown;
  from_sql?: string;
  style?: LayerStyle;
}
export interface ViewInput {
  center?: [number, number];
  zoom?: number;
  fit_layer?: string;
  fit_annotation?: string;
  bbox?: BBox;
}
export interface MapView {
  center: [number, number];
  zoom: number;
  bounds: BBox;
}
export interface MapController {
  addCartoLayer(o: AddCartoLayerInput, signal?: AbortSignal): Promise<LayerInfo>;
  addGeojson(o: AddGeojsonInput, signal?: AbortSignal): Promise<LayerInfo>;
  styleLayer(id: string, style: LayerStyle): Promise<LayerInfo>;
  removeLayer(id: string): boolean;
  setView(v: ViewInput): Promise<MapView>;
  getView(): MapView;
  screenshot(opts?: { maxWidth?: number }): Promise<{ image: ModelImage; width: number; height: number; view: MapView; waitedMs: number; warning?: string }>;
}

let controller: MapController | null = null;
const controllerWaiters = new Set<(c: MapController) => void>();
export function setMapController(c: MapController | null) {
  controller = c;
  if (c) controllerWaiters.forEach((w) => w(c));
  if (c) controllerWaiters.clear();
}
/** The live map, waiting up to `timeoutMs` for the map pane to mount. */
export function getMapController(timeoutMs = 20_000): Promise<MapController> {
  if (controller) return Promise.resolve(controller);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      controllerWaiters.delete(resolve);
      reject(new Error('The map is not available (map pane not mounted, or WebGL failed to start).'));
    }, timeoutMs);
    controllerWaiters.add((c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
}

/** Test-only: reset everything (annotations, numbering, layers). */
export function resetMapStore() {
  annotations.clear();
  selected.clear();
  layerInfos.clear();
  seq = { user: 0, agent: 0 };
  emit();
}
