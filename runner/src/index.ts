import { join } from "path";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { JobRegistry } from "./job-manager.ts";
import { RunnerServer } from "./server.ts";

const DATA_DIR = join(import.meta.dir, "..", "data");
const PID_FILE = join(DATA_DIR, ".runner.pid");
const PORT_FILE = join(DATA_DIR, ".runner.port");
const BASE_PORT = parseInt(process.env.CLAUDE_RUNNER_PORT || "7878", 10);
const MAX_PORT_OFFSET = 5; // will try 7878..7883
const MAX_CONCURRENT = parseInt(process.env.CLAUDE_RUNNER_MAX_CONCURRENT || "15", 10);

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  log("Starting claude-runner");
  log(`  basePort=${BASE_PORT}, maxConcurrent=${MAX_CONCURRENT}`);
  log(`  dataDir=${DATA_DIR}`);

  // Single-instance lock
  const existingPid = readExistingPid();
  if (existingPid && isProcessAlive(existingPid)) {
    log(`Another instance is running (PID ${existingPid}). Exiting.`);
    process.exit(1);
  }

  writePidFile();

  // Initialize job registry (loads persisted state)
  const registry = new JobRegistry(DATA_DIR);
  await registry.initialize();

  const activeJobs = registry.getActiveJobCount();
  const totalJobs = registry.listJobs().length;
  log(`Loaded ${totalJobs} jobs from disk (${activeJobs} active)`);

  // Start HTTP server — try base port, fall back to next ports on EADDRINUSE
  // This handles zombie sockets from dead processes on Windows
  let boundPort = BASE_PORT;
  let started = false;

  for (let offset = 0; offset <= MAX_PORT_OFFSET; offset++) {
    const tryPort = BASE_PORT + offset;
    const server = new RunnerServer(registry, tryPort, MAX_CONCURRENT);
    try {
      await server.start();
      boundPort = tryPort;
      started = true;
      if (offset > 0) {
        log(`Bound to fallback port ${tryPort} (base port ${BASE_PORT} was unavailable)`);
      }
      break;
    } catch (err: unknown) {
      const isAddrInUse = err instanceof Error &&
        (err.message.includes("EADDRINUSE") || (err as any).code === "EADDRINUSE");
      if (isAddrInUse && offset < MAX_PORT_OFFSET) {
        log(`EADDRINUSE on port ${tryPort}, trying ${tryPort + 1}...`);
        continue;
      }
      throw err;
    }
  }

  if (!started) {
    throw new Error(`Could not bind to any port in range ${BASE_PORT}..${BASE_PORT + MAX_PORT_OFFSET}`);
  }

  // Write actual port to file so router + watchdog can discover it
  writePortFile(boundPort);

  // Graceful shutdown — stop accepting new jobs, save state.
  // Running claude.exe processes are detached and will continue.
  const shutdown = () => {
    log("Shutting down (detached claude processes will continue)");
    registry.cleanup();
    cleanupPidFile();
    cleanupPortFile();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  log("Ready to accept jobs");
}

function readExistingPid(): number | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

function writePidFile(): void {
  try {
    writeFileSync(PID_FILE, String(process.pid));
  } catch (err) {
    log(`Warning: Could not write PID file: ${err}`);
  }
}

function writePortFile(port: number): void {
  try {
    writeFileSync(PORT_FILE, String(port));
    log(`Wrote port file: ${PORT_FILE} = ${port}`);
  } catch (err) {
    log(`Warning: Could not write port file: ${err}`);
  }
}

function cleanupPidFile(): void {
  try {
    if (existsSync(PID_FILE)) {
      const content = readFileSync(PID_FILE, "utf-8").trim();
      if (content === String(process.pid)) {
        unlinkSync(PID_FILE);
      }
    }
  } catch {}
}

function cleanupPortFile(): void {
  try {
    if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE);
  } catch {}
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function log(msg: string): void {
  console.log(`[Runner] [${new Date().toISOString()}] ${msg}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  cleanupPidFile();
  process.exit(1);
});