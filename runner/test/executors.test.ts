import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createOpencodeParser, buildOpencodeConfig, convertMcpServers, opencodeExecutor } from "../src/executors/opencode.ts";
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
    // no result text: the router must take its "session gone" path
    expect((e.raw as any).result).toBeUndefined();
    expect(e.resultText).toBeUndefined();
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

  test("claude MCP config becomes opencode mcp", () => {
    const servers = convertMcpServers({
      "router-mcp": { command: "bun", args: ["run", "mcp-router/server.ts"], env: { A: "1" } },
      playwright: { type: "http", url: "http://127.0.0.1:8931/mcp" },
      off: { command: "x", disabled: true },
      broken: { foo: 1 },
    });
    expect(servers).toEqual({
      "router-mcp": { type: "local", command: ["bun", "run", "mcp-router/server.ts"], enabled: true, environment: { A: "1" } },
      playwright: { type: "remote", url: "http://127.0.0.1:8931/mcp", enabled: true },
    });
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

describe("claude command line", () => {
  test("defaults: model opus, no resume, no prompt, permissions flag last", () => {
    const l = claudeExecutor.launch({ ...base }, "C:/jobs/1");
    expect(l.args).toEqual([
      "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "opus",
      "--dangerously-skip-permissions",
    ]);
    expect(l.files).toBeUndefined();
  });

  test("claudePath and the model are passed through as is", () => {
    const l = claudeExecutor.launch({ ...base, claudePath: "C:\\Tools\\claude.exe", model: "claude-opus-5-5" }, "C:/jobs/1");
    expect(l.args[0]).toBe("C:\\Tools\\claude.exe");
    expect(l.args.slice(5, 7)).toEqual(["--model", "claude-opus-5-5"]);
  });

  test("router flags keep their order, --effort included", () => {
    const l = claudeExecutor.launch(
      { ...base, flags: ["--dangerously-skip-permissions", "--mcp-config", "m.json", "--effort", "max"] },
      "C:/jobs/1",
    );
    expect(l.args.slice(7)).toEqual([
      "--dangerously-skip-permissions", "--mcp-config", "m.json", "--effort", "max", "--dangerously-skip-permissions",
    ]);
  });
});

describe("claude stream-json parser", () => {
  test("text blocks of one event are joined, tool detail is cut to 60 chars", () => {
    const e = parseStreamJsonEvent(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "tool_use", name: "Bash", input: { command: "x".repeat(100) } },
        ],
      },
    }))!;
    expect(e.assistantText).toBe("ab");
    expect(e.toolName).toBe("Bash");
    expect(e.toolDetail).toBe("x".repeat(57) + "...");
  });

  test("tool detail falls back to the first string field, undefined without one", () => {
    const first = parseStreamJsonEvent(JSON.stringify({
      type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__x", input: { n: 1, topicKey: "-100:7" } }] },
    }))!;
    expect(first.toolDetail).toBe("-100:7");
    const none = parseStreamJsonEvent(JSON.stringify({
      type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [] } }] },
    }))!;
    expect(none.toolDetail).toBeUndefined();
  });

  test("invalid session ids are not reported", () => {
    const e = parseStreamJsonEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "../../etc" }))!;
    expect(e.sessionId).toBeUndefined();
  });

  test("non-objects and broken lines are null, events without type are 'unknown'", () => {
    expect(parseStreamJsonEvent("42")).toBeNull();
    expect(parseStreamJsonEvent("null")).toBeNull();
    expect(parseStreamJsonEvent("{")).toBeNull();
    expect(parseStreamJsonEvent("{}")!.type).toBe("unknown");
  });

  test("error result without text keeps errors and no resultText", () => {
    const e = parseStreamJsonEvent(JSON.stringify({ type: "result", subtype: "error_during_execution", errors: ["boom"] }))!;
    expect(e.isResult).toBe(true);
    expect(e.resultText).toBeUndefined();
  });
});

