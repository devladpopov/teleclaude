import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  spawnJobDetached,
  getPidFromFile,
  isProcessAlive,
  killProcessTree,
  getExitCode,
  getErrorMessage,
  getChildProcessNames,
} from "./spawn.ts";
import { getExecutor } from "./executors/index.ts";
import { FileTailer } from "./file-tailer.ts";
import type { JobRequest, JobMetadata, JobStatus } from "./types.ts";

/**
 * JobRegistry manages the lifecycle of all claude jobs.
 *
 * Each job lives in data/jobs/<jobId>/ with:
 *   meta.json     — serialized JobMetadata
 *   msg.txt       — input message
 *   args.json     — CLI arguments for claude
 *   env.json      — environment variables (the worker deletes it right after start)
 *   cwd.txt       — working directory
 *   worker.mjs    — detached worker script
 *   stdout.jsonl  — claude's stream-json output (written by worker)
 *   stderr.log    — claude's stderr (written by worker)
 *   claude.pid    — claude.exe PID (written by worker)
 *   exit-code.txt — exit code (written by worker on close)
 */
export class JobRegistry {
  private dataDir: string;
  private jobs = new Map<string, JobMetadata>();
  private tailers = new Map<string, FileTailer>();
  private idleCheckHandle: ReturnType<typeof setInterval> | null = null;
  private pidCheckHandle: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, "jobs"), { recursive: true });
  }

  async initialize(): Promise<void> {
    this.loadFromDisk();
    this.startIdleWatchdog();
    this.startPidWatchdog();
    this.cleanupOldJobs();
  }

  // ─── Load persisted state ───────────────────────────────────
  private loadFromDisk(): void {
    const jobsDir = join(this.dataDir, "jobs");
    if (!existsSync(jobsDir)) return;

    let entries: string[];
    try {
      entries = readdirSync(jobsDir);
    } catch {
      return;
    }

    for (const jobId of entries) {
      const metaFile = join(jobsDir, jobId, "meta.json");
      if (!existsSync(metaFile)) continue;

      try {
        const meta = JSON.parse(readFileSync(metaFile, "utf-8")) as JobMetadata;

        // Check if supposedly-running jobs are still alive
        if (meta.state === "running" || meta.state === "spawning") {
          const alive = this.isJobProcessAlive(meta);
          if (!alive) {
            const exitCode = getExitCode(join(jobsDir, jobId));
            meta.state = exitCode === 0 ? "completed" : "failed";
            meta.exitCode = exitCode;
            meta.completedAt = Date.now();
            this.saveToDisk(jobId, meta);
            this.log(`Recovered dead job ${jobId}: state=${meta.state}, exit=${exitCode}`);
          }
        }

        this.jobs.set(jobId, meta);

        // Restart tailer for running jobs
        if (meta.state === "running") {
          const tailer = new FileTailer(join(jobsDir, jobId), getExecutor(meta.executor).createParser());
          tailer.start();
          this.tailers.set(jobId, tailer);
          this.log(`Reattached tailer for running job ${jobId} (topic ${meta.topicKey})`);
        }
      } catch (err) {
        this.log(`Skipping malformed job ${jobId}: ${err}`);
      }
    }
  }

  // ─── Create new job ─────────────────────────────────────────
  async createJob(request: JobRequest): Promise<string> {
    const jobId = randomUUID();
    const jobDir = join(this.dataDir, "jobs", jobId);

    const meta: JobMetadata = {
      jobId,
      topicKey: request.topicKey,
      executor: getExecutor(request.executor).id,
      projectPath: request.projectPath,
      claudePath: request.claudePath,
      state: "spawning",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      idleTimeoutMinutes: request.idleTimeoutMinutes || 5,
      stepCount: 0,
      message: request.message,
      appendSystemPrompt: request.appendSystemPrompt,
      // request.env is NOT persisted: it carries the router secrets and
      // provider keys, and meta.json stays on disk after the job.
      flags: request.flags,
    };

    try {
      const result = await spawnJobDetached(jobDir, request);
      meta.wrapperPid = result.wrapperPid;
      meta.state = "running";

      // Wait up to 2s for claude.pid to appear (worker writes it)
      let claudePid: number | undefined;
      for (let i = 0; i < 20; i++) {
        claudePid = getPidFromFile(result.claudePidFile);
        if (claudePid) break;
        await Bun.sleep(100);
      }

      if (claudePid) {
        meta.pid = claudePid;
        this.log(`Job ${jobId} spawned: wrapper=${meta.wrapperPid}, claude=${claudePid}, topic=${meta.topicKey}`);
      } else {
        this.log(`Job ${jobId} spawned: wrapper=${meta.wrapperPid}, claude PID not yet available`);
      }

      // Start tailing stdout.jsonl
      const tailer = new FileTailer(jobDir, getExecutor(meta.executor).createParser());
      tailer.start();
      this.tailers.set(jobId, tailer);
    } catch (err) {
      meta.state = "failed";
      meta.completedAt = Date.now();
      this.log(`Job ${jobId} failed to spawn: ${err}`);
    }

    this.saveToDisk(jobId, meta);
    this.jobs.set(jobId, meta);
    return jobId;
  }

  // ─── Getters ────────────────────────────────────────────────
  getJob(jobId: string): JobMetadata | undefined {
    return this.jobs.get(jobId);
  }

  getJobStatus(jobId: string): JobStatus | undefined {
    const meta = this.jobs.get(jobId);
    if (!meta) return undefined;
    return {
      jobId: meta.jobId,
      topicKey: meta.topicKey,
      executor: meta.executor,
      state: meta.state,
      pid: meta.pid,
      startedAt: meta.startedAt,
      lastEventAt: meta.lastEventAt,
      stepCount: meta.stepCount,
      currentTool: meta.currentTool,
      toolDetail: meta.toolDetail,
      sessionId: meta.sessionId,
      exitCode: meta.exitCode,
    };
  }

  listJobs(filter?: { active?: boolean; topicKey?: string }): JobMetadata[] {
    let jobs = Array.from(this.jobs.values());
    if (filter?.active) {
      jobs = jobs.filter((j) => j.state === "running" || j.state === "spawning");
    }
    if (filter?.topicKey) {
      jobs = jobs.filter((j) => j.topicKey === filter.topicKey);
    }
    return jobs;
  }

  getActiveJobCount(): number {
    return Array.from(this.jobs.values()).filter(
      (j) => j.state === "running" || j.state === "spawning"
    ).length;
  }

  getTailer(jobId: string): FileTailer | undefined {
    return this.tailers.get(jobId);
  }

  updateJobMetadata(jobId: string, updates: Partial<JobMetadata>): void {
    const meta = this.jobs.get(jobId);
    if (!meta) return;
    Object.assign(meta, updates);
    // Don't persist on every event — too much disk I/O.
    // saveToDisk is called by finishJob and cancelJob.
  }

  // ─── Cancel / Kill ──────────────────────────────────────────
  async cancelJob(jobId: string): Promise<boolean> {
    const meta = this.jobs.get(jobId);
    if (!meta) return false;
    if (meta.state !== "running" && meta.state !== "spawning") return false;

    // Kill the wrapper process tree (which includes claude.exe)
    const pid = meta.wrapperPid || meta.pid;
    if (pid) {
      await killProcessTree(pid);
    }

    this.finishJob(jobId, "cancelled");
    return true;
  }

  // ─── Cleanup ────────────────────────────────────────────────
  cleanup(): void {
    this.stopIdleWatchdog();
    this.stopPidWatchdog();
    for (const tailer of this.tailers.values()) {
      tailer.stop();
    }
    // Save all running jobs so we can recover them on restart
    for (const meta of this.jobs.values()) {
      this.saveToDisk(meta.jobId, meta);
    }
  }

  // ─── Internal ───────────────────────────────────────────────
  private finishJob(jobId: string, state: "completed" | "failed" | "timeout" | "cancelled"): void {
    const meta = this.jobs.get(jobId);
    if (!meta) return;

    const jobDir = join(this.dataDir, "jobs", jobId);
    const exitCode = getExitCode(jobDir);

    meta.state = state;
    meta.exitCode = exitCode;
    meta.completedAt = Date.now();
    this.saveToDisk(jobId, meta);

    const tailer = this.tailers.get(jobId);
    if (tailer) {
      tailer.markComplete();
      // Give SSE subscribers 2s to receive the completion event,
      // then stop the tailer.
      setTimeout(() => {
        tailer.stop();
        this.tailers.delete(jobId);
      }, 2000);
    }

    this.log(`Job ${jobId} finished: state=${state}, exit=${exitCode}, topic=${meta.topicKey}`);
  }

  private saveToDisk(jobId: string, meta: JobMetadata): void {
    const jobDir = join(this.dataDir, "jobs", jobId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  }

  // ─── PID watchdog: detect finished processes ────────────────
  private startPidWatchdog(): void {
    if (this.pidCheckHandle) return;
    this.pidCheckHandle = setInterval(() => this.checkProcesses(), 2000);
  }

  private stopPidWatchdog(): void {
    if (this.pidCheckHandle) {
      clearInterval(this.pidCheckHandle);
      this.pidCheckHandle = null;
    }
  }

  private checkProcesses(): void {
    for (const meta of this.jobs.values()) {
      if (meta.state !== "running") continue;
      const jobDir = join(this.dataDir, "jobs", meta.jobId);

      // Try to read claude.pid if we don't have it yet
      if (!meta.pid) {
        const pid = getPidFromFile(join(jobDir, "claude.pid"));
        if (pid) meta.pid = pid;
      }

      // The worker writes exit-code.txt last, after the CLI output and the
      // runner_exit line are on disk: that is the end of the job.
      const exitCode = getExitCode(jobDir);
      if (exitCode !== undefined) {
        this.finishJob(meta.jobId, exitCode === 0 ? "completed" : "failed");
        continue;
      }

      // No exit code yet: running while the CLI or the worker is alive
      // (the worker may still be flushing, or the CLI is still starting).
      if (meta.pid && isProcessAlive(meta.pid)) continue;
      if (meta.wrapperPid && isProcessAlive(meta.wrapperPid)) continue;

      // Both gone without an exit code: killed or crashed.
      this.finishJob(meta.jobId, "failed");
    }
  }

  // ─── Idle watchdog: kill stuck processes ─────────────────────
  private startIdleWatchdog(): void {
    if (this.idleCheckHandle) return;
    this.idleCheckHandle = setInterval(() => this.checkIdleJobs(), 15000);
  }

  private stopIdleWatchdog(): void {
    if (this.idleCheckHandle) {
      clearInterval(this.idleCheckHandle);
      this.idleCheckHandle = null;
    }
  }

  private async checkIdleJobs(): Promise<void> {
    const now = Date.now();
    const IGNORED_CHILDREN = new Set(["conhost.exe"]);

    for (const meta of this.jobs.values()) {
      if (meta.state !== "running") continue;

      const idleMs = meta.idleTimeoutMinutes * 60000;
      if (now - meta.lastEventAt > idleMs) {
        // Before killing, check if claude.exe has active child processes
        // (node.exe, git.exe, python.exe etc.) — means a command is executing
        const pid = meta.pid;
        if (pid) {
          const children = getChildProcessNames(pid);
          const activeChildren = children.filter(
            (n) => !IGNORED_CHILDREN.has(n.toLowerCase())
          );
          if (activeChildren.length > 0) {
            this.log(
              `Idle ${Math.round((now - meta.lastEventAt) / 1000)}s for job ${meta.jobId} (topic ${meta.topicKey}), ` +
              `but has active children: [${activeChildren.join(", ")}]. Extending idle timer.`
            );
            // Reset idle timer — child process is still working
            meta.lastEventAt = now;
            continue;
          }
        }

        this.log(`Idle timeout for job ${meta.jobId} (${meta.idleTimeoutMinutes}min, topic ${meta.topicKey})`);
        const killPid = meta.wrapperPid || meta.pid;
        if (killPid) {
          await killProcessTree(killPid);
        }
        this.finishJob(meta.jobId, "timeout");
      }
    }
  }

  // ─── Old job cleanup ─────────────────────────────────────────
  private cleanupOldJobs(): void {
    const oneHour = 60 * 60 * 1000;
    const now = Date.now();
    const toDelete: string[] = [];

    for (const meta of this.jobs.values()) {
      if (meta.state === "running" || meta.state === "spawning") continue;
      if (meta.completedAt && now - meta.completedAt > oneHour) {
        toDelete.push(meta.jobId);
      }
    }

    for (const jobId of toDelete) {
      this.jobs.delete(jobId);
      this.tailers.delete(jobId);
      const jobDir = join(this.dataDir, "jobs", jobId);
      try {
        rmSync(jobDir, { recursive: true, force: true });
      } catch {}
      this.log(`Cleaned up old job ${jobId}`);
    }
  }

  private isJobProcessAlive(meta: JobMetadata): boolean {
    // Check claude PID first, then wrapper
    if (meta.pid && isProcessAlive(meta.pid)) return true;
    if (meta.wrapperPid && isProcessAlive(meta.wrapperPid)) return true;
    return false;
  }

  private log(msg: string): void {
    console.log(`[Registry] [${new Date().toISOString()}] ${msg}`);
  }
}
