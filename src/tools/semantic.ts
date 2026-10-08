import { z } from 'zod';
import type { AgentTool } from '../agent/types';
import { getAllSources } from '../semantic';
import { loadCatalog } from '../semantic/catalog';
import { describeSourcePayload, listSourcesPayload, metricPayload } from '../semantic/render';

/**
 * Semantic-layer tools: answer "what is in this table / how is this metric defined" from the semantic model and
 * the cached catalog (CARTO connections API, free), never with a warehouse query.
 */
export function createSemanticTools(): AgentTool[] {
  const model = getAllSources();

  const listSources: AgentTool<Record<string, never>> = {
    name: 'list_sources',
    description: 'List the data sources you may use (logical name, fully-qualified table, description, rows, size) and the defined metrics. Free: no warehouse query.',
    inputSchema: z.object({}),
    async execute(_i, ctx) {
      return listSourcesPayload(model, await loadCatalog(model, { signal: ctx.signal }));
    },
  };

  const describeSource: AgentTool<{ name: string }> = {
    name: 'describe_source',
    description:
      'Full detail of one source from the semantic model and cached catalog: every column with type, meaning, allowed values and units; ' +
      'grain, keys, geo columns, gotchas, joins and metrics. Free and instant: use it instead of INFORMATION_SCHEMA or probe queries.',
    inputSchema: z.object({ name: z.string().describe('Source name (e.g. "order_items") or fully-qualified table') }),
    async execute({ name }, ctx) {
      return describeSourcePayload(model, name, await loadCatalog(model, { signal: ctx.signal }));
    },
  };

  const getMetric: AgentTool<{ name: string }> = {
    name: 'get_metric',
    description: 'Definition of a named metric (e.g. net_revenue, aov): SQL expression, mandatory filter, joins and a ready-to-adapt example query.',
    inputSchema: z.object({ name: z.string().describe('Metric name, e.g. "net_revenue"') }),
    async execute({ name }) {
      return metricPayload(model, name);
    },
  };

  return [listSources, describeSource, getMetric];
}
