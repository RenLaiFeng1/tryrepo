import type { ToolHost } from "../tools.js";

export interface AgentRunOptions {
  system: string;
  task: string;
  host: ToolHost;
  runDir: string;
  /** Epoch ms. Tools refuse work after this; the agent is stopped a little later. */
  deadline: number;
  model?: string;
  signal: AbortSignal;
  /** Short narration from the agent, for display. */
  onText?: (text: string) => void;
  /** Append a line to the run's agent log file. */
  log: (line: string) => void;
}

export interface AgentOutcome {
  agent: string;
  model?: string;
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  /** Set when the agent could not do its job for a reason other than the project itself. */
  error?: string;
}

/** Grace period after the deadline for the agent to submit its report. */
export const REPORT_GRACE_MS = 3 * 60_000;
