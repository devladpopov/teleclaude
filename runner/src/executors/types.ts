import type { ExecutorId, JobRequest } from "../types.ts";
import type { ParsedEvent } from "../stream-parser.ts";

/** Everything the detached worker needs to start the executor CLI. */
export interface ExecutorLaunch {
  /** argv[0] is the binary, the rest are its arguments. */
  args: string[];
  /** Variables added on top of the request env (or process.env). */
  env?: Record<string, string>;
  /** Extra files written into the job directory before the start. */
  files?: Record<string, string>;
  /**
   * When the CLI exits with a non-zero code, append one
   * {"type":"runner_exit", code, stderr} line to stdout.jsonl so the
   * parser can turn CLI errors that never reach stdout (opencode prints
   * "Session not found" only to stderr) into a normal result event.
   */
  exitEvent?: boolean;
}

/** Stateful line parser: one instance per job. */
export type LineParser = (jsonLine: string) => ParsedEvent | null;

export interface Executor {
  id: ExecutorId;
  /** jobDir is absolute; files from `files` will be created inside it. */
  launch(request: JobRequest, jobDir: string): ExecutorLaunch;
  createParser(): LineParser;
}
