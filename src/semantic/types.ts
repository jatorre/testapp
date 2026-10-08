/**
 * Minimal semantic model (ideas from dbt semantic layer / Cube / OSI, kept small enough to hand-write):
 * which sources an agent may use, what their columns mean, how they join, and named metric definitions.
 * Models live as JSON in src/semantic/models/ and are rendered into the system prompt together with a
 * cached physical catalog (column types, row counts, sizes) fetched from the CARTO connections API.
 */
export interface ColumnSpec {
  description?: string;
  /** Complete list of allowed values (verified), for categorical columns. */
  values?: string[];
  unit?: string;
}

export interface SourceSpec {
  /** Short logical name used in relationships/metrics (also the SQL alias in examples). */
  name: string;
  /** Fully-qualified warehouse table: project.dataset.table */
  table: string;
  description: string;
  grain?: string;
  primary_key?: string;
  /** Default time column for time filters/grouping. */
  time_column?: string;
  /** Geo columns for maps: point lat/lon and/or a GEOGRAPHY column. */
  geo?: { lat?: string; lon?: string; geography?: string };
  /** Only the columns worth explaining; the rest come from the catalog. */
  columns?: Record<string, ColumnSpec>;
  gotchas?: string[];
}

export type Cardinality = 'many_to_one' | 'one_to_one' | 'one_to_many' | 'many_to_many';

export interface RelationshipSpec {
  /** source.column */
  from: string;
  /** source.column */
  to: string;
  cardinality: Cardinality;
  note?: string;
}

export interface DimensionSpec {
  name: string;
  source: string;
  sql: string;
  description?: string;
}

export interface MetricSpec {
  name: string;
  /** Base source (FROM). Column refs in sql/filter are written as <source>.<column>. */
  source: string;
  /** Aggregate SQL expression. */
  sql: string;
  /** Row filter (WHERE) that is part of the definition. */
  filter?: string;
  /** Other sources the expression needs (joined via relationships). */
  joins?: string[];
  description?: string;
  unit?: string;
}

export interface SemanticModel {
  id: string;
  /** Bump when the model changes: part of the catalog cache key. */
  version: string;
  title: string;
  description?: string;
  /** Other model ids whose sources/relationships/rules are merged in. */
  includes?: string[];
  /** Default interpretation rules for the agent. */
  rules?: string[];
  sources: SourceSpec[];
  relationships?: RelationshipSpec[];
  dimensions?: DimensionSpec[];
  metrics?: MetricSpec[];
}

/** A model with its includes merged in. */
export interface ResolvedModel extends SemanticModel {
  /** Cache/version key, e.g. "thelook_ecommerce@2026-10-08.1+us_geo@2026-10-08.1". */
  key: string;
  /** Version of the model each source came from (by source name). */
  sourceVersions: Record<string, string>;
}

export interface CatalogColumn {
  name: string;
  /** Warehouse type, e.g. INTEGER, STRING, TIMESTAMP, GEOGRAPHY. */
  type: string;
}

export interface CatalogEntry {
  table: string;
  rows: number | null;
  bytes: number | null;
  columns: CatalogColumn[];
  geomField?: string;
  lastModified?: number;
  /** Where it came from: the free connections API, the free __TABLES__ fallback (no columns), or nothing. */
  via: 'connections-api' | '__TABLES__' | 'none';
  fetchedAt: number;
  /** Model version this entry was fetched for (cache key part). */
  version: string;
  error?: string;
}

/** Physical catalog for a resolved model, by fully-qualified table. */
export interface Catalog {
  connection: string;
  entries: Record<string, CatalogEntry>;
  /** How this load was served. */
  stats: { fromMemory: number; fromStorage: number; fetched: number; failed: number; ms: number };
}
