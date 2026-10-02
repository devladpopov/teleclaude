import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { createOpencodeParser, buildOpencodeConfig, opencodeExecutor } from "../src/executors/opencode.ts";
import { claudeExecutor } from "../src/executors/claude.ts";
import { getExecutor, isExecutorId } from "../src/executors/index.ts";
import { isValidSessionId, parseStreamJsonEvent } from "../src/stream-parser.ts";
import type { ParsedEvent } from "../src/stream-parser.ts";
import type { JobRequest } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures", "opencode");

function parseFixture(name: string, extraLines: string[] = []): ParsedEvent[] {
  const parse = createOpencodeParser();
  const lines = readFileSync(join(FIX, name), "utf-8").split("\n").filter((l) => l.trim());
  return [...lines, ...extraLines].map((l) => parse(l)).filter((e): e is ParsedEvent => e !== null);
}

const base: JobRequest = {
  topicKey: "-100:1",
  projectPath: "C:/work/project",
  message: "hi",
  claudePath: "claude",
};

describe("session ids", () => {
  test("claude UUID and opencode ses_ are valid, garbage is not", () => {
    expect(isValidSessionId("0f8c2a1e-1b2c-4d5e-8f90-123456789abc")).toBe(true);
    expect(isValidSessionId("ses_f01618370ffezwYXLHTkQb5v8S")).toBe(true);
    expect(isValidSessionId("topic-1700000000-abc")).toBe(false);
    expect(isValidSessionId("ses_; rm -rf /")).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
  });
});

describe("opencode parser on real fixtures", () => {
  test("run with a tool call: init, text, tool_use, result", () => {
    const events = parseFixture("run-tool.jsonl");
    const sid = "ses_f01618370ffezwYXLHTkQb5v8S";

    expect(events[0].raw).toMatchObject({ type: "system", subtype: "init", session_id: sid });
    expect(events.every((e) => e.sessionId === sid)).toBe(true);

    const tool = events.find((e) => e.toolName);
    expect(tool?.toolName).toBe("read");
    expect(tool?.toolDetail).toContain("CHECKPOINT.md");
    expect((tool?.raw as any).message.content[0]).toMatchObject({ type: "tool_use", name: "read" });

    const results = events.filter((e) => e.isResult);
    expect(results).toHaveLength(1);
    // Result is the text of the final message only, like claude
    expect(results[0].resultText).toBe("[mock] Прочитал чекпоинт. NEXT: проверить, что OpenCode читает чекпоинт");
    expect(results[0].raw).toMatchObject({ type: "result", subtype: "success", is_error: false });

    const texts = events.filter((e) => e.assistantText).map((e) => e.assistantText);
    expect(texts).toEqual(["Читаю CHECKPOINT.md.", results[0].resultText]);

    // Intermediate step_finish (reason tool-calls) is not a result
    expect(events.filter((e) => e.raw.subtype === "step_finish")).toHaveLength(1);
  });

  test("resumed session keeps the same id", () => {
    const events = parseFixture("run-resume.jsonl");
    expect(events[0].raw.subtype).toBe("init");
    expect(events.at(-1)?.isResult).toBe(true);
    expect(events.at(-1)?.sessionId).toBe("ses_f01618370ffezwYXLHTkQb5v8S");
  });

  test("429 becomes an error result the router rate-limit regex matches", () => {
    const exit = JSON.stringify({ type: "runner_exit", code: 1, stderr: "" });
    const events = parseFixture("run-429.jsonl", [exit]);
    const results = events.filter((e) => e.isResult);
    expect(results).toHaveLength(1);
    expect(results[0].raw).toMatchObject({ subtype: "error_during_execution", is_error: true });
    expect(results[0].resultText).toBe("API Error: 429 Rate limit reached for requests");
    // same regex as src/router.ts isRateLimitMessage
    const rl = /rate.?limit|usage limit reached|too\s+many\s+requests|\b429\b|quota.*exceeded/i;
    expect(rl.test(results[0].resultText!)).toBe(true);
    // runner_exit after a result is only informational
    expect(events.at(-1)?.raw).toMatchObject({ type: "system", subtype: "exit", code: 1 });
  });

  test("Session not found on stderr maps to claude 'No conversation found'", () => {
    const parse = createOpencodeParser();
    const e = parse(JSON.stringify({ type: "runner_exit", code: 1, stderr: "\x1b[91m\x1b[1mError: \x1b[0mSession not found\n" }))!;
    expect(e.isResult).toBe(true);
    expect((e.raw as any).errors[0]).toContain("No conversation found");
  });

  test("other crash without output becomes an error result", () => {
    const parse = createOpencodeParser();
    const e = parse(JSON.stringify({ type: "runner_exit", code: 2, stderr: "boom" }))!;
    expect(e.resultText).toBe("opencode exited with code 2: boom");
  });

  test("broken lines are skipped, unknown events pass through", () => {
    const parse = createOpencodeParser();
    expect(parse("{not json")).toBeNull();
    expect(parse(JSON.stringify({ type: "reasoning", part: {} }))?.type).toBe("reasoning");
  });
});

