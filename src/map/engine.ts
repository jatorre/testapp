/**
 * The live map: MapLibre (CARTO Positron basemap) + a deck.gl overlay interleaved into MapLibre's WebGL context
 * (so ONE canvas holds basemap, data layers and annotations, which makes screenshots a single toDataURL), CARTO
 * layers via @deck.gl/carto sources (Maps API, viewer token), GeoJSON layers, and terra-draw for user annotations.
 *
 * Loaded lazily with the map pane only. Tools reach it through the MapController registered in ./store.
 */
import { Map as MlMap, NavigationControl, setWorkerUrl, type IControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 looks for its worker next to its own module, which breaks once Vite pre-bundles or chunks it: point it at
// the (self-contained) worker file explicitly; Vite serves it in dev and emits it as an asset in the build.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer, TextLayer } from '@deck.gl/layers';
import {
  H3TileLayer,
  VectorTileLayer,
  colorBins,
  colorCategories,
  colorContinuous,
  h3QuerySource,
  h3TableSource,
  vectorQuerySource,
  vectorTableSource,
} from '@deck.gl/carto';
import {
  TerraDraw,
  TerraDrawCircleMode,
  TerraDrawFreehandMode,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import { getCartoInfo, getConnectionName } from '../carto/info';
import { assertReadOnlySelect, runReadOnlyQuery } from '../carto/sql';
import {
  addAnnotation,
  bboxOf,
  deleteLayerInfo,
  listAnnotations,
  positions,
  round,
  roundBBox,
  setLayerInfo,
  subscribeMap,
  type AddCartoLayerInput,
  type AddGeojsonInput,
  type BBox,
  type Geometry,
  type LayerInfo,
  type LayerStyle,
  type LegendItem,
  type MapController,
  type MapView,
  type ViewInput,
} from './store';

setWorkerUrl(new URL(maplibreWorkerUrl, location.href).href);

export const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const MAX_GEOJSON_FEATURES = 20_000;
/**
 * All layers are 2D: draw in order, without depth testing. Otherwise H3 cells (ColumnLayer, which writes depth) hide
 * later points/lines/labels at the same z (found by the agent's own screenshot check in the T4 eval).
 */
const FLAT = { depthCompare: 'always', depthWriteEnabled: false } as const;
const DEFAULT_COLORS = ['#2f5bea', '#e4572e', '#17a398', '#f3a712', '#8e44ad', '#29335c'];
export const PALETTES =
  'sequential: Burg, BurgYl, RedOr, OrYel, Peach, PinkYl, Mint, BluGrn, DarkMint, Emrld, BluYl, Teal, TealGrn, Purp, PurpOr, Sunset, Magenta, SunsetDark, BrwnYl; ' +
  'diverging: ArmyRose, Fall, Geyser, Temps, TealRose, Tropic, Earth; qualitative: Antique, Bold, Pastel, Prism, Safe, Vivid';

type Rgba = [number, number, number, number?];
type Feature = { type: 'Feature'; geometry: Geometry; properties: Record<string, unknown> };

interface LayerState {
  info: LayerInfo;
  type: 'carto' | 'geojson';
  kind: string;
  style: LayerStyle;
  colorIndex: number;
  /** carto: resolved tilejson (+ widgetSource) */
  source?: any;
  features?: Feature[];
  /** Resolved color domain for style.color_by_column. */
  domain?: (number | string)[];
  /** Last tiles loaded in the viewport (used for H3 bins, whose displayed values are aggregated per zoom). */
  tiles?: any[];
  tileError?: string;
}

// ───────────────────────────── colors ─────────────────────────────

let colorCtx: CanvasRenderingContext2D | null = null;
export function parseColor(c: string | undefined, fallback = '#2f5bea'): Rgba {
  const s = (c ?? fallback).trim();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)?.[1];
  const fromHex = (h: string): Rgba => {
    const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return full.length === 8 ? [n(0), n(2), n(4), n(6)] : [n(0), n(2), n(4)];
  };
  if (hex) return fromHex(hex);
  colorCtx ??= document.createElement('canvas').getContext('2d');
  if (!colorCtx) return fromHex(fallback.replace('#', ''));
  colorCtx.fillStyle = '#000001';
  colorCtx.fillStyle = s; // invalid CSS colors leave the sentinel
  const out = String(colorCtx.fillStyle);
  if (out === '#000001') throw new Error(`Unknown color "${c}". Use a hex code like #e4572e or a CSS color name.`);
  const m = /^#([0-9a-f]{6})$/i.exec(out)?.[1];
  if (m) return fromHex(m);
  const rgba = out.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return [rgba[0], rgba[1], rgba[2], rgba[3] !== undefined ? Math.round(rgba[3] * 255) : undefined];
}
export const toHex = (c: Rgba | number[]) => '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const fmtNum = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${round(v / 1e6, 1)}M`;
  if (a >= 1e4) return `${round(v / 1e3, 1)}k`;
  return String(a >= 100 ? Math.round(v) : round(v, 2));
};

