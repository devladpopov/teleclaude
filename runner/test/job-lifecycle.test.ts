/**
 * Runner end to end without real CLIs: JobRegistry spawns the detached
 * worker, the worker starts a compiled fake CLI (test/fixtures/fake-cli.ts)
 * that replays recorded stream-json / opencode output, the FileTailer and
 * the executor parser turn it into router events.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JobRegistry } from "../src/job-manager.ts";
import type { ParsedEvent } from "../src/stream-parser.ts";
import type { JobMetadata, JobRequest } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");
const UUID = "0f8c2a1e-1b2c-4d5e-8f90-123456789abc";
const SES = "ses_f01618370ffezwYXLHTkQb5v8S";

let tmp: string;
let fakeCli: string;
let registry: JobRegistry;
let project: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "tc-runner-"));
  fakeCli = join(tmp, process.platform === "win32" ? "fake-cli.exe" : "fake-cli");
  const build = Bun.spawnSync([process.execPath, "build", "--compile", join(FIX, "fake-cli.ts"), "--outfile", fakeCli]);
  if (build.exitCode !== 0) throw new Error(`fake-cli build failed: ${build.stderr.toString()}`);
  project = join(tmp, "project");
  mkdirSync(project);
  registry = new JobRegistry(join(tmp, "data"));
  await registry.initialize();
}, 60_000);

afterAll(() => {
  registry?.cleanup();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

interface RunResult {
  meta: JobMetadata;
  events: ParsedEvent[];
  record?: { argv: string[]; stdin: string; cwd: string; env: Record<string, string> };
  jobDir: string;
}

/** Runs one job to the end and collects every parsed event. */
async function runJob(
  request: Partial<JobRequest>,
  fake: { stdoutFile?: string; stderr?: string; exit?: number } = {},
  timeoutMs = 10_000,
): Promise<RunResult> {
  const record = join(tmp, `record-${Math.random().toString(16).slice(2)}.json`);
  const env: Record<string, string> = {
    ...(request.env || {}),
    FAKE_RECORD: record,
    FAKE_EXIT: String(fake.exit ?? 0),
  };
  if (fake.stdoutFile) env.FAKE_STDOUT_FILE = fake.stdoutFile;
  if (fake.stderr) env.FAKE_STDERR = fake.stderr;

  const jobId = await registry.createJob({
    topicKey: "-100:1",
    projectPath: project,
    message: "привет",
    claudePath: fakeCli,
    ...request,
    env,
  } as JobRequest);

  const events: ParsedEvent[] = [];
  registry.getTailer(jobId)?.replay(-1, (e) => e.parsed && events.push(e.parsed));
  registry.getTailer(jobId)?.subscribe((e) => e.parsed && events.push(e.parsed));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = registry.getJob(jobId)!.state;
    if (state !== "running" && state !== "spawning") break;
    await Bun.sleep(100);
  }
  const jobDir = join(tmp, "data", "jobs", jobId);
  return {
    meta: registry.getJob(jobId)!,
    events,
    record: existsSync(record) ? JSON.parse(readFileSync(record, "utf-8")) : undefined,
    jobDir,
  };
}

describe("claude executor through the worker", () => {
  test("argv, stdin, cwd, session and result", async () => {
    const r = await runJob(
      { model: "sonnet", sessionId: UUID, appendSystemPrompt: "SOUL", flags: ["--mcp-config", "m.json"] },
      { stdoutFile: join(FIX, "claude", "run-ok.jsonl") },
    );
    expect(r.meta.state).toBe("completed");
    expect(r.meta.exitCode).toBe(0);
    expect(r.record!.argv).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--model", "sonnet",
      "--resume", UUID, "--append-system-prompt", "SOUL", "--mcp-config", "m.json",
      "--dangerously-skip-permissions",
    ]);
    expect(r.record!.stdin).toBe("привет");
    // realpath: Windows runners give the temp dir as an 8.3 short path
    expect(realpathSync.native(r.record!.cwd)).toBe(realpathSync.native(project));

    expect(r.events.map((e) => e.type)).toEqual(["system", "assistant", "assistant", "user", "assistant", "result"]);
    expect(r.events[0].sessionId).toBe(UUID);
    expect(r.events[2].toolName).toBe("Read");
    expect(r.events.at(-1)!.resultText).toBe("Статус IN_PROGRESS, продолжаю.");
  });

  test("job env reaches the CLI but is not kept on disk", async () => {
    const r = await runJob({ env: { ANTHROPIC_API_KEY: "sk-ant-test" } }, { stdoutFile: join(FIX, "claude", "run-ok.jsonl") });
    expect(r.record!.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(existsSync(join(r.jobDir, "env.json"))).toBe(false);
    const meta = readFileSync(join(r.jobDir, "meta.json"), "utf-8");
    expect(meta).not.toContain("sk-ant-test");
  });

  test("429 from claude stays a result with the API error text", async () => {
    const r = await runJob({}, { stdoutFile: join(FIX, "claude", "run-429.jsonl"), exit: 1 });
    expect(r.meta.state).toBe("failed");
    expect(r.meta.exitCode).toBe(1);
    const result = r.events.find((e) => e.isResult)!;
    expect(result.resultText).toStartWith("API Error: 429");
  });

  test("dead --resume target is reported as 'No conversation found'", async () => {
    const r = await runJob({ sessionId: UUID }, { stdoutFile: join(FIX, "claude", "resume-missing.jsonl"), exit: 1 });
    expect(r.meta.state).toBe("failed");
    const result = r.events.find((e) => e.isResult)!;
    expect((result.raw as any).errors[0]).toContain("No conversation found");
    // claude does not get a runner_exit line: its errors are already on stdout
    expect(r.events.some((e) => e.raw.type === "system" && e.raw.subtype === "exit")).toBe(false);
  });
});

