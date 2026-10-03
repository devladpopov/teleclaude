/**
 * Router under test, without Telegram and without real CLIs.
 *
 *  - Sandbox: src/ and templates/ are copied into a temp dir, node_modules
 *    is linked, config/ is written by the test. The router resolves every
 *    config path from its own location, so nothing in the repo is touched.
 *  - Telegram: an API transformer answers every Bot API call locally and
 *    records it; updates are fed with bot.handleUpdate.
 *  - Runner: a local HTTP server speaks the runner protocol (POST /jobs,
 *    SSE /jobs/:id/events) and replays scripted stream-json events.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "..", "..");

export const CHAT_ID = -1001234567890;
export const THREAD_ID = 42;
export const TOPIC_KEY = `${CHAT_ID}:${THREAD_ID}`;
export const USER_ID = 111;
export const UUID = "0f8c2a1e-1b2c-4d5e-8f90-123456789abc";
export const SES = "ses_f01618370ffezwYXLHTkQb5v8S";

export interface ApiCall {
  method: string;
  payload: Record<string, any>;
}

export interface JobScript {
  /** stream-json events the fake runner sends for this job */
  events: Record<string, unknown>[];
  exitCode?: number;
  state?: string;
}

export interface Harness {
  root: string;
  router: any;
  calls: ApiCall[];
  jobs: any[];
  /** Events for the next jobs, in order. Default: a short claude reply. */
  scripts: JobScript[];
  send(text: string, opts?: { from?: number; threadId?: number }): Promise<void>;
  press(data: string, opts?: { from?: number }): Promise<void>;
  topics(): any;
  readConfig(name: string): any;
  writeConfig(name: string, data: unknown): void;
  replies(): string[];
  close(): void;
}

export interface HarnessOptions {
  runner?: boolean;
  providers?: unknown;
  topic?: Record<string, unknown>;
  /** Files placed under TELECLAUDE_HOME, e.g. { "secrets/deepseek.env": "..." } */
  home?: Record<string, string>;
  /** Write TELECLAUDE_MCP_CONFIG (spawn-mcp-config.json). Default true. */
  mcpConfig?: boolean;
  /** Merged into settings.processes */
  processes?: Record<string, unknown>;
}

export const DEEPSEEK = {
  id: "deepseek", executor: "opencode", name: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat",
  apiKeyEnv: "DEEPSEEK_API_KEY", keyFile: "secrets/deepseek.env",
};

export const QWEN = {
  id: "qwen", executor: "opencode", name: "Qwen",
  baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-plus",
  apiKeyEnv: "DASHSCOPE_API_KEY", keyFile: "secrets/dashscope.env",
};

export function claudeReply(text: string, sessionId = UUID): JobScript {
  return {
    events: [
      { type: "system", subtype: "init", session_id: sessionId },
      { type: "assistant", message: { content: [{ type: "text", text }] }, session_id: sessionId },
      { type: "result", subtype: "success", result: text, session_id: sessionId },
    ],
    exitCode: 0,
  };
}

/** What the runner's opencode parser emits for a normal reply. */
export function opencodeReply(text: string, sessionId = SES): JobScript {
  return {
    events: [
      { type: "system", subtype: "init", executor: "opencode", session_id: sessionId },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sessionId },
      { type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId },
    ],
    exitCode: 0,
  };
}

/** What the runner's opencode parser emits for an HTTP 429 from the provider. */
export function opencode429(sessionId = SES): JobScript {
  return {
    events: [
      {
        type: "result", subtype: "error_during_execution", is_error: true,
        errors: ["API Error: 429 Rate limit reached for requests"],
        result: "API Error: 429 Rate limit reached for requests", session_id: sessionId,
      },
      { type: "system", subtype: "exit", code: 1, session_id: sessionId },
    ],
    exitCode: 1,
    state: "failed",
  };
}

function sse(script: JobScript): string {
  let out = "";
  script.events.forEach((e, i) => {
    out += `event: stream-json\nid: ${i}\ndata: ${JSON.stringify(e)}\n\n`;
  });
  const sessionId = [...script.events].reverse().find((e) => typeof e.session_id === "string")?.session_id;
  out += `event: completed\ndata: ${JSON.stringify({ exitCode: script.exitCode ?? 0, sessionId, state: script.state ?? "completed" })}\n\n`;
  return out;
}