// ───────────────────────────── WKT / rows → GeoJSON ─────────────────────────────

const NUM = '-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?';
export function parseWkt(s: string): Geometry | null {
  const m = /^\s*(MULTIPOLYGON|POLYGON|MULTILINESTRING|LINESTRING|MULTIPOINT|POINT)\s*(\(.*\))\s*$/is.exec(s);
  if (!m) return null;
  const json = m[2]
    .replace(new RegExp(`(${NUM})\\s+(${NUM})(?:\\s+${NUM})?`, 'g'), '[$1,$2]')
    .replace(/\(/g, '[')
    .replace(/\)/g, ']');
  let arr: any;
  try {
    arr = JSON.parse(json);
  } catch {
    return null;
  }
  switch (m[1].toUpperCase()) {
    case 'POINT':
      return { type: 'Point', coordinates: arr[0] };
    case 'LINESTRING':
      return { type: 'LineString', coordinates: arr };
    case 'POLYGON':
      return { type: 'Polygon', coordinates: arr };
    case 'MULTIPOINT':
      return { type: 'MultiPoint', coordinates: arr.map((p: any) => (Array.isArray(p[0]) ? p[0] : p)) };
    case 'MULTILINESTRING':
      return { type: 'MultiLineString', coordinates: arr };
    default:
      return { type: 'MultiPolygon', coordinates: arr };
  }
}

function toGeometry(v: unknown): Geometry | null {
  if (!v) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{')) {
      try {
        return toGeometry(JSON.parse(t));
      } catch {
        return null;
      }
    }
    return parseWkt(t);
  }
  if (typeof v === 'object' && 'type' in (v as object)) {
    const o = v as any;
    if (o.type === 'Feature') return toGeometry(o.geometry);
    if (Array.isArray(o.coordinates)) return o as Geometry;
  }
  return null;
}

const GEOM_COLS = ['geom', 'geometry', 'geojson', 'geog', 'wkt', 'the_geom'];
const LON_COLS = ['longitude', 'lon', 'lng', 'long', 'x'];
const LAT_COLS = ['latitude', 'lat', 'y'];
export function rowsToFeatures(rows: Record<string, unknown>[]): Feature[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const lower = (c: string) => c.toLowerCase();
  const gcol = cols.find((c) => GEOM_COLS.includes(lower(c))) ?? cols.find((c) => toGeometry(rows[0][c]));
  const lon = cols.find((c) => LON_COLS.includes(lower(c)));
  const lat = cols.find((c) => LAT_COLS.includes(lower(c)));
  if (!gcol && !(lon && lat)) throw new Error(`No geometry in the result: return a GEOGRAPHY column named geom (e.g. ST_ASGEOJSON(geom) AS geom) or longitude/latitude columns. Columns: ${cols.join(', ')}`);
  const out: Feature[] = [];
  for (const r of rows) {
    const geometry = gcol ? toGeometry(r[gcol]) : Number.isFinite(Number(r[lon!])) && Number.isFinite(Number(r[lat!])) ? ({ type: 'Point', coordinates: [Number(r[lon!]), Number(r[lat!])] } as Geometry) : null;
    if (!geometry) continue;
    const properties: Record<string, unknown> = {};
    for (const c of cols) if (c !== gcol) properties[c] = r[c];
    out.push({ type: 'Feature', geometry, properties });
  }
  return out;
}

export function normalizeGeojson(input: unknown): Feature[] {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (e) {
      throw new Error(`geojson is not valid JSON: ${(e as Error).message}`);
    }
  }
  const list: unknown[] = Array.isArray(v) ? v : (v as any)?.type === 'FeatureCollection' ? (v as any).features ?? [] : [v];
  const feats: Feature[] = [];
  for (const f of list) {
    const g = toGeometry(f);
    if (!g) throw new Error('geojson must be a FeatureCollection, Feature(s) or geometry with [lon, lat] coordinates');
    feats.push({ type: 'Feature', geometry: g, properties: ((f as any)?.type === 'Feature' && (f as any).properties) || {} });
  }
  return feats;
}

// ───────────────────────────── stats helpers ─────────────────────────────

