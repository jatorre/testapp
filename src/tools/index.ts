import type { AgentTool } from '../agent/types';
import { createFsTools } from './fs';
import { createBigQueryTools } from './bigquery';
import { createDuckDbTools } from './duckdb';
import { createPythonTools } from './python';
import { createChartTools } from './chart';
import { createMcpTools } from './mcp';
import { createSqlDirectTools } from './sqldirect';
import { createWebTools } from './web';
import { createAttachTools } from './attach';
import { createWarehouseTools } from './warehouse';
import { createDuckDbJoinTools } from './duckdbjoin';
import { createFetchTools } from './fetchurl';
import { createSemanticTools } from './semantic';
import { createMapTools } from './map';

/** Tool groups a demo can enable. Each module owns one group. */
export type ToolGroup = 'fs' | 'bigquery' | 'duckdb' | 'python' | 'chart' | 'mcp' | 'sql' | 'web' | 'attach' | 'warehouse' | 'duckdb_join' | 'fetch' | 'semantic' | 'map';

const factories: Record<ToolGroup, () => Promise<AgentTool[]> | AgentTool[]> = {
  fs: createFsTools,
  bigquery: createBigQueryTools,
  duckdb: createDuckDbTools,
  python: createPythonTools,
  chart: createChartTools,
  mcp: createMcpTools,
  sql: createSqlDirectTools,
  web: createWebTools,
  attach: createAttachTools,
  warehouse: createWarehouseTools,
  duckdb_join: createDuckDbJoinTools,
  fetch: createFetchTools,
  semantic: createSemanticTools,
  map: createMapTools,
};

export async function buildTools(groups: ToolGroup[]): Promise<AgentTool[]> {
  const lists = await Promise.all(groups.map((g) => factories[g]()));
  return lists.flat();
}
