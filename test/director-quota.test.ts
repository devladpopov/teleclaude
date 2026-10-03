import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Director } from "../src/director";
import type { TopicsConfig } from "../src/config";

// A rate limit on one provider pauses only that provider's topics.
describe("Director quota pools", () => {
  test("429 on provider:deepseek does not pause claude topics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-director-"));
    const topics: TopicsConfig = { topics: {} } as TopicsConfig;
    const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
    const mk = (key: string, name: string) => {
      const project = join(dir, name);
      mkdirSync(project);
      const cp = join(project, "CHECKPOINT.md");
      writeFileSync(cp, `STATUS: IN_PROGRESS\nTASK: ${name}\nNEXT: continue ${name}\n`);
      utimesSync(cp, old, old);
      (topics.topics as any)[key] = { name, project, memory: [], created: "2026-10-03" };
    };
    mk("-100:1", "ds-topic");
    mk("-100:2", "claude-topic");

    const pool: Record<string, string> = { "-100:1": "provider:deepseek", "-100:2": "main" };
    const calls: string[] = [];
    let rateLimitMain = false;
    const director = new Director({
      topics,
      registryPath: join(dir, "registry.json"),
      dashboardPath: join(dir, "dashboard.json"),
      maxTriggersPerTick: 5,
      getActiveAccountName: () => "main",
      getQuotaKey: (k: string) => pool[k],
      onStaleTopic: async (topicKey: string) => {
        calls.push(topicKey);
        return topicKey === "-100:1" || (rateLimitMain && pool[topicKey] === "main")
          ? { ok: false, rateLimited: true, account: pool[topicKey], error: "API Error: 429" }
          : { ok: true, account: pool[topicKey] };
      },
    } as any);

    await director.tick(); // boot tick never fires (cooldowns load)
    await director.tick();
    expect(calls.sort()).toEqual(["-100:1", "-100:2"]);

    // Third topic on claude appears after the deepseek limit: it must still run
    mk("-100:3", "claude-topic-2");
    pool["-100:3"] = "main";
    calls.length = 0;
    await director.tick();
    expect(calls).toContain("-100:3");
    expect(calls).not.toContain("-100:1");

    const reg = JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8"));
    expect(Object.keys(reg.accountQuota || {})).toEqual(["provider:deepseek"]);

    // Now Claude (main) hits its limit: a topic on DeepSeek is not paused by it
    mk("-100:4", "claude-topic-3");
    pool["-100:4"] = "main";
    rateLimitMain = true;
    calls.length = 0;
    await director.tick();
    expect(calls).toContain("-100:4");
    mk("-100:5", "ds-topic-2");
    pool["-100:5"] = "provider:qwen";
    mk("-100:6", "claude-topic-4");
    pool["-100:6"] = "main";
    calls.length = 0;
    await director.tick();
    expect(calls).toContain("-100:5");
    expect(calls).not.toContain("-100:6");
  });
});

// Shared setup for the pause lifecycle tests below.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tc-director-"));
  const topics: TopicsConfig = { groups: {}, topics: {} };
  const pool: Record<string, string> = {};
  const mk = (key: string, name: string, quotaKey: string) => {
    const project = join(dir, name);
    mkdirSync(project);
    const cp = join(project, "CHECKPOINT.md");
    writeFileSync(cp, `STATUS: IN_PROGRESS\nTASK: ${name}\nNEXT: continue ${name}\n`);
    const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
    utimesSync(cp, old, old);
    (topics.topics as any)[key] = { name, project, memory: [], created: "2026-10-03" };
    pool[key] = quotaKey;
  };
  const calls: string[] = [];
  const limited = new Set<string>();
  const make = () => new Director({
    topics,
    registryPath: join(dir, "registry.json"),
    dashboardPath: join(dir, "dashboard.json"),
    maxTriggersPerTick: 5,
    getActiveAccountName: () => "main",
    getQuotaKey: (k: string) => pool[k],
    onStaleTopic: async (topicKey: string) => {
      calls.push(topicKey);
      return limited.has(pool[topicKey])
        ? { ok: false, rateLimited: true, account: pool[topicKey], resumeAt: Date.now() + 60 * 60 * 1000, error: "API Error: 429" }
        : { ok: true, account: pool[topicKey] };
    },
  } as any);
  const registry = () => JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8"));
  return { mk, calls, limited, make, registry };
}

describe("Director provider pause lifecycle", () => {
  afterEach(() => setSystemTime());

  test("pause survives a router restart and only holds that provider", async () => {
    const s = setup();
    s.mk("-100:1", "ds", "provider:deepseek");
    s.limited.add("provider:deepseek");
    const d1 = s.make();
    await d1.tick();
    await d1.tick();
    expect(s.calls).toEqual(["-100:1"]);
    expect(s.registry().accountQuota["provider:deepseek"].reason).toBe("API Error: 429");
    expect(s.registry().deferredTopics.map((e: any) => e.account)).toEqual(["provider:deepseek"]);

    // New process: quota and the deferred entry come back from the registry
    s.mk("-100:2", "claude", "main");
    s.calls.length = 0;
    const d2 = s.make();
    (d2 as any).loadTriggerState(); // what start() does before the first tick
    await d2.tick(); // boot tick
    await d2.tick();
    expect(s.calls).toEqual(["-100:2"]);
  });

  test("after resumeAt the deferred topic runs again and the pause is gone", async () => {
    const s = setup();
    s.mk("-100:1", "ds", "provider:deepseek");
    s.limited.add("provider:deepseek");
    const d = s.make();
    await d.tick();
    await d.tick();
    expect(s.calls).toEqual(["-100:1"]);

    // Still inside the window: nothing fires
    s.calls.length = 0;
    await d.tick();
    expect(s.calls).toEqual([]);

    // The provider is fine again, the window is over
    s.limited.clear();
    setSystemTime(new Date(Date.now() + 61 * 60 * 1000));
    await d.tick();
    expect(s.calls).toEqual(["-100:1"]);
    expect(s.registry().deferredTopics).toEqual([]);
  });

  test("without getQuotaKey every topic shares the Claude auth mode pool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-director-"));
    const topics: TopicsConfig = { groups: {}, topics: {} };
    for (const [key, name] of [["-100:1", "a"], ["-100:2", "b"]]) {
      const project = join(dir, name);
      mkdirSync(project);
      const cp = join(project, "CHECKPOINT.md");
      writeFileSync(cp, `STATUS: IN_PROGRESS\nTASK: ${name}\nNEXT: go\n`);
      const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
      utimesSync(cp, old, old);
      (topics.topics as any)[key] = { name, project, memory: [], created: "2026-10-03" };
    }
    const calls: string[] = [];
    const d = new Director({
      topics,
      registryPath: join(dir, "registry.json"),
      dashboardPath: join(dir, "dashboard.json"),
      maxTriggersPerTick: 1,
      getActiveAccountName: () => "main",
      onStaleTopic: async (k: string) => {
        calls.push(k);
        return { ok: false, rateLimited: true, account: "main" };
      },
    } as any);
    await d.tick();
    await d.tick();
    await d.tick();
    expect(calls).toHaveLength(1);
  });
});