function quantileThresholds(values: number[], k: number): number[] {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [];
  const out: number[] = [];
  for (let i = 1; i < k; i++) out.push(v[Math.min(v.length - 1, Math.floor((i / k) * v.length))]);
  return [...new Set(out.map((x) => niceRound(x)))].sort((a, b) => a - b);
}
function niceRound(x: number) {
  const a = Math.abs(x);
  if (a >= 100) return Math.round(x);
  if (a >= 10) return round(x, 1);
  return round(x, 2);
}
const safeIdent = (c: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) throw new Error(`Invalid column name "${c}"`);
  return c;
};

function tileValues(tiles: any[] | undefined, column: string): unknown[] {
  const out: unknown[] = [];
  for (const t of tiles ?? []) {
    const c = t?.content;
    const arr = Array.isArray(c) ? c : Array.isArray(c?.data) ? c.data : null;
    if (arr) for (const d of arr) out.push(d?.properties?.[column] ?? d?.[column]);
  }
  return out;
}

// ───────────────────────────── engine ─────────────────────────────

export interface EngineOptions {
  onAnnotationDrawn?: (id: string) => void;
  onError?: (msg: string) => void;
}

export class MapEngine implements MapController {
  readonly map: MlMap;
  private opts: EngineOptions;
  private overlay: MapboxOverlay;
  private layers = new Map<string, LayerState>();
  private draw?: TerraDraw;
  private labelBeforeId?: string;
  private unsub: () => void;
  private seq = 0;
  private colorSeq = 0;
  ready: Promise<void>;

