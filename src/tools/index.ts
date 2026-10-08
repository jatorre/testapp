import type { AgentTool } from '../agent/types';
import { createFsTools } from './fs';
import { createBigQueryTools } from './bigquery';
import { createDuckDbTools } from './duckdb';
import { createPythonTools } from './python';
import { createChartTools } from './chart';
import { createMcpTools } from './mcp';

/** Tool groups a demo can enable. Each module owns one group. */
export type ToolGroup = 'fs' | 'bigquery' | 'duckdb' | 'python' | 'chart' | 'mcp';

const factories: Record<ToolGroup, () => Promise<AgentTool[]> | AgentTool[]> = {
  fs: createFsTools,
  bigquery: createBigQueryTools,
  duckdb: createDuckDbTools,
  python: createPythonTools,
  chart: createChartTools,
  mcp: createMcpTools,
};

export async function buildTools(groups: ToolGroup[]): Promise<AgentTool[]> {
  const lists = await Promise.all(groups.map((g) => factories[g]()));
  return lists.flat();
}