describe("opencode launch", () => {
  test("model, session guard, auto-approve", () => {
    const l = opencodeExecutor.launch(
      { ...base, executor: "opencode", model: "deepseek/deepseek-chat", sessionId: "ses_f01618370ffezwYXLHTkQb5v8S" },
      "C:/jobs/1",
    );
    expect(l.args).toEqual([
      "opencode", "run", "--format", "json", "--auto",
      "--model", "deepseek/deepseek-chat",
      "--session", "ses_f01618370ffezwYXLHTkQb5v8S",
    ]);
    expect(l.exitEvent).toBe(true);
  });

  test("claude UUID and claude model aliases are never passed to opencode", () => {
    const l = opencodeExecutor.launch(
      { ...base, executor: "opencode", model: "opus", sessionId: "0f8c2a1e-1b2c-4d5e-8f90-123456789abc" },
      "C:/jobs/1",
    );
    expect(l.args).not.toContain("--session");
    expect(l.args).not.toContain("--model");
  });

  test("system prompt goes to an instructions file, key only by env reference", () => {
    const req: JobRequest = {
      ...base,
      executor: "opencode",
      appendSystemPrompt: "SOUL + topic memory",
      provider: { id: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY" },
      env: { DEEPSEEK_API_KEY: "sk-secret" },
    };
    const l = opencodeExecutor.launch(req, "C:\\jobs\\1");
    expect(l.files).toEqual({ "system-prompt.md": "SOUL + topic memory" });
    expect(l.args).toContain("deepseek/deepseek-chat");
    const cfg = JSON.parse(l.env!.OPENCODE_CONFIG_CONTENT);
    expect(cfg.instructions).toEqual(["C:/jobs/1/system-prompt.md"]);
    expect(cfg.provider.deepseek.options).toEqual({ baseURL: "https://api.deepseek.com/v1", apiKey: "{env:DEEPSEEK_API_KEY}" });
    expect(l.env!.OPENCODE_CONFIG_CONTENT).not.toContain("sk-secret");
  });

  test("no config when nothing to configure", () => {
    expect(buildOpencodeConfig({ ...base, executor: "opencode" }, "C:/jobs/1")).toBeUndefined();
  });
});

describe("claude executor stays unchanged", () => {
  test("args identical to the pre-executor spawn", () => {
    const l = claudeExecutor.launch(
      { ...base, model: "sonnet", sessionId: "0f8c2a1e-1b2c-4d5e-8f90-123456789abc", appendSystemPrompt: "S", flags: ["--mcp-config", "x.json"] },
      "C:/jobs/1",
    );
    expect(l.args).toEqual([
      "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "sonnet",
      "--resume", "0f8c2a1e-1b2c-4d5e-8f90-123456789abc",
      "--append-system-prompt", "S", "--mcp-config", "x.json", "--dangerously-skip-permissions",
    ]);
    expect(l.env).toBeUndefined();
    expect(l.exitEvent).toBeUndefined();
  });

  test("claude parser is the plain stream-json parser", () => {
    const e = claudeExecutor.createParser()(JSON.stringify({ type: "result", result: "ok", session_id: "0f8c2a1e-1b2c-4d5e-8f90-123456789abc" }))!;
    expect(e).toEqual(parseStreamJsonEvent(JSON.stringify({ type: "result", result: "ok", session_id: "0f8c2a1e-1b2c-4d5e-8f90-123456789abc" }))!);
    expect(e.resultText).toBe("ok");
  });

  test("registry defaults to claude", () => {
    expect(getExecutor().id).toBe("claude");
    expect(getExecutor("nope").id).toBe("claude");
    expect(getExecutor("opencode").id).toBe("opencode");
    expect(isExecutorId("opencode")).toBe(true);
    expect(isExecutorId("codex")).toBe(false);
  });
});