  constructor(container: HTMLElement, opts: EngineOptions = {}) {
    this.opts = opts;
    this.map = new MlMap({
      container,
      style: BASEMAP_STYLE,
      center: [-97, 38.5],
      zoom: 3,
      attributionControl: { compact: true },
      // Needed so map_screenshot can read the canvas after a frame (deck.gl draws into the same context).
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    // deck.gl 9.4's MapboxOverlay reads map.transform, which MapLibre 6 moved to map._camera.transform.
    const m = this.map as any;
    if (m.transform === undefined && m._camera) Object.defineProperty(m, 'transform', { get: () => m._camera.transform, configurable: true });
    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    this.map.addControl(this.overlay as unknown as IControl);
    this.ready = new Promise((resolve) => {
      this.map.once('load', () => {
        // Draw data above roads/boundaries but under the label block, so place names stay readable (Positron has an early
        // waterway_label symbol layer before the roads, so take the first symbol after the last non-symbol layer).
        const layers = this.map.getStyle().layers as { type: string; id: string }[];
        const lastShape = layers.findLastIndex((l) => l.type !== 'symbol');
        this.labelBeforeId = layers.slice(lastShape + 1).find((l) => l.type === 'symbol')?.id;
        this.initDraw();
        this.render();
        resolve();
      });
    });
    this.map.on('error', (e: unknown) => this.opts.onError?.(String((e as any)?.error?.message ?? e)));
    this.unsub = subscribeMap(() => this.render());
  }

  destroy() {
    this.unsub();
    try {
      this.draw?.stop();
    } catch {
      /* ignore */
    }
    this.map.remove();
  }

  // ── drawing (user annotations) ──
  private initDraw() {
    try {
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map: this.map }),
        modes: [
          new TerraDrawPolygonMode(),
          new TerraDrawRectangleMode(),
          new TerraDrawCircleMode(),
          new TerraDrawPointMode(),
          new TerraDrawFreehandMode(),
        ],
      });
      draw.start();
      draw.on('finish', (id, ctx) => {
        if (ctx?.action && ctx.action !== 'draw') return;
        const f = draw.getSnapshotFeature(id);
        if (!f) return;
        draw.removeFeatures([id]);
        const a = addAnnotation(f.geometry as Geometry, '');
        draw.setMode('static');
        this.drawModeListeners.forEach((l) => l('static'));
        this.opts.onAnnotationDrawn?.(a.id);
      });
      this.draw = draw;
    } catch (e) {
      this.opts.onError?.(`Drawing tools unavailable: ${(e as Error).message}`);
    }
  }
  private drawModeListeners = new Set<(m: string) => void>();
  onDrawMode(l: (m: string) => void) {
    this.drawModeListeners.add(l);
    return () => void this.drawModeListeners.delete(l);
  }
  setDrawMode(mode: 'static' | 'polygon' | 'rectangle' | 'circle' | 'point' | 'freehand') {
    this.draw?.setMode(mode);
    this.drawModeListeners.forEach((l) => l(mode));
  }

  // ── rendering ──
  private render() {
    const deckLayers: any[] = [];
    for (const s of this.layers.values()) {
      if (!s.info.visible || s.info.status === 'error') continue;
      if (s.type === 'carto' && !s.source) continue;
      try {
        deckLayers.push(this.toDeckLayer(s));
      } catch (e) {
        s.info = { ...s.info, status: 'error', error: (e as Error).message };
        setLayerInfo(s.info);
      }
    }
    deckLayers.push(...this.annotationLayers());
    this.overlay.setProps({ layers: deckLayers });
  }

  private annotationLayers(): any[] {
    const anns = listAnnotations();
    if (!anns.length) return [];
    const col = (a: { author: string }): Rgba => (a.author === 'user' ? [234, 88, 12] : [124, 58, 237]);
    const features = anns.map((a) => ({ type: 'Feature', geometry: a.geometry, properties: { id: a.id, author: a.author } }));
    const labels = anns.map((a) => {
      const pts = positions(a.geometry);
      const b = bboxOf(pts)!;
      const isPoint = a.geometry.type === 'Point';
      return {
        position: isPoint ? pts[0] : [(b[0] + b[2]) / 2, b[3]],
        text: a.author === 'agent' && a.note ? `${a.id} · ${a.note.slice(0, 40)}` : a.id,
        color: col(a),
        isPoint,
      };
    });
    return [
      new GeoJsonLayer({
        id: '__annotations',
        data: features as any,
        parameters: FLAT,
        pointType: 'circle',
        getFillColor: (f: any) => [...col(f.properties).slice(0, 3), f.geometry.type === 'Point' ? 255 : 40] as any,
        getLineColor: (f: any) => col(f.properties) as any,
        getLineWidth: 2.5,
        lineWidthUnits: 'pixels',
        getPointRadius: 7,
        pointRadiusUnits: 'pixels',
        stroked: true,
        filled: true,
        updateTriggers: { getFillColor: anns.length, getLineColor: anns.length },
      }),
      new TextLayer({
        id: '__annotation-labels',
        data: labels,
        parameters: FLAT,
        getPosition: (d: any) => d.position,
        getText: (d: any) => d.text,
        getColor: [255, 255, 255],
        getSize: 13,
        fontWeight: 700,
        characterSet: 'auto',
        background: true,
        getBackgroundColor: (d: any) => d.color,
        backgroundPadding: [5, 3],
        getPixelOffset: (d: any) => (d.isPoint ? [0, -18] : [0, -12]),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }),
    ];
  }

  private fillAccessor(s: LayerState): any {
    const st = s.style;
    const base = parseColor(st.color, DEFAULT_COLORS[s.colorIndex % DEFAULT_COLORS.length]);
    if (!st.color_by_column || !s.domain?.length) return base;
    const attr = st.color_by_column;
    const scheme = st.color_scheme ?? 'bins';
    try {
      if (scheme === 'categories') return colorCategories({ attr, domain: s.domain as string[], colors: st.palette ?? 'Bold' });
      if (scheme === 'continuous') return colorContinuous({ attr, domain: s.domain as number[], colors: st.palette ?? 'Sunset' });
      return colorBins({ attr, domain: s.domain as number[], colors: st.palette ?? 'PurpOr' });
    } catch (e) {
      throw new Error(`Cannot build the color scale (${(e as Error).message || e}). Palettes (CARTOColors, 2–7 classes): ${PALETTES}`);
    }
  }

  private toDeckLayer(s: LayerState) {
    const st = s.style;
    const fill = this.fillAccessor(s);
    const outline = parseColor(st.outline_color ?? (s.kind === 'polygons' || s.kind === 'h3' ? '#ffffff' : '#ffffff'));
    const outlineWidth = st.outline_width ?? (s.kind === 'polygons' ? 0.5 : s.kind === 'h3' ? 0.3 : 0);
    const key = JSON.stringify([st, s.domain]);
    const common = {
      id: s.info.id,
      beforeId: this.labelBeforeId,
      opacity: st.opacity ?? (s.kind === 'points' ? 0.8 : 0.75),
      pickable: false,
      parameters: FLAT,
      updateTriggers: { getFillColor: key, getLineColor: key, getPointRadius: key, getLineWidth: key },
    };
    if (s.type === 'geojson') {
      const isLine = (f: any) => /LineString/.test(f.geometry?.type);
      const fillFn = typeof fill === 'function' ? fill : () => fill;
      return new GeoJsonLayer({
        ...common,
        data: { type: 'FeatureCollection', features: s.features } as any,
        pointType: 'circle',
        getFillColor: fill,
        getLineColor: (f: any, i: any) => (isLine(f) ? fillFn(f, i) : outline),
        getLineWidth: (f: any) => (isLine(f) ? Math.max(outlineWidth, 2) : outlineWidth),
        lineWidthUnits: 'pixels',
        getPointRadius: st.radius ?? 4,
        pointRadiusUnits: 'pixels',
        stroked: true,
        filled: true,
      } as any);
    }
    const onViewportLoad = (tiles: any[]) => {
      s.tiles = tiles;
    };
    const onTileError = (e: unknown) => {
      s.tileError = String((e as Error)?.message ?? e).slice(0, 300);
    };
    if (s.kind === 'h3') {
      return new H3TileLayer({
        ...common,
        data: s.source,
        getFillColor: fill,
        stroked: outlineWidth > 0,
        getLineColor: outline,
        lineWidthMinPixels: outlineWidth,
        onViewportLoad,
        onTileError,
      } as any);
    }
    const isLines = s.kind === 'lines';
    return new VectorTileLayer({
      ...common,
      data: s.source,
      getFillColor: fill,
      getLineColor: isLines ? fill : outline,
      getLineWidth: isLines ? st.outline_width ?? 2 : outlineWidth,
      lineWidthUnits: 'pixels',
      getPointRadius: st.radius ?? 2.5,
      pointRadiusUnits: 'pixels',
      pointRadiusMinPixels: 1,
      stroked: isLines || outlineWidth > 0,
      filled: !isLines,
      onViewportLoad,
      onTileError,
    } as any);
  }

  // ── legend ──
  private legendFor(s: LayerState): LayerInfo['legend'] {
    const st = s.style;
    const title = st.legend_title ?? s.info.name;
    const fill = this.fillAccessor(s);
    if (typeof fill !== 'function') return { title, items: [{ color: toHex(fill), label: s.info.name }] };
    const at = (v: unknown) => toHex(fill({ properties: { [st.color_by_column!]: v } }, {}));
    const d = s.domain!;
    const scheme = st.color_scheme ?? 'bins';
    let items: LegendItem[];
    if (scheme === 'categories') items = [...d.map((v) => ({ color: at(v), label: String(v) })), { color: at('\u0000other'), label: 'Other' }];
    else if (scheme === 'continuous') {
      const [lo, hi] = [d[0] as number, d[d.length - 1] as number];
      items = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ color: at(lo + (hi - lo) * t), label: fmtNum(lo + (hi - lo) * t) }));
    } else {
      const t = d as number[];
      items = [{ color: at(t[0] - Math.abs(t[0]) * 1e-6 - 1e-9), label: `< ${fmtNum(t[0])}` }];
      for (let i = 0; i < t.length - 1; i++) items.push({ color: at(t[i]), label: `${fmtNum(t[i])} – ${fmtNum(t[i + 1])}` });
      items.push({ color: at(t[t.length - 1]), label: `≥ ${fmtNum(t[t.length - 1])}` });
    }
    return { title: st.legend_title ?? `${s.info.name} — ${st.color_by_column}`, items };
  }

  private publish(s: LayerState, patch: Partial<LayerInfo> = {}) {
    s.info = { ...s.info, ...patch };
    if (s.info.status !== 'error') {
      try {
        s.info.legend = this.legendFor(s);
      } catch (e) {
        s.info = { ...s.info, status: 'error', error: (e as Error).message };
      }
    }
    setLayerInfo(s.info);
  }

  private newId(id: string | undefined, name: string | undefined) {
    if (id && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('id must be 1–40 chars of letters, digits, _ or -');
    if (id) return id;
    let base = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24);
    if (!base || this.layers.has(base)) base = `${base || 'layer'}_${++this.seq}`;
    return base;
  }

  private beginLayer(id: string, name: string, kind: string, source: string, type: LayerState['type'], style: LayerStyle): LayerState {
    const prev = this.layers.get(id);
    const s: LayerState = {
      type,
      kind,
      style: { ...style },
      colorIndex: prev?.colorIndex ?? this.colorSeq++,
      info: { id, name, kind, source: source.slice(0, 300), status: 'loading', visible: style.visible ?? true, legend: { items: [] } },
    };
    this.layers.set(id, s);
    setLayerInfo(s.info);
    return s;
  }

  // ── MapController ──
  async addCartoLayer(o: AddCartoLayerInput): Promise<LayerInfo> {
    await this.ready;
    if (!o.sql === !o.table) throw new Error('Pass exactly one of sql or table');
    const sql = o.sql ? assertReadOnlySelect(o.sql) : undefined; // same read-only guard as run_sql
    if (o.table && !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(o.table)) throw new Error('table must be a fully qualified name project.dataset.table');
    const kind = o.kind ?? 'points';
    if (kind === 'h3' && !o.aggregation_exp) {
      throw new Error('h3 layers need aggregation_exp, how to aggregate rows into a cell, e.g. "COUNT(*) AS n" for raw rows or "SUM(n) AS n" for pre-aggregated cells');
    }
    const name = o.name ?? o.id ?? (o.table ? o.table.split('.').pop()! : `${kind} layer`);
    const id = this.newId(o.id, name);
    const s = this.beginLayer(id, name, kind, sql ?? o.table!, 'carto', o.style ?? {});
    const info = await getCartoInfo();
    const base = { accessToken: info.accessToken, apiBaseUrl: info.apiBaseUrl, connectionName: getConnectionName() };
    try {
      if (kind === 'h3') {
        const h3 = { ...base, aggregationExp: o.aggregation_exp!, spatialDataColumn: o.h3_column ?? 'h3', ...(o.aggregation_res_level && { aggregationResLevel: o.aggregation_res_level }) };
        s.source = sql ? await h3QuerySource({ ...h3, sqlQuery: sql }) : await h3TableSource({ ...h3, tableName: o.table! });
      } else {
        const v = { ...base, spatialDataColumn: o.geom_column ?? 'geom' };
        s.source = sql ? await vectorQuerySource({ ...v, sqlQuery: sql }) : await vectorTableSource({ ...v, tableName: o.table! });
      }
    } catch (e) {
      this.publish(s, { status: 'error', error: cartoError(e) });
      this.render();
      throw new Error(`Layer ${id} failed: ${cartoError(e)}`);
    }
    if (this.layers.get(id) !== s) throw new Error(`Layer ${id} was replaced while loading`);
    const columns = (s.source.schema as { name: string }[] | undefined)?.map((f) => f.name).filter((n) => n !== (o.geom_column ?? 'geom')) ?? [];
    // The schema lists the query's columns only; H3 cells carry the aggregation_exp aliases ("COUNT(*) AS n" → n).
    if (kind === 'h3') for (const m of o.aggregation_exp!.matchAll(/\bAS\s+`?(\w+)`?/gi)) if (!columns.includes(m[1])) columns.push(m[1]);
    // Tilejson `bounds` of a query source only covers a sample, so ask the widget API for the real extent and count.
    const ws = s.source.widgetSource;
    const [count, extent] = await Promise.all([
      ws?.getFormula({ column: '*', operation: 'count' }).then((r: any) => r.value as number).catch(() => undefined),
      ws?.getExtent().then((r: any) => r.bbox as BBox).catch(() => undefined),
    ]);
    s.info.columns = columns;
    this.render(); // start loading tiles: H3 bins are computed from the cells on screen
    const warning = await this.tryDomain(s);
    this.publish(s, { status: 'ready', featureCount: count, bbox: extent ? roundBBox(extent) : undefined, columns, warning });
    this.render();
    return s.info;
  }

  async addGeojson(o: AddGeojsonInput, signal?: AbortSignal): Promise<LayerInfo> {
    await this.ready;
    if (!o.geojson === !o.from_sql) throw new Error('Pass exactly one of geojson or from_sql');
    let features: Feature[];
    let source: string;
    if (o.from_sql) {
      const r = await runReadOnlyQuery(o.from_sql, { maxRows: MAX_GEOJSON_FEATURES, signal });
      if (r.truncated) throw new Error(`Query returned more than ${MAX_GEOJSON_FEATURES} rows: aggregate it, or use map_add_carto_layer (tiled, no row limit)`);
      features = rowsToFeatures(r.rows);
      source = o.from_sql;
    } else {
      features = normalizeGeojson(o.geojson);
      source = 'inline geojson';
    }
    if (features.length > MAX_GEOJSON_FEATURES) throw new Error(`Too many features (${features.length} > ${MAX_GEOJSON_FEATURES})`);
    const name = o.name ?? o.id ?? 'GeoJSON';
    const id = this.newId(o.id, name);
    const s = this.beginLayer(id, name, 'geojson', source, 'geojson', o.style ?? {});
    s.features = features;
    const bbox = bboxOf(features.flatMap((f) => positions(f.geometry)));
    const columns = [...new Set(features.slice(0, 50).flatMap((f) => Object.keys(f.properties)))];
    s.info.columns = columns;
    const warning = await this.tryDomain(s);
    this.publish(s, { status: 'ready', featureCount: features.length, bbox: bbox && roundBBox(bbox), columns, warning });
    this.render();
    return s.info;
  }

  /** Resolve the color domain at layer creation; on failure fall back to a plain color and return a warning. */
  private async tryDomain(s: LayerState): Promise<string | undefined> {
    if (!s.style.color_by_column) return undefined;
    try {
      await this.resolveDomain(s);
      return undefined;
    } catch (e) {
      const { color_by_column: _c, ...rest } = s.style;
      s.style = rest;
      s.domain = undefined;
      return `color_by_column ignored: ${(e as Error).message}`;
    }
  }

  private async resolveDomain(s: LayerState) {
    const st = s.style;
    const col = st.color_by_column;
    if (!col) return void (s.domain = undefined);
    const scheme = st.color_scheme ?? 'bins';
    if (st.domain?.length) {
      s.domain = scheme === 'categories' ? st.domain.map(String) : st.domain.map(Number).sort((a, b) => a - b);
      return;
    }
    const k = Math.max(2, Math.min(7, st.bins ?? 5));
    const cols = s.info.columns;
    if (cols?.length && !cols.includes(col)) throw new Error(`Unknown column "${col}". Columns: ${cols.join(', ')}`);
    let values: unknown[] | null = null;
    if (s.type === 'geojson') values = s.features!.map((f) => f.properties[col]);
    else if (s.kind === 'h3' && scheme !== 'categories') {
      // H3 cells are re-aggregated per zoom, so use what is actually on screen (wait briefly for the first tiles).
      for (let t = 0; t < 40 && !s.tiles?.length; t++) await sleep(250);
      const v = tileValues(s.tiles, col);
      if (v.length) values = v;
    }
    if (values) {
      if (scheme === 'categories') {
        const counts = new Map<string, number>();
        for (const v of values) if (v != null) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
        s.domain = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v]) => v);
      } else {
        const nums = values.map(Number).filter(Number.isFinite);
        s.domain = scheme === 'continuous' ? [Math.min(...nums), Math.max(...nums)] : quantileThresholds(nums, k);
      }
    } else {
      const ws = s.source?.widgetSource;
      if (!ws) throw new Error('No data to compute a color domain from; pass style.domain');
      const c = safeIdent(col);
      if (scheme === 'categories') {
        const cats = (await ws.getCategories({ column: c, operation: 'count' })) as { name: unknown; value: number }[];
        s.domain = cats.sort((a, b) => b.value - a.value).slice(0, 8).map((x) => String(x.name));
      } else if (scheme === 'continuous') {
        const r = await ws.getRange({ column: c });
        s.domain = [r.min, r.max];
      } else {
        const r = await ws.getAggregations({ aggregations: `APPROX_QUANTILES(${c}, ${k}) AS q` });
        const q = (r.rows?.[0]?.q ?? []) as number[];
        s.domain = [...new Set(q.slice(1, -1).map(niceRound))].sort((a, b) => a - b);
      }
    }
    if (!s.domain?.length) throw new Error(`Could not compute a color domain for "${col}" (no values?); pass style.domain`);
  }

  async styleLayer(id: string, style: LayerStyle): Promise<LayerInfo> {
    const s = this.mustLayer(id);
    const prev = s.style;
    const next: LayerStyle = { ...prev, ...style };
    // A new column / scheme / bin count invalidates a domain that was computed (not given).
    if (style.color_by_column !== undefined || style.color_scheme !== undefined || style.bins !== undefined) {
      if (style.domain === undefined) delete next.domain;
    }
    if (style.color !== undefined && style.color_by_column === undefined) delete next.color_by_column; // plain color wins
    if (next.color) parseColor(next.color); // validate early
    if (next.outline_color) parseColor(next.outline_color);
    const prevDomain = s.domain;
    s.style = next;
    try {
      if (next.color_by_column) await this.resolveDomain(s);
      else s.domain = undefined;
    } catch (e) {
      s.style = prev;
      s.domain = prevDomain;
      throw e;
    }
    if (style.visible !== undefined) s.info = { ...s.info, visible: style.visible };
    this.publish(s, { warning: undefined });
    this.render();
    return s.info;
  }

  removeLayer(id: string): boolean {
    if (!this.layers.delete(id)) return false;
    deleteLayerInfo(id);
    this.render();
    return true;
  }

  setLayerVisible(id: string, visible: boolean) {
    const s = this.layers.get(id);
    if (!s) return;
    s.style.visible = visible;
    this.publish(s, { visible });
    this.render();
  }

  private mustLayer(id: string) {
    const s = this.layers.get(id);
    if (!s) throw new Error(`No layer "${id}". Layers: ${[...this.layers.keys()].join(', ') || '(none)'}`);
    return s;
  }

  getView(): MapView {
    const c = this.map.getCenter();
    const b = this.map.getBounds();
    return { center: [round(c.lng, 3), round(c.lat, 3)], zoom: round(this.map.getZoom(), 2), bounds: roundBBox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]) };
  }

  async setView(v: ViewInput): Promise<MapView> {
    await this.ready;
    let bbox: BBox | undefined = v.bbox;
    if (v.fit_layer) {
      const s = this.mustLayer(v.fit_layer);
      bbox = s.info.bbox;
      if (!bbox) throw new Error(`Layer ${v.fit_layer} has no known extent`);
    }
    if (v.fit_annotation) {
      const a = listAnnotations().find((x) => x.id.toUpperCase() === v.fit_annotation!.toUpperCase());
      if (!a) throw new Error(`No annotation ${v.fit_annotation}`);
      bbox = bboxOf(positions(a.geometry));
    }
    if (bbox) {
      const [w, s, e, n] = bbox;
      if (w === e && s === n) this.map.jumpTo({ center: [w, s], zoom: Math.max(this.map.getZoom(), 10) });
      else this.map.fitBounds([[w, s], [e, n]], { padding: 40, animate: false, maxZoom: 14 });
    } else if (v.center || v.zoom !== undefined) {
      this.map.jumpTo({ ...(v.center && { center: v.center }), ...(v.zoom !== undefined && { zoom: v.zoom }) });
    } else throw new Error('Pass center/zoom, bbox, fit_layer or fit_annotation');
    return this.getView();
  }

  private deckLoaded(): boolean {
    try {
      const deck = (this.overlay as any)._deck;
      const layers: any[] = deck?.layerManager?.getLayers?.() ?? [];
      return layers.filter((l) => !l.parent).every((l) => l.isLoaded);
    } catch {
      return true;
    }
  }

  /** Wait until the basemap tiles, CARTO sources and deck.gl tiles are loaded (stable for a few polls). */
  async waitIdle(timeoutMs = 20_000): Promise<boolean> {
    await this.ready;
    const t0 = Date.now();
    let stable = 0;
    while (Date.now() - t0 < timeoutMs) {
      const busy = [...this.layers.values()].some((s) => s.info.status === 'loading');
      const ok = !busy && this.map.loaded() && this.map.areTilesLoaded() && this.deckLoaded();
      stable = ok ? stable + 1 : 0;
      if (stable >= 3) return true;
      await sleep(150);
    }
    return false;
  }

  async screenshot({ maxWidth = 1024 } = {}) {
    const t0 = Date.now();
    const idle = await this.waitIdle();
    // Render one fresh frame and read it right after (preserveDrawingBuffer keeps it readable).
    await new Promise<void>((resolve) => {
      this.map.once('render', () => resolve());
      this.map.triggerRepaint();
      setTimeout(resolve, 1000);
    });
    const src = this.map.getCanvas();
    const scale = Math.min(1, maxWidth / src.width);
    const w = Math.round(src.width * scale);
    const h = Math.round(src.height * scale);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    drawLegend(ctx, w, h, [...this.layers.values()].filter((s) => s.info.visible && s.info.status === 'ready').map((s) => s.info.legend));
    const errors = [...this.layers.values()].filter((s) => s.tileError).map((s) => `${s.info.id}: ${s.tileError}`);
    return {
      image: { mime: 'image/png', dataUrl: out.toDataURL('image/png') },
      width: w,
      height: h,
      view: this.getView(),
      waitedMs: Date.now() - t0,
      ...((!idle || errors.length) && { warning: [!idle && 'some tiles were still loading', ...errors].filter(Boolean).join('; ') }),
    };
  }
}