describe("opencode executor through the worker", () => {
  const provider = {
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  };

  test("argv, config, instructions file, key only in env", async () => {
    const mcp = join(tmp, "spawn-mcp.json");
    writeFileSync(mcp, JSON.stringify({ mcpServers: { "reminder-mcp": { command: "bun", args: ["run", "server.ts"] } } }));
    const r = await runJob(
      {
        executor: "opencode",
        executorPath: fakeCli,
        claudePath: "",
        provider,
        sessionId: SES,
        appendSystemPrompt: "SOUL + topic memory",
        mcpConfigPath: mcp,
        env: { DEEPSEEK_API_KEY: "sk-deepseek" },
      },
      { stdoutFile: join(FIX, "opencode", "run-tool.jsonl") },
    );
    expect(r.meta.state).toBe("completed");
    expect(r.meta.executor).toBe("opencode");
    expect(r.record!.argv).toEqual(["run", "--format", "json", "--auto", "--model", "deepseek/deepseek-chat", "--session", SES]);
    expect(r.record!.env.DEEPSEEK_API_KEY).toBe("sk-deepseek");

    const cfg = JSON.parse(r.record!.env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.deepseek.options.apiKey).toBe("{env:DEEPSEEK_API_KEY}");
    expect(cfg.mcp["reminder-mcp"]).toEqual({ type: "local", command: ["bun", "run", "server.ts"], enabled: true });
    expect(readFileSync(cfg.instructions[0], "utf-8")).toBe("SOUL + topic memory");
    expect(JSON.stringify(cfg)).not.toContain("sk-deepseek");
    expect(readFileSync(join(r.jobDir, "meta.json"), "utf-8")).not.toContain("sk-deepseek");

    expect(r.events[0].raw).toMatchObject({ type: "system", subtype: "init", session_id: SES });
    const results = r.events.filter((e) => e.isResult);
    expect(results).toHaveLength(1);
    expect(results[0].raw.subtype).toBe("success");
  });

  test("429: one error result with 'API Error: 429', then the exit line", async () => {
    const r = await runJob(
      { executor: "opencode", executorPath: fakeCli, claudePath: "", provider },
      { stdoutFile: join(FIX, "opencode", "run-429.jsonl"), exit: 1 },
    );
    expect(r.meta.state).toBe("failed");
    expect(r.meta.exitCode).toBe(1);
    const results = r.events.filter((e) => e.isResult);
    expect(results).toHaveLength(1);
    expect(results[0].resultText).toBe("API Error: 429 Rate limit reached for requests");
    expect(r.events.at(-1)!.raw).toMatchObject({ type: "system", subtype: "exit", code: 1 });
  });

  test("'Session not found' printed only to stderr becomes a session-gone result", async () => {
    const r = await runJob(
      { executor: "opencode", executorPath: fakeCli, claudePath: "", provider, sessionId: SES },
      { stderr: "\x1b[91mError: \x1b[0mSession not found\n", exit: 1 },
    );
    expect(r.meta.state).toBe("failed");
    const result = r.events.find((e) => e.isResult)!;
    expect((result.raw as any).errors[0]).toContain("No conversation found");
    expect(result.resultText).toBeUndefined();
  });

  test("crash without output becomes an error result with stderr", async () => {
    const r = await runJob(
      { executor: "opencode", executorPath: fakeCli, claudePath: "", provider },
      { stderr: "provider deepseek: invalid baseURL", exit: 3 },
    );
    expect(r.meta.exitCode).toBe(3);
    const result = r.events.find((e) => e.isResult)!;
    expect(result.resultText).toBe("opencode exited with code 3: provider deepseek: invalid baseURL");
  });
});
