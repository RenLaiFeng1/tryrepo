import { TOOL_DEFS } from "../tools.js";
import { errorMessage, sleep, truncateMiddle } from "../util.js";
import { REPORT_GRACE_MS, type AgentOutcome, type AgentRunOptions } from "./types.js";

/** Built-in agent loop for any OpenAI-compatible Chat Completions API (OpenAI, DeepSeek, Kimi, GLM, Qwen, OpenRouter, Ollama...). */
export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface Completion {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

const MAX_STEPS = 250;
const KEEP_FULL_TOOL_RESULTS = 8;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const IDLE_TIMEOUT_MS = 3 * 60_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function retryable(err: unknown): boolean {
  if (err instanceof HttpError) return [408, 409, 425, 429].includes(err.status) || err.status >= 500;
  return !(err instanceof Error && err.name === "AbortError");
}

/** Shrink old tool outputs so long sessions stay within the model's context window. */
export function trimHistory(messages: Message[]): void {
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_FULL_TOOL_RESULTS))) {
    const m = messages[i];
    if (m && typeof m.content === "string" && m.content.length > 700) {
      m.content = `${m.content.slice(0, 350)}\n...[older output trimmed by tryrepo]...\n${m.content.slice(-250)}`;
    }
  }
}

function linkSignals(outer: AbortSignal, timeoutMs: number): { signal: AbortSignal; touch(): void; dispose(): void } {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  outer.addEventListener("abort", abort, { once: true });
  const hard = setTimeout(abort, timeoutMs);
  let idle = setTimeout(abort, IDLE_TIMEOUT_MS);
  return {
    signal: ctrl.signal,
    touch: () => {
      clearTimeout(idle);
      idle = setTimeout(abort, IDLE_TIMEOUT_MS);
    },
    dispose: () => {
      clearTimeout(hard);
      clearTimeout(idle);
      outer.removeEventListener("abort", abort);
    },
  };
}

/** One streaming chat completion. Parses SSE and accumulates text and tool-call deltas. */
export async function streamCompletion(
  cfg: OpenAIConfig,
  messages: Message[],
  tools: unknown[],
  outerSignal: AbortSignal,
): Promise<Completion> {
  const link = linkSignals(outerSignal, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: "auto", stream: true }),
      signal: link.signal,
    });
    if (!res.ok || !res.body) {
      const body = (await res.text().catch(() => "")).slice(0, 600);
      const ra = Number(res.headers.get("retry-after"));
      throw new HttpError(res.status, `HTTP ${res.status}: ${body || res.statusText}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }
    const out: Completion = { content: "", toolCalls: [] };
    let reasoning = "";
    const calls: { id: string; name: string; args: string }[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      link.touch();
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let j: Record<string, unknown>;
        try {
          j = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (j.error) throw new HttpError(500, `stream error: ${JSON.stringify(j.error).slice(0, 400)}`);
        if (j.usage) out.usage = j.usage as Completion["usage"];
        const choice = (j.choices as Record<string, unknown>[] | undefined)?.[0];
        const delta = (choice?.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === "string") out.content += delta.content;
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        for (const tc of (delta.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
          const index = typeof tc.index === "number" ? tc.index : calls.length;
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          const slot = (calls[index] ??= { id: "", name: "", args: "" });
          if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
          if (typeof fn.name === "string") slot.name += fn.name;
          if (typeof fn.arguments === "string") slot.args += fn.arguments;
        }
      }
      if (done) break;
    }
    out.toolCalls = calls
      .filter((c) => c && c.name)
      .map((c, i) => ({ id: c.id || `call_${i}_${Date.now()}`, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
    if (reasoning) out.reasoning = reasoning;
    return out;
  } finally {
    link.dispose();
  }
}

export async function runOpenAIAgent(opts: AgentRunOptions & { config: OpenAIConfig }): Promise<AgentOutcome> {
  const { config, host } = opts;
  const outcome: AgentOutcome = { agent: "openai", model: config.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 };
  const tools = TOOL_DEFS.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.inputSchema } }));
  const messages: Message[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.task },
  ];
  let idleTurns = 0;
  let timeUpNotified = false;

  for (let step = 0; step < MAX_STEPS && !host.report && !opts.signal.aborted; step++) {
    const now = Date.now();
    if (now > opts.deadline + REPORT_GRACE_MS) {
      outcome.error = "the agent ran out of time without reporting";
      break;
    }
    if (now > opts.deadline && !timeUpNotified) {
      timeUpNotified = true;
      messages.push({ role: "user", content: "Time is up. Call report_success or report_failure now." });
    }
    trimHistory(messages);
    let completion: Completion | undefined;
    for (let attempt = 1; attempt <= 6 && !opts.signal.aborted; attempt++) {
      try {
        completion = await streamCompletion(config, messages, tools, opts.signal);
        break;
      } catch (err) {
        opts.log(`[openai] request failed (attempt ${attempt}): ${errorMessage(err)}`);
        if (!retryable(err) || attempt === 6) {
          outcome.error = `the model API failed: ${errorMessage(err)}`;
          return outcome;
        }
        const hint = err instanceof HttpError ? err.retryAfterMs : undefined;
        await sleep(Math.min(60_000, hint ?? 2000 * 2 ** (attempt - 1)), opts.signal);
      }
    }
    if (!completion) break;
    outcome.turns++;
    outcome.inputTokens += completion.usage?.prompt_tokens ?? 0;
    outcome.outputTokens += completion.usage?.completion_tokens ?? 0;
    outcome.cacheReadTokens += completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    if (completion.content.trim()) opts.onText?.(completion.content);
    opts.log(`[openai] turn ${outcome.turns}: ${completion.toolCalls.length} tool call(s); text: ${truncateMiddle(completion.content, 600)}`);

    const assistant: Message = { role: "assistant", content: completion.content || null };
    if (completion.toolCalls.length) assistant.tool_calls = completion.toolCalls;
    if (completion.reasoning) assistant.reasoning_content = completion.reasoning;
    messages.push(assistant);

    if (!completion.toolCalls.length) {
      if (++idleTurns > 3) {
        outcome.error = "the model stopped using tools without reporting a result";
        break;
      }
      messages.push({
        role: "user",
        content: "Continue the task using the tools. When you are done, call report_success or report_failure.",
      });
      continue;
    }
    idleTurns = 0;
    for (const call of completion.toolCalls) {
      let args: unknown;
      let text: string;
      try {
        args = JSON.parse(call.function.arguments || "{}");
        const r = await host.call(call.function.name, args);
        text = r.isError ? `ERROR: ${r.text}` : r.text;
      } catch (err) {
        text = `ERROR: invalid JSON in tool arguments (${errorMessage(err)}). Send valid JSON.`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
      if (opts.signal.aborted) break;
    }
  }
  if (!host.report && !outcome.error && !opts.signal.aborted) outcome.error = "the agent used all its steps without reporting";
  return outcome;
}