/** The legend the user sees, drawn into the screenshot (bottom-left) so the model sees it too. */
function drawLegend(ctx: CanvasRenderingContext2D, w: number, h: number, legends: LayerInfo['legend'][]) {
  const shown = legends.filter((l) => l.items.length);
  if (!shown.length) return;
  const fs = Math.max(11, Math.round(w / 85));
  const line = Math.round(fs * 1.45);
  const rows = shown.reduce((n, l) => n + 1 + l.items.length, 0);
  ctx.font = `${fs}px system-ui, sans-serif`;
  const texts = shown.flatMap((l) => [l.title ?? '', ...l.items.map((i) => i.label)]);
  const boxW = Math.min(w * 0.45, Math.max(...texts.map((t) => ctx.measureText(t).width)) + fs * 3);
  const boxH = rows * line + fs;
  const x0 = fs * 0.6;
  const y0 = h - boxH - fs * 1.6;
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.fillRect(x0, y0, boxW, boxH);
  ctx.strokeRect(x0, y0, boxW, boxH);
  let y = y0 + fs * 0.5 + line * 0.75;
  for (const l of shown) {
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.fillStyle = '#222';
    ctx.fillText(l.title ?? '', x0 + fs * 0.6, y, boxW - fs);
    y += line;
    ctx.font = `${fs}px system-ui, sans-serif`;
    for (const it of l.items) {
      ctx.fillStyle = it.color;
      ctx.fillRect(x0 + fs * 0.6, y - fs * 0.8, fs, fs);
      ctx.fillStyle = '#333';
      ctx.fillText(it.label, x0 + fs * 2, y, boxW - fs * 2.5);
      y += line;
    }
  }
}

function cartoError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/access_token=[^&\s"]+/g, 'access_token=…').slice(0, 600);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
