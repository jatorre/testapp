# Harnesses + agent loop — findings

Three interchangeable harnesses behind `src/agent/types.ts#Harness`. All three run tools through the same
`runTool` (`src/agent/harnesses/common.ts`), so timing, output caps and error handling are identical.

## Results
Mock suite (`npx playwright test`): 9/9. Real CARTO LiteLLM smoke (`REAL_LLM=1 npx playwright test`), demo 1
("write a CSV, average prices with awk") on `carto::claude-sonnet-5`:

| Harness | Steps | Tool calls | Tokens in / out | Wall time | Tool time |
|---|---|---|---|---|---|
| aisdk (Vercel AI SDK 7) | 3 | 2 | 4899 / 539 | 19.5 s | 31 ms |
| handrolled (fetch + SSE) | 4 | 3 | 6810 / 674 | 9.6 s | 31 ms |
| openai-agents (@openai/agents 0.19) | 3 | 2 | 4792 / 614 | 8.5 s | 22 ms |

Wall times are single runs (LLM latency noise, not a ranking). Tool time is negligible: the browser tools are
not the bottleneck; the LLM is.

## Model availability on the proxy
`/v1/models` lists 10 models, but only 5 accept `/chat/completions`: `gemini-3.8-flash`, `gemini-3.1-pro`,
`claude-opus-5.5`, `claude-sonnet-5`, `claude-opus-4.8`. The other 5 (`gemini-3.7-flash`, `gemini-3.5-flash`,
`claude-opus-4.7`, `claude-opus-4.6`, `claude-sonnet-4.6`) return `400 Invalid model name`. The model list is
not a reliable capability signal.

## Size and cost per harness
| Harness | LOC | Own chunk (gzip) |
|---|---|---|
| handrolled | 123 | 1.3 KB |
| aisdk | 80 | 74 KB |
| openai-agents | 83 | 108 KB |

Shared: 50 LOC `common.ts`, plus ~37 KB of zod/JSON-schema chunks. Other notable chunks: just-bash 352 KB, plus
vega and MCP.

## Browser compatibility and quirks
- All three run in the browser without polyfills.
- **OpenAI Agents** needs `dangerouslyAllowBrowser: true` and **`setTracingDisabled(true)`** — otherwise it ships
  traces to api.openai.com *with our CARTO token*. This is a security footgun to call out.
- just-bash's `gzip` relies on `node:zlib`, so it fails in the browser (minor).
- **Streaming tool calls:** fragments are keyed by `index`, and the id/name come only on the first fragment. The
  usage chunk arrives with `choices: []` (needs `stream_options.include_usage`).
- **Usage fields:**
  - AI SDK: `finish-step.usage`, cached tokens in `inputTokenDetails.cacheReadTokens`.
  - OpenAI Agents: usage on `response_done`.
  - Hand-rolled: `prompt_tokens_details.cached_tokens` or `cache_read_input_tokens`.
- Tools are passed to the SDKs as plain JSON Schema (not zod), so invalid arguments reach our own validation and
  go back to the model consistently across harnesses.
- OpenAI Agents throws on `maxTurns`; we treat that as a normal stop.

## Takeaway
The agent loop itself is the cheap part: ~120 lines and ~1 KB is enough for streaming, parallel tool calls, step
caps and usage. Frameworks buy convenience (AI SDK: typed stream parts; Agents: handoffs/guardrails) at 70–110 KB,
with no capability we needed that the hand-rolled loop lacked.
