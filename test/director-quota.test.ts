import { describe, expect, test } from "bun:test";
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
      getQuotaKey: (k) => pool[k],
      onStaleTopic: async (topicKey) => {
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
