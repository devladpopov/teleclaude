import { spawn, execSync } from "child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "fs";
import { join } from "path";
import type { JobRequest } from "./types.ts";

export interface SpawnResult {
  wrapperPid: number;
  claudePidFile: string;
}

export async function spawnClaudeDetached(
  jobDir: string,
  request: JobRequest
): Promise<SpawnResult> {
  mkdirSync(jobDir, { recursive: true });

  // Write job configuration to files
  const args: string[] = [
    request.claudePath,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    request.model || "opus",
  ];

  if (request.sessionId) {
    args.push("--resume", request.sessionId);
  }

  if (request.appendSystemPrompt) {
    args.push("--append-system-prompt", request.appendSystemPrompt);
  }

  if (request.flags && request.flags.length > 0) {
    args.push(...request.flags);
  }

  args.push("--dangerously-skip-permissions");

  writeFileSync(join(jobDir, "args.json"), JSON.stringify(args));
  writeFileSync(
    join(jobDir, "env.json"),
    JSON.stringify(request.env || process.env)
  );
  writeFileSync(join(jobDir, "cwd.txt"), request.projectPath);
  writeFileSync(join(jobDir, "msg.txt"), request.message);

  // Write the job worker script
  const workerScript = getJobWorkerScript();
  writeFileSync(join(jobDir, "worker.mjs"), workerScript);

  // Spawn bun with the worker script, detached
  const proc = spawn("bun", ["run", join(jobDir, "worker.mjs"), jobDir], {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });

  proc.unref();

  return {
    wrapperPid: proc.pid!,
    claudePidFile: join(jobDir, "claude.pid"),
  };
}

function getJobWorkerScript(): string {
  return `import { spawn } from "child_process";
import { readFileSync, writeFileSync, createWriteStream, createReadStream } from "fs";
import { join, dirname } from "path";

const jobDir = process.argv[2];
if (!jobDir) {
  console.error("Job directory not provided");
  process.exit(1);
}

try {
  const args = JSON.parse(readFileSync(join(jobDir, "args.json"), "utf-8"));
  const claudePath = args.shift();
  const projectPath = readFileSync(join(jobDir, "cwd.txt"), "utf-8").trim();
  const envData = JSON.parse(readFileSync(join(jobDir, "env.json"), "utf-8"));

  const msgStream = createReadStream(join(jobDir, "msg.txt"));
  const outStream = createWriteStream(join(jobDir, "stdout.jsonl"));
  const errStream = createWriteStream(join(jobDir, "stderr.log"));

  const proc = spawn(claudePath, args, {
    cwd: projectPath,
    env: envData,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });

  writeFileSync(join(jobDir, "claude.pid"), String(proc.pid));

  msgStream.pipe(proc.stdin);
  proc.stdout.pipe(outStream);
  proc.stderr.pipe(errStream);

  proc.on("close", (code) => {
    writeFileSync(join(jobDir, "exit-code.txt"), String(code ?? 1));
    process.exit(code ?? 1);
  });

  proc.on("error", (err) => {
    writeFileSync(join(jobDir, "error.log"), err.message);
    process.exit(1);
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  writeFileSync(join(jobDir, "error.log"), msg);
  process.exit(1);
}
`;
}

export function getPidFromFile(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  try {
    const content = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (!isNaN(pid)) return pid;
  } catch {
    // Ignore errors
  }
  return undefined;
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });

    proc.on("exit", () => resolve());
    proc.on("error", () => resolve());

    // Timeout after 5 seconds
    setTimeout(() => resolve(), 5000);
  });
}

/**
 * Check if a process has child processes (Windows).
 * If claude.exe has children (node.exe, git.exe, python.exe...),
 * it means a bash/node command is still executing.
 * Returns array of child process names, or [] if none.
 */
export function getChildProcessNames(pid: number): string[] {
  try {
    const out = execSync(
      `wmic process where "ParentProcessId=${pid}" get Name /format:csv 2>nul`,
      { timeout: 3000, encoding: "utf-8", windowsHide: true }
    );
    const names: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Node,") || trimmed === "") continue;
      const parts = trimmed.split(",");
      if (parts.length >= 2 && parts[1]) names.push(parts[1]);
    }
    return names;
  } catch {
    return [];
  }
}

export function getExitCode(jobDir: string): number | undefined {
  const exitCodeFile = join(jobDir, "exit-code.txt");
  if (!existsSync(exitCodeFile)) return undefined;
  try {
    const content = readFileSync(exitCodeFile, "utf-8").trim();
    const code = parseInt(content, 10);
    if (!isNaN(code)) return code;
  } catch {
    // Ignore errors
  }
  return undefined;
}

export function getErrorMessage(jobDir: string): string | undefined {
  const errorFile = join(jobDir, "error.log");
  if (!existsSync(errorFile)) return undefined;
  try {
    return readFileSync(errorFile, "utf-8");
  } catch {
    return undefined;
  }
}
