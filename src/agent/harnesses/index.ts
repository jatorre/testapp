import type { Harness, RunOptions } from '../types';

/**
 * Harnesses are lazy-loaded so each lands in its own chunk: keeps first paint small and
 * lets `vite build` report the bundle cost of each agent framework separately.
 */
function lazy(id: string, label: string, load: () => Promise<Harness>): Harness {
  return { id, label, run: async (opts: RunOptions) => (await load()).run(opts) };
}

export const HARNESSES: Harness[] = [
  lazy('aisdk', 'Vercel AI SDK v7', () => import('./aisdk').then((m) => m.aiSdkHarness)),
  lazy('handrolled', 'Hand-rolled (fetch + SSE)', () => import('./handrolled').then((m) => m.handrolledHarness)),
  lazy('openai-agents', 'OpenAI Agents SDK', () => import('./openai-agents').then((m) => m.openAiAgentsHarness)),
];

export function getHarness(id: string): Harness {
  return HARNESSES.find((h) => h.id === id) ?? HARNESSES[0];
}
