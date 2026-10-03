import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RecurringTaskScheduler, RecurringTaskStore, parseInterval, type RecurringTask } from "../src/recurring-tasks";

const dir = mkdtempSync(join(tmpdir(), "tc-loop-"));
let n = 0;
const freshPath = () => join(dir, `recurring-${n++}.json`);

describe("parseInterval", () => {
  test("units s, m, h, d, case and spaces", () => {
    expect(parseInterval("90s")).toBe(90_000);
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("6H")).toBe(6 * 3_600_000);
    expect(parseInterval(" 1 d ")).toBe(86_400_000);
  });

  test("garbage, zero and compound forms are rejected", () => {
    for (const s of ["", "0m", "-5m", "1h30m", "5", "m", "1w", "1.5h"]) {
      expect(parseInterval(s)).toBeUndefined();
    }
  });
});

describe("RecurringTaskStore", () => {
  test("add validates interval bounds and text", () => {
    const store = new RecurringTaskStore(freshPath());
    expect(store.add({ topicKey: "-100:1", interval: "30s", text: "x" })).toEqual({ error: "Интервал слишком маленький — минимум 1m." });
    expect(store.add({ topicKey: "-100:1", interval: "31d", text: "x" })).toEqual({ error: "Интервал слишком большой — максимум 30d." });
    expect("error" in store.add({ topicKey: "-100:1", interval: "abc", text: "x" })).toBe(true);
    expect("error" in store.add({ topicKey: "-100:1", interval: "1h", text: "   " })).toBe(true);
    expect(store.list()).toEqual([]);
  });

  test("first run one interval after creation, list per topic, persisted", () => {
    const path = freshPath();
    const store = new RecurringTaskStore(path);
    const before = Date.now();
    const t = store.add({ topicKey: "-100:1", interval: "6h", text: "  проверь боты  ", createdBy: 42 }) as RecurringTask;
    store.add({ topicKey: "-100:2", interval: "1d", text: "отчёт" });
    expect(t.text).toBe("проверь боты");
    expect(t.intervalMs).toBe(6 * 3_600_000);
    expect(t.nextRunAt).toBeGreaterThanOrEqual(before + t.intervalMs);
    expect(t.runCount).toBe(0);
    expect(store.list("-100:1").map((x) => x.id)).toEqual([t.id]);
    expect(store.list()).toHaveLength(2);

    const reloaded = new RecurringTaskStore(path);
    expect(reloaded.list("-100:1")[0]).toEqual(t);
    expect(JSON.parse(readFileSync(path, "utf-8")).tasks).toHaveLength(2);
  });

  test("popDue fires due tasks once and moves nextRunAt by the interval", () => {
    const store = new RecurringTaskStore(freshPath());
    const t = store.add({ topicKey: "-100:1", interval: "1h", text: "x", firstFireAt: 1_000 }) as RecurringTask;
    expect(store.popDue(999)).toEqual([]);
    const due = store.popDue(5_000);
    expect(due.map((x) => x.id)).toEqual([t.id]);
    const after = store.list()[0];
    expect(after.runCount).toBe(1);
    expect(after.lastRunAt).toBe(5_000);
    expect(after.nextRunAt).toBe(5_000 + 3_600_000);
    // missed several intervals while the router was down: one run, not a burst
    expect(store.popDue(10 * 3_600_000)).toHaveLength(1);
    expect(store.popDue(10 * 3_600_000)).toHaveLength(0);
  });

  test("maxRuns removes the task after the last run", () => {
    const store = new RecurringTaskStore(freshPath());
    store.add({ topicKey: "-100:1", interval: "1m", text: "x", maxRuns: 2, firstFireAt: 0 });
    expect(store.popDue(1)).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
    expect(store.popDue(10 * 60_000)).toHaveLength(1);
    expect(store.list()).toHaveLength(0);
  });

  test("remove", () => {
    const store = new RecurringTaskStore(freshPath());
    const t = store.add({ topicKey: "-100:1", interval: "1h", text: "x" }) as RecurringTask;
    expect(store.remove("nope")).toBe(false);
    expect(store.remove(t.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });
});

describe("RecurringTaskScheduler", () => {
  test("first tick runs overdue tasks at start; a failed run is not retried every tick", async () => {
    const store = new RecurringTaskStore(freshPath());
    store.add({ topicKey: "-100:1", interval: "1h", text: "ok", firstFireAt: 0 });
    store.add({ topicKey: "-100:2", interval: "1h", text: "fail", firstFireAt: 0 });
    store.add({ topicKey: "-100:3", interval: "1h", text: "later" });
    const fired: string[] = [];
    const scheduler = new RecurringTaskScheduler(store, async (t) => {
      fired.push(t.text);
      if (t.text === "fail") throw new Error("runner down");
    }, 60_000);
    scheduler.start();
    await Bun.sleep(20);
    scheduler.stop();
    expect(fired.sort()).toEqual(["fail", "ok"]);
    const failed = store.list("-100:2")[0];
    expect(failed.nextRunAt).toBeGreaterThan(Date.now());
    expect(failed.runCount).toBe(1);
  });
});
