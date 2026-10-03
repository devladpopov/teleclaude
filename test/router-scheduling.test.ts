/**
 * /loop, /remind and the Director trigger path through the real Router,
 * with Telegram and the runner mocked (see helpers/router-harness.ts).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  CHAT_ID, DEEPSEEK, SES, THREAD_ID, TOPIC_KEY, claudeReply, createHarness, opencode429, opencodeReply,
  type Harness,
} from "./helpers/router-harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    providers: { default: "claude", providers: [{ id: "claude", executor: "claude" }, DEEPSEEK] },
    home: { "secrets/deepseek.env": "DEEPSEEK_API_KEY=sk-deepseek-test\n" },
  });
});
afterAll(() => h.close());

const lastReply = () => h.replies().at(-1)!;

describe("/loop", () => {
  let id = "";

  test("usage without arguments", async () => {
    await h.send("/loop");
    expect(lastReply()).toStartWith("Использование: /loop <interval> <text>");
  });

  test("too short interval is refused", async () => {
    await h.send("/loop 30s проверь");
    expect(lastReply()).toBe("Не получилось: Интервал слишком маленький — минимум 1m.");
    expect(h.router.recurringStore.list()).toEqual([]);
  });

  test("registered in config/recurring.json for this topic", async () => {
    await h.send("/loop 6h проверь все боты");
    const tasks = h.readConfig("recurring.json").tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ topicKey: TOPIC_KEY, interval: "6h", intervalMs: 21_600_000, text: "проверь все боты", createdBy: 111 });
    id = tasks[0].id;
    expect(lastReply()).toContain(`/loop зарегистрирован: ${id}`);
  });

  test("/loops lists it, /loops in another topic does not", async () => {
    await h.send("/loops");
    expect(lastReply()).toContain(`• ${id} — каждые 6h`);
    await h.send("/loops", { threadId: 99 });
    expect(lastReply()).toBe("В этом топике /loop задач нет. /loops all — все.");
    await h.send("/loops all", { threadId: 99 });
    expect(lastReply()).toContain(`[${TOPIC_KEY}]`);
  });

  test("a due task spawns a job in its topic with the /loop marker", async () => {
    const store = h.router.recurringStore;
    store.list()[0].nextRunAt = Date.now() - 1;
    h.scripts.push(claudeReply("Все боты живы"));
    const before = h.jobs.length;
    await h.router.recurringScheduler.tick();
    expect(h.jobs.length).toBe(before + 1);
    const job = h.jobs.at(-1);
    expect(job.topicKey).toBe(TOPIC_KEY);
    expect(job.message).toContain("[/loop 6h] проверь все боты");
    expect(h.replies()).toContain("[opus-5.5] Все боты живы");
    expect(store.list()[0].runCount).toBe(1);
    expect(store.list()[0].nextRunAt).toBeGreaterThan(Date.now() + 21_000_000);
  });

  test("the loop runs on the topic's provider", async () => {
    await h.send("/provider deepseek");
    h.router.recurringStore.list()[0].nextRunAt = Date.now() - 1;
    h.scripts.push(opencodeReply("отчёт готов"));
    await h.router.recurringScheduler.tick();
    expect(h.jobs.at(-1).executor).toBe("opencode");
    expect(h.replies()).toContain("[deepseek:deepseek-chat] отчёт готов");
    await h.send("/provider claude");
  });

  test("/unloop removes it", async () => {
    await h.send("/unloop nope");
    expect(lastReply()).toBe("Не нашёл /loop задачу с id nope.");
    await h.send(`/unloop ${id}`);
    expect(lastReply()).toBe(`Задача ${id} снята.`);
    expect(h.readConfig("recurring.json").tasks).toEqual([]);
  });
});

describe("/remind", () => {
  const reminders = () => h.readConfig("reminders.json").reminders as any[];
  const clear = () => {
    for (const r of h.router.reminderStore.list()) h.router.reminderStore.remove(r.id);
  };

  test("relative time: stored for this topic", async () => {
    clear();
    const before = Date.now();
    await h.send("/remind 1h позвонить в банк");
    const [r] = reminders();
    expect(r).toMatchObject({ chatId: String(CHAT_ID), threadId: THREAD_ID, text: "позвонить в банк", createdBy: 111 });
    expect(r.runClaude).toBeUndefined();
    expect(r.fireAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(lastReply()).toMatch(/^OK, напомню через (1ч|59м 59с)/);
  });

  test("bad time and empty text are explained", async () => {
    await h.send("/remind когда-нибудь");
    expect(lastReply()).toStartWith('Не понял время: "когда-нибудь"');
    await h.send("/remind 1h");
    expect(lastReply()).toStartWith("Текст напоминания не может быть пустым");
    await h.send("/remind 400d слишком далеко");
    expect(lastReply()).toStartWith("Слишком далеко в будущем");
  });

  test("plain text 'напомни ...' becomes /remind", async () => {
    clear();
    await h.send("напомни через 2 часа выключить сервер");
    const [r] = reminders();
    expect(r.text).toBe("выключить сервер");
    expect(r.runClaude).toBeUndefined();
    expect(h.jobs.at(-1)?.message ?? "").not.toContain("выключить сервер");
  });

  test("a message starting with a time becomes a scheduled agent run, not an answer now", async () => {
    clear();
    const before = h.jobs.length;
    await h.send("через 30 минут проверь сайт");
    expect(h.jobs.length).toBe(before);
    const [r] = reminders();
    expect(r.runClaude).toBe(true);
    expect(r.text).toBe("проверь сайт");
    expect(lastReply()).toMatch(/^OK, через (30м|29м 59с) запущу Claude с этим текстом\./);
  });

  test("due reminders fire: plain text message, or an agent run in the topic", async () => {
    h.writeConfig("reminders.json", {
      reminders: [
        { id: "a1", chatId: String(CHAT_ID), threadId: THREAD_ID, text: "позвонить", fireAt: 1, createdAt: 1, createdBy: 111 },
        { id: "a2", chatId: String(CHAT_ID), threadId: THREAD_ID, text: "проверь сайт", fireAt: 2, createdAt: 1, createdBy: 111, runClaude: true },
      ],
    });
    h.scripts.push(claudeReply("Сайт отвечает 200"));
    const before = h.jobs.length;
    h.calls.length = 0;
    await h.router.reminderScheduler.tick();
    const plain = h.calls.find((c) => c.method === "sendMessage" && c.payload.text === "Напоминание: позвонить")!;
    expect(plain.payload).toMatchObject({ chat_id: CHAT_ID, message_thread_id: THREAD_ID });
    expect(h.jobs.length).toBe(before + 1);
    expect(h.jobs.at(-1).message).toContain("проверь сайт");
    expect(h.replies()).toContain("[opus-5.5] Сайт отвечает 200");
    expect(reminders()).toEqual([]);
  });

  test("/reminders and /unremind", async () => {
    clear();
    await h.send("/remind 2h первое");
    const id = reminders()[0].id;
    await h.send("/reminders");
    const list = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(list.payload.text).toMatch(new RegExp(`• ${id} — через (2ч|1ч 59м)\\n  первое`));
    expect(list.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe(`rem:rm:${id}`);
    await h.send(`/unremind ${id}`);
    expect(lastReply()).toBe(`Напоминание ${id} отменено.`);
    expect(reminders()).toEqual([]);
  });

  test("to:CHAT:THREAD sends the reminder to another topic", async () => {
    clear();
    await h.send("/remind to:-1009999:5 1h чужой топик");
    expect(reminders()[0]).toMatchObject({ chatId: "-1009999", threadId: 5, text: "чужой топик" });
    expect(lastReply()).toContain("Куда: chat -1009999, thread 5");
  });
});

describe("Director trigger through the router", () => {
  const state = () => ({ topicKey: TOPIC_KEY, name: "Backend" });
  const options = { modelOverride: "sonnet", userMessage: "[Director auto] Продолжай: NEXT", noticeText: "[Director auto] продолжаю" };

  test("quota key: Claude auth mode for claude topics, provider:<id> for others", async () => {
    await h.send("/provider claude");
    expect(h.router.quotaKeyFor(TOPIC_KEY)).toBe(h.router.accountManager.getActiveName());
    await h.send("/provider deepseek");
    expect(h.router.quotaKeyFor(TOPIC_KEY)).toBe("provider:deepseek");
  });

  test("successful auto trigger: notice, job, reply, ok", async () => {
    h.scripts.push(opencodeReply("продолжаю работу", SES));
    h.calls.length = 0;
    const result = await h.router.director.config.onStaleTopic(TOPIC_KEY, state(), options);
    expect(result).toEqual({ ok: true, account: "provider:deepseek" });
    expect(h.replies()[0]).toBe("[Director auto] продолжаю");
    expect(h.jobs.at(-1).message).toContain("[Director auto] Продолжай: NEXT");
    expect(h.replies()).toContain("[deepseek:deepseek-chat] продолжаю работу");
  });

  test("429 from the provider pauses that provider in Director", async () => {
    // opencode reports a 429 as a result with the error text, the runner
    // client resolves with that text: triggerTopicAuto gives
    // { ok: true, rateLimited: true }, and the rate limit must win.
    h.scripts.push(opencode429());
    const result = await h.router.director.config.onStaleTopic(TOPIC_KEY, state(), options);
    expect(result).toMatchObject({ ok: false, rateLimited: true, account: "provider:deepseek" });

    h.scripts.push(opencode429());
    const director = h.router.director;
    await director.fireTrigger({ ...state(), category: "work" }, "provider:deepseek", Date.now());
    expect(director.accountQuota.get("provider:deepseek")?.resumeAt).toBeGreaterThan(Date.now());
    expect(director.accountQuota.has(h.router.accountManager.getActiveName())).toBe(false);
  });
});

describe("dashboard sync", () => {
  test("without DASHBOARD_SYNC_REMOTE nothing is uploaded and nothing claims it was", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    try {
      await h.router.director.config.onDashboardUpdate({});
    } finally {
      spy.mockRestore();
    }
    expect(logs.filter((l) => l.includes("Dashboard uploaded"))).toEqual([]);
  });
});