let seq = 0;

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "tc-router-"));
  cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
  cpSync(join(REPO, "templates"), join(root, "templates"), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "junction");
  const config = join(root, "config");
  const home = join(root, "home");
  const project = join(root, "projects", "backend");
  mkdirSync(config);
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, "memory"), { recursive: true });
  if (opts.mcpConfig !== false) {
    writeFileSync(join(home, "spawn-mcp-config.json"), JSON.stringify({ mcpServers: {} }));
  }
  for (const [rel, content] of Object.entries(opts.home || {})) {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), content);
  }

  // Fake runner
  const jobs: any[] = [];
  const scripts: JobScript[] = [];
  const scriptsByJob = new Map<string, JobScript>();
  const runner = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/jobs" && req.method === "POST") {
        const body = await req.json();
        const jobId = `job-${jobs.length + 1}`;
        jobs.push(body);
        scriptsByJob.set(jobId, scripts.shift() ?? claudeReply("ok"));
        return Response.json({ jobId }, { status: 201 });
      }
      const ev = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
      if (ev) {
        return new Response(sse(scriptsByJob.get(ev[1])!), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname === "/jobs" && req.method === "GET") return Response.json({ jobs: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  const settings = {
    telegram: { allowedUsers: [USER_ID] },
    processes: {
      ttlMinutes: 30, maxConcurrent: 5, claudePath: "claude",
      defaultFlags: ["--dangerously-skip-permissions"], defaultModel: "opus",
      ...(opts.processes || {}),
    },
    compaction: { reserveTokens: 100000, keepRecentTokens: 50000, enabled: false },
    memory: { revisionIntervalMinutes: 60, maxFileLines: 200, deduplication: true, enabled: false },
    runner: { enabled: opts.runner !== false, port: runner.port },
    projectsRoot: join(root, "projects"),
    templatesDir: "./templates",
    whisper: { enabled: false, url: "http://127.0.0.1:9/asr", language: "ru", autoStart: false },
  };
  writeFileSync(join(config, "settings.json"), JSON.stringify(settings, null, 2));
  writeFileSync(join(config, "topics.json"), JSON.stringify({
    groups: { [String(CHAT_ID)]: { name: "Workspace", enabled: true, mode: "active" } },
    topics: {
      [TOPIC_KEY]: {
        name: "Backend", project, memory: [], created: "2026-10-03T00:00:00.000Z", ...(opts.topic || {}),
      },
    },
  }, null, 2));
  if (opts.providers) writeFileSync(join(config, "providers.json"), JSON.stringify(opts.providers, null, 2));

  // Module-level constants read these at import time
  process.env.TELECLAUDE_HOME = home;
  process.env.TELECLAUDE_PROVIDERS = join(config, "providers.json");
  process.env.TELECLAUDE_MEMORY_DIR = join(home, "memory");
  process.env.TELECLAUDE_MCP_CONFIG = join(home, "spawn-mcp-config.json");

  const { Router } = await import(join(root, "src", "router.ts"));
  const router = new Router("123456:TEST-TOKEN", settings);

  const calls: ApiCall[] = [];
  let messageId = 1000;
  router.bot.api.config.use(async (_prev: unknown, method: string, payload: any) => {
    calls.push({ method, payload });
    const result = method === "sendMessage" || method === "editMessageText"
      ? { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: "supergroup" }, text: payload.text }
      : true;
    return { ok: true, result } as any;
  });
  router.bot.botInfo = {
    id: 123456, is_bot: true, first_name: "TeleClaude", username: "teleclaude_test_bot",
    can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false,
  };
  // Same handlers start() registers, without polling, timers and the HTTP server
  router.bot.on("message", async (ctx: any) => {
    try {
      await router.handleMessage(ctx);
    } catch (err) {
      await ctx.reply(`Ошибка: ${(err as Error).message}`, { message_thread_id: ctx.message?.message_thread_id });
    }
  });
  router.registerCallbackHandlers();

  const chat = { id: CHAT_ID, type: "supergroup", title: "Workspace", is_forum: true };
  const harness: Harness = {
    root, router, calls, jobs, scripts,
    async send(text, o = {}) {
      await router.bot.handleUpdate({
        update_id: ++seq,
        message: {
          message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat,
          from: { id: o.from ?? USER_ID, is_bot: false, first_name: "User" },
          message_thread_id: o.threadId ?? THREAD_ID, is_topic_message: true, text,
        },
      });
    },
    async press(data, o = {}) {
      await router.bot.handleUpdate({
        update_id: ++seq,
        callback_query: {
          id: String(++seq), chat_instance: "ci", data,
          from: { id: o.from ?? USER_ID, is_bot: false, first_name: "User" },
          message: {
            message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat,
            message_thread_id: THREAD_ID, is_topic_message: true, text: "menu",
            from: { id: 123456, is_bot: true, first_name: "TeleClaude" },
          },
        },
      });
    },
    topics: () => JSON.parse(readFileSync(join(config, "topics.json"), "utf-8")),
    readConfig: (name) => JSON.parse(readFileSync(join(config, name), "utf-8")),
    writeConfig: (name, data) => writeFileSync(join(config, name), JSON.stringify(data, null, 2)),
    replies: () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text)),
    close() {
      runner.stop(true);
      try { rmSync(root, { recursive: true, force: true }); } catch {}
    },
  };
  return harness;
}