describe("opencode command line", () => {
  test("provider wins over request.model, executorPath replaces the binary", () => {
    const l = opencodeExecutor.launch(
      {
        ...base, executor: "opencode", executorPath: "C:/bin/opencode.exe", model: "other/model",
        provider: { id: "qwen", baseURL: "https://x/v1", model: "qwen-plus" },
      },
      "C:/jobs/1",
    );
    expect(l.args[0]).toBe("C:/bin/opencode.exe");
    expect(l.args.slice(l.args.indexOf("--model"), l.args.indexOf("--model") + 2)).toEqual(["--model", "qwen/qwen-plus"]);
  });

  test("model with a slash is used without a provider", () => {
    const l = opencodeExecutor.launch({ ...base, executor: "opencode", model: "openrouter/some-model" }, "C:/jobs/1");
    expect(l.args).toContain("openrouter/some-model");
  });

  test("provider without apiKeyEnv gets no apiKey option, custom npm package kept", () => {
    const cfg = buildOpencodeConfig(
      { ...base, executor: "opencode", provider: { id: "local", baseURL: "http://127.0.0.1:8090/v1", model: "m", npm: "@ai-sdk/openai" } },
      "C:/jobs/1",
    )!;
    expect(cfg.provider).toEqual({
      local: { npm: "@ai-sdk/openai", name: "local", options: { baseURL: "http://127.0.0.1:8090/v1" }, models: { m: { name: "m", tool_call: true } } },
    });
  });

  test("broken or missing MCP config is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-mcp-"));
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    expect(buildOpencodeConfig({ ...base, executor: "opencode", mcpConfigPath: broken }, "C:/jobs/1")).toBeUndefined();
    expect(buildOpencodeConfig({ ...base, executor: "opencode", mcpConfigPath: join(dir, "none.json") }, "C:/jobs/1")).toBeUndefined();
  });

  test("remote MCP keeps headers, args become strings", () => {
    expect(convertMcpServers({
      remote: { type: "sse", url: "http://h/sse", headers: { Authorization: "Bearer x" } },
      local: { command: "node", args: ["s.js", 8931] },
    })).toEqual({
      remote: { type: "remote", url: "http://h/sse", enabled: true, headers: { Authorization: "Bearer x" } },
      local: { type: "local", command: ["node", "s.js", "8931"], enabled: true },
    });
    expect(convertMcpServers(null)).toEqual({});
  });
});

describe("opencode event stream", () => {
  const SES = "ses_f01618370ffezwYXLHTkQb5v8S";
  const line = (o: unknown) => JSON.stringify(o);

  test("result text is the text of the final message only, usage and cost kept", () => {
    const parse = createOpencodeParser();
    parse(line({ type: "step_start", sessionID: SES, part: {} }));
    parse(line({ type: "text", sessionID: SES, part: { messageID: "m1", text: "plan" } }));
    parse(line({ type: "step_finish", sessionID: SES, part: { messageID: "m1", reason: "tool-calls" } }));
    const second = parse(line({ type: "step_start", sessionID: SES, part: {} }))!;
    expect(second.raw).toMatchObject({ type: "system", subtype: "step_start" });
    parse(line({ type: "text", sessionID: SES, part: { messageID: "m2", text: "Готово, " } }));
    parse(line({ type: "text", sessionID: SES, part: { messageID: "m2", text: "всё." } }));
    const r = parse(line({
      type: "step_finish", sessionID: SES,
      part: { messageID: "m2", reason: "stop", cost: 0.002, tokens: { input: 100, output: 20 } },
    }))!;
    expect(r.isResult).toBe(true);
    expect(r.resultText).toBe("Готово, всё.");
    expect(r.raw).toMatchObject({
      type: "result", subtype: "success", result: "Готово, всё.", total_cost_usd: 0.002,
      usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: "stop", session_id: SES,
    });
  });

  test("tool call without input: name kept, no detail", () => {
    const parse = createOpencodeParser();
    const e = parse(line({ type: "tool_use", part: { tool: "todowrite", callID: "c1" } }))!;
    expect(e.toolName).toBe("todowrite");
    expect(e.toolDetail).toBeUndefined();
    expect((e.raw as any).message.content[0]).toEqual({ type: "tool_use", id: "c1", name: "todowrite", input: {} });
  });

  test("error without status code: 'Name: message'; status code: 'API Error: <code>'", () => {
    const a = createOpencodeParser()(line({ type: "error", error: { name: "ProviderInitError", data: { message: "no key" } } }))!;
    expect(a.resultText).toBe("ProviderInitError: no key");
    const b = createOpencodeParser()(line({ type: "error", error: { name: "APIError", data: { message: "Payment required", statusCode: 402 } } }))!;
    expect(b.resultText).toBe("API Error: 402 Payment required");
    expect(b.raw).toMatchObject({ is_error: true, errors: ["API Error: 402 Payment required"] });
  });

  test("a garbage sessionID is never reported", () => {
    const e = createOpencodeParser()(line({ type: "step_start", sessionID: "ses_; rm -rf /", part: {} }))!;
    expect(e.sessionId).toBeUndefined();
    expect(e.raw.session_id).toBeUndefined();
  });

  test("long stderr is cut to the last 500 chars", () => {
    const e = createOpencodeParser()(line({ type: "runner_exit", code: 1, stderr: "x".repeat(600) + "END" }))!;
    expect(e.resultText).toBe(`opencode exited with code 1: ${("x".repeat(600) + "END").slice(-500)}`);
  });
});
