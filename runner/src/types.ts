export interface JobRequest {
  topicKey: string;
  projectPath: string;
  message: string;
  sessionId?: string;
  model?: string;
  appendSystemPrompt?: string;
  env?: Record<string, string>;
  flags?: string[];
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
