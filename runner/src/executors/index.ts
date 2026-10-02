import type { ExecutorId } from "../types.ts";
import { claudeExecutor } from "./claude.ts";
import { opencodeExecutor } from "./opencode.ts";
import type { Executor } from "./types.ts";

export type { Executor, ExecutorLaunch, LineParser } from "./types.ts";

const EXECUTORS: Record<ExecutorId, Executor> = {
  claude: claudeExecutor,
  opencode: opencodeExecutor,
};

export function isExecutorId(id: unknown): id is ExecutorId {
  return typeof id === "string" && id in EXECUTORS;
}

/** Unknown or missing id falls back to claude (backward compatibility). */
export function getExecutor(id?: string): Executor {
  return isExecutorId(id) ? EXECUTORS[id] : claudeExecutor;
}
