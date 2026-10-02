export type ExecutorId = "claude" | "opencode";

/**
 * OpenAI-compatible provider for the opencode executor. The key itself is
 * never written to the generated config: it is passed only in the job env
 * under apiKeyEnv and referenced as {env:NAME}.
 */
export interface ProviderSpec {
  id: string;
  name?: string;
  baseURL: string;
  model: string;
  apiKeyEnv?: string;
  npm?: string;
}

export interface JobRequest {
  topicKey: string;
  /** CLI that runs the job. Default "claude" (unchanged behaviour). */
  executor?: ExecutorId;
  /** Binary of a non-claude executor; default is the executor name in PATH. */
  executorPath?: string;
  provider?: ProviderSpec;
  projectPath: string;
  message: string;
  sessionId?: string;
  model?: string;
  appendSystemPrompt?: string;
  env?: Record<string, string>;
  flags?: string[];
  /** Required for executor "claude"; ignored by other executors. */
  claudePath: string;
  idleTimeoutMinutes?: number;
}

export type JobState =
  | "spawning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface JobMetadata {
  jobId: string;
  topicKey: string;
  executor?: ExecutorId;
  projectPath: string;
  claudePath: string;
  state: JobState;
  pid?: number;
  wrapperPid?: number;
  startedAt: number;
  completedAt?: number;
  lastEventAt: number;
  idleTimeoutMinutes: number;
  stepCount: number;
  currentTool?: string;
  toolDetail?: string;
  sessionId?: string;
  exitCode?: number;
  model?: string;
  message: string;
  appendSystemPrompt?: string;
  env?: Record<string, string>;
  flags?: string[];
}

export interface JobStatus {
  jobId: string;
  topicKey: string;
  executor?: ExecutorId;
  state: JobState;
  pid?: number;
  startedAt: number;
  lastEventAt: number;
  stepCount: number;
  currentTool?: string;
  toolDetail?: string;
  sessionId?: string;
  exitCode?: number;
}
