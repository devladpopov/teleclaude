/**
 * /provider and sessions per (topic, executor) through the real Router,
 * with Telegram and the runner mocked (see helpers/router-harness.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { utimesSync } from "fs";
import { join } from "path";
import {
  DEEPSEEK, QWEN, SES, TOPIC_KEY, UUID, claudeReply, createHarness, opencodeReply, type Harness,
} from "./helpers/router-harness";

describe("/provider command", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({
      providers: { default: "claude", providers: [{ id: "claude", executor: "claude" }, DEEPSEEK, QWEN] },
      home: { "secrets/deepseek.env": "DEEPSEEK_API_KEY=sk-deepseek-test\n" },
    });
  });
  afterAll(() => h.close());

  test("no argument: current provider and one button per provider", async () => {
    h.calls.length = 0;
    await h.send("/provider");
    const reply = h.calls.find((c) => c.method === "sendMessage")!;
    expect(reply.payload.text).toContain("Провайдер: claude");
    expect(reply.payload.text).toContain("Источник: default (claude)");
    expect(reply.payload.message_thread_id).toBe(42);
    const buttons = reply.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(buttons).toEqual(["provider:claude", "provider:deepseek", "provider:qwen"]);
  });

  test("switch by id is saved to topics.json", async () => {
    h.calls.length = 0;
    await h.send("/provider deepseek");
    expect(h.replies()[0]).toStartWith("Провайдер топика: claude → deepseek.");
    expect(h.replies()[0]).toContain("при 429 топик встаёт на паузу");
    expect(h.replies()[0]).not.toContain("не найден");
    expect(h.topics().topics[TOPIC_KEY].provider).toBe("deepseek");
  });

  test("a provider without a key is allowed with a warning", async () => {
    h.calls.length = 0;
    await h.send("/provider qwen");
    expect(h.replies()[0]).toContain("ключ DASHSCOPE_API_KEY не найден");
    expect(h.topics().topics[TOPIC_KEY].provider).toBe("qwen");
  });

  test("unknown id: list of available, nothing changes", async () => {
    h.calls.length = 0;
    await h.send("/provider gpt5");
    expect(h.replies()[0]).toBe('Неизвестный провайдер "gpt5". Доступно: claude, deepseek, qwen, default.');
    expect(h.topics().topics[TOPIC_KEY].provider).toBe("qwen");
  });

  test("button press switches and edits the menu", async () => {
    h.calls.length = 0;
    await h.press("provider:claude");
    const answer = h.calls.find((c) => c.method === "answerCallbackQuery")!;
    expect(answer.payload.text).toBe("Провайдер топика: qwen → claude. Применится со следующего сообщения.");
    expect(h.calls.some((c) => c.method === "editMessageText")).toBe(true);
    expect(h.topics().topics[TOPIC_KEY].provider).toBe("claude");
  });

  test("button press from a stranger is refused", async () => {
    h.calls.length = 0;
    await h.press("provider:deepseek", { from: 999 });
    expect(h.calls.find((c) => c.method === "answerCallbackQuery")!.payload.text).toBe("Нет доступа");
    expect(h.topics().topics[TOPIC_KEY].provider).toBe("claude");
  });

  test("message from a stranger is ignored", async () => {
    h.calls.length = 0;
    await h.send("/provider deepseek", { from: 999 });
    expect(h.calls).toEqual([]);
    expect(h.topics().topics[TOPIC_KEY].provider).toBe("claude");
  });

  test("default removes the override", async () => {
    await h.send("/provider default");
    expect(h.topics().topics[TOPIC_KEY].provider).toBeUndefined();
  });

  test("providers.json changes apply without a restart", async () => {
    const path = join(h.root, "config", "providers.json");
    h.writeConfig("providers.json", {
      default: "deepseek",
      providers: [DEEPSEEK, { ...QWEN, id: "cloudru", baseURL: "https://foundation-models.api.cloud.ru/v1" }],
    });
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    h.calls.length = 0;
    await h.send("/provider");
    expect(h.replies()[0]).toContain("Провайдер: deepseek");
    expect(h.replies()[0]).toContain("Источник: default (deepseek)");
    await h.send("/provider cloudru");
    expect(h.topics().topics[TOPIC_KEY].provider).toBe("cloudru");
  });

  test("uninitialized topic", async () => {
    h.calls.length = 0;
    await h.send("/provider deepseek", { threadId: 77 });
    expect(h.replies()[0]).toBe("Топик не инициализирован: сначала напишите любое сообщение.");
  });
});

describe("/provider without the runner", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({
      runner: false,
      providers: { default: "deepseek", providers: [DEEPSEEK] },
    });
  });
  afterAll(() => h.close());

  test("other executors are refused, the topic stays on claude", async () => {
    await h.send("/provider deepseek");
    expect(h.replies()[0]).toBe("Провайдеры кроме claude работают только через runner (settings.runner.enabled = true).");
    expect(h.topics().topics[TOPIC_KEY].provider).toBeUndefined();
    h.calls.length = 0;
    await h.send("/provider");
    // even with "default": "deepseek" a direct-spawn router runs claude
    expect(h.replies()[0]).toContain("Провайдер: claude");
  });
});

describe("sessions per (topic, executor)", () => {
  let h: Harness;
  beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tg-secret-token";
    process.env.ROUTER_WEBHOOK_SECRET = "webhook-secret";
    h = await createHarness({
      providers: { default: "claude", providers: [{ id: "claude", executor: "claude" }, DEEPSEEK] },
      home: { "secrets/deepseek.env": "DEEPSEEK_API_KEY=sk-deepseek-test\n" },
      topic: { sessionId: UUID },
    });
  });
  afterAll(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.ROUTER_WEBHOOK_SECRET;
    h.close();
  });

  test("claude topic resumes its UUID with claude flags", async () => {
    h.scripts.push(claudeReply("Привет от Claude"));
    h.calls.length = 0;
    await h.send("Привет");
    const job = h.jobs.at(-1);
    expect(job.executor).toBeUndefined();
    expect(job.sessionId).toBe(UUID);
    expect(job.model).toBe("claude-opus-5-5");
    expect(job.flags).toContain("--mcp-config");
    expect(job.env.TELEGRAM_BOT_TOKEN).toBe("tg-secret-token");
    expect(job.env.TOPIC_CHAT_ID).toBe("-1001234567890");
    expect(job.env.TOPIC_THREAD_ID).toBe("42");
    expect(h.replies()).toContain("[opus-5.5] Привет от Claude");
  });

  test("on DeepSeek: opencode job, new session, key from keyFile, no router secrets", async () => {
    await h.send("/provider deepseek");
    h.scripts.push(opencodeReply("Привет от DeepSeek"));
    h.calls.length = 0;
    await h.send("Как дела?");
    const job = h.jobs.at(-1);
    expect(job.executor).toBe("opencode");
    expect(job.claudePath).toBe("");
    expect(job.sessionId).toBeUndefined(); // the claude UUID never reaches opencode
    expect(job.provider).toEqual({
      id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1",
      model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY",
    });
    expect(job.env.DEEPSEEK_API_KEY).toBe("sk-deepseek-test");
    expect(job.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(job.env.ROUTER_WEBHOOK_SECRET).toBeUndefined();
    expect(job.env.TOPIC_THREAD_ID).toBe("42");
    expect(job.mcpConfigPath).toEndWith("spawn-mcp-config.json");
    expect(job.flags).toBeUndefined();
    expect(job.appendSystemPrompt).toContain("deepseek-chat");
    expect(h.replies()).toContain("[deepseek:deepseek-chat] Привет от DeepSeek");

    const t = h.topics().topics[TOPIC_KEY];
    expect(t.sessionId).toBe(UUID);
    expect(t.sessions).toEqual({ opencode: SES });
  });

  test("second DeepSeek message resumes the opencode session", async () => {
    h.scripts.push(opencodeReply("ещё"));
    await h.send("Продолжай");
    expect(h.jobs.at(-1).sessionId).toBe(SES);
  });

  test("back to Claude: the UUID again; back to DeepSeek: ses_ again", async () => {
    await h.send("/provider claude");
    h.scripts.push(claudeReply("снова Claude"));
    await h.send("Ты тут?");
    expect(h.jobs.at(-1).executor).toBeUndefined();
    expect(h.jobs.at(-1).sessionId).toBe(UUID);

    await h.send("/provider deepseek");
    h.scripts.push(opencodeReply("снова DeepSeek"));
    await h.send("А ты?");
    expect(h.jobs.at(-1).executor).toBe("opencode");
    expect(h.jobs.at(-1).sessionId).toBe(SES);
    expect(h.topics().topics[TOPIC_KEY]).toMatchObject({ sessionId: UUID, sessions: { opencode: SES } });
  });

  test("missing key: the job is not submitted, the user sees why", async () => {
    h.writeConfig("providers.json", {
      default: "claude",
      providers: [{ id: "claude", executor: "claude" }, { ...DEEPSEEK, keyFile: "secrets/none.env", apiKeyEnv: "TC_NO_SUCH_KEY" }],
    });
    utimesSync(join(h.root, "config", "providers.json"), new Date(), new Date(Date.now() + 10_000));
    const before = h.jobs.length;
    h.calls.length = 0;
    await h.send("Ответь");
    expect(h.jobs.length).toBe(before);
    expect(h.replies().some((r) => r.includes("Нет ключа провайдера") && r.includes("TC_NO_SUCH_KEY"))).toBe(true);
  });
});
