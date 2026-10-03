/**
 * PID watchdog of JobRegistry: when is a job finished. Uses hand-made job
 * directories instead of real workers so every case is deterministic.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JobRegistry } from "../src/job-manager.ts";
import type { JobMetadata } from "../src/types.ts";

/** A PID that surely belongs to no process: a child that already exited. */
function deadPid(): number {
  return Bun.spawnSync([process.execPath, "-e", ""]).pid;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function registryWithJob(meta: Partial<JobMetadata>, files: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "tc-watchdog-"));
  dirs.push(dataDir);
  const jobId = "job-1";
  const jobDir = join(dataDir, "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  const full: JobMetadata = {
    jobId, topicKey: "-100:1", executor: "opencode", projectPath: dataDir, claudePath: "",
    state: "running", startedAt: Date.now(), lastEventAt: Date.now(), idleTimeoutMinutes: 5,
    stepCount: 0, message: "hi", ...meta,
  };
  writeFileSync(join(jobDir, "meta.json"), JSON.stringify(full));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(jobDir, name), content);
  const registry = new JobRegistry(dataDir);
  (registry as any).loadFromDisk();
  return { registry, jobId, jobDir, check: () => (registry as any).checkProcesses() };
}

describe("PID watchdog", () => {
  test("CLI exited but the worker is still writing: the job keeps running until exit-code.txt", () => {
    // The worker appends the runner_exit line and writes exit-code.txt after
    // the CLI exits; finishing on the CLI pid alone reports a clean run as
    // "failed" with no exit code and can drop the last event.
    const { registry, jobId, jobDir, check } = registryWithJob({ pid: deadPid(), wrapperPid: process.pid });
    check();
    expect(registry.getJob(jobId)!.state).toBe("running");

    writeFileSync(join(jobDir, "exit-code.txt"), "0");
    check();
    expect(registry.getJob(jobId)!.state).toBe("completed");
    expect(registry.getJob(jobId)!.exitCode).toBe(0);
  });

  test("exit-code.txt decides the state", () => {
    const { registry, jobId, check } = registryWithJob({ pid: deadPid(), wrapperPid: deadPid() }, { "exit-code.txt": "1" });
    check();
    expect(registry.getJob(jobId)!.state).toBe("failed");
    expect(registry.getJob(jobId)!.exitCode).toBe(1);
  });

  test("CLI and worker both gone without an exit code: failed", () => {
    const { registry, jobId, check } = registryWithJob({ pid: deadPid(), wrapperPid: deadPid() });
    check();
    expect(registry.getJob(jobId)!.state).toBe("failed");
    expect(registry.getJob(jobId)!.exitCode).toBeUndefined();
  });

  test("the CLI never started (no claude.pid) and the worker exits: failed, not running forever", async () => {
    // e.g. the executor binary is missing: spawn fails, the worker exits 1
    const worker = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"]);
    const { registry, jobId, check } = registryWithJob({ wrapperPid: worker.pid });
    check();
    expect(registry.getJob(jobId)!.state).toBe("running");
    worker.kill();
    await worker.exited;
    check();
    expect(registry.getJob(jobId)!.state).toBe("failed");
  });

  test("worker alive and CLI pid not written yet: still starting", () => {
    const { registry, jobId, check } = registryWithJob({ wrapperPid: process.pid });
    check();
    expect(registry.getJob(jobId)!.state).toBe("running");
  });

  test("CLI alive: running", () => {
    const { registry, jobId, check } = registryWithJob({ pid: process.pid, wrapperPid: deadPid() });
    check();
    expect(registry.getJob(jobId)!.state).toBe("running");
  });
});
