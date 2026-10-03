import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ReminderScheduler, ReminderStore, formatDuration, generateReminderId, parseDuration, parseWhen,
  type Reminder,
} from "../src/reminders";

const dir = mkdtempSync(join(tmpdir(), "tc-remind-"));
let n = 0;
const freshPath = () => join(dir, `reminders-${n++}.json`);

function reminder(extra: Partial<Reminder> = {}): Reminder {
  return {
    id: generateReminderId(), chatId: "-100", threadId: 7, text: "позвонить",
    fireAt: Date.now() + 3_600_000, createdAt: Date.now(), createdBy: 42, ...extra,
  };
}

describe("parseDuration", () => {
  test("english and russian units, compound values", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1d2h")).toBe(93_600_000);
    expect(parseDuration("2ч30м")).toBe(9_000_000);
    expect(parseDuration("15мин")).toBe(900_000);
    expect(parseDuration("2дн")).toBe(2 * 86_400_000);
    expect(parseDuration("1 hr")).toBe(3_600_000);
  });

  test("no number with unit, or zero: null", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("завтра")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("10")).toBeNull();
  });
});

describe("parseWhen", () => {
  // Fixed local time: Thursday 2026-10-01 10:00
  const now = new Date(2026, 9, 1, 10, 0, 0).getTime();

  test("relative duration in the first token, rest is the text", () => {
    expect(parseWhen("1h позвонить в банк", now)).toEqual({ fireAt: now + 3_600_000, consumed: "1h", rest: "позвонить в банк" });
    expect(parseWhen("2д3ч дедлайн", now)!.fireAt).toBe(now + 2 * 86_400_000 + 3 * 3_600_000);
  });

  test("russian natural language", () => {
    const r = parseWhen("завтра в 9 купить хлеб", now)!;
    expect(new Date(r.fireAt)).toEqual(new Date(2026, 9, 2, 9, 0, 0));
    expect(r.rest).toBe("купить хлеб");
    const in2h = parseWhen("через 2 часа проверь сайт", now)!;
    expect(in2h.fireAt).toBe(now + 2 * 3_600_000);
    expect(in2h.rest).toBe("проверь сайт");
  });

  test("english natural language", () => {
    const r = parseWhen("tomorrow at 9 check the build", now)!;
    expect(new Date(r.fireAt)).toEqual(new Date(2026, 9, 2, 9, 0, 0));
    expect(r.rest).toBe("check the build");
    expect(parseWhen("in 2 hours run the report", now)!.fireAt).toBe(now + 2 * 3_600_000);
  });

  test("a time already passed today moves forward, nothing parsable is null", () => {
    const r = parseWhen("в 9:00 стендап", now)!;
    expect(r.fireAt).toBeGreaterThan(now);
    expect(parseWhen("просто текст", now)).toBeNull();
    expect(parseWhen("   ", now)).toBeNull();
  });
});

describe("formatDuration", () => {
  test("short human form", () => {
    expect(formatDuration(0)).toBe("0с");
    expect(formatDuration(-5)).toBe("0с");
    expect(formatDuration(45_000)).toBe("45с");
    expect(formatDuration(90_000)).toBe("1м 30с");
    expect(formatDuration(3_600_000 + 30 * 60_000 + 5_000)).toBe("1ч 30м");
    expect(formatDuration(86_400_000 + 2 * 3_600_000)).toBe("1д 2ч");
  });
});

describe("ReminderStore", () => {
  test("creates the file, sorts by time, filters by chat and thread", () => {
    const path = freshPath();
    const store = new ReminderStore(path);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ reminders: [] });
    const late = reminder({ fireAt: Date.now() + 7_200_000 });
    const early = reminder({ fireAt: Date.now() + 60_000 });
    const general = reminder({ threadId: null });
    store.add(late);
    store.add(early);
    store.add(general);
    expect(store.list({ chatId: "-100", threadId: 7 }).map((r) => r.id)).toEqual([early.id, late.id]);
    expect(store.list({ chatId: "-100", threadId: null }).map((r) => r.id)).toEqual([general.id]);
    expect(store.list({ chatId: "-200" })).toEqual([]);
    expect(new ReminderStore(path).list()).toHaveLength(3);
  });

  test("popDue returns and removes due reminders only", () => {
    const store = new ReminderStore(freshPath());
    const due = reminder({ fireAt: 1_000 });
    const later = reminder({ fireAt: Date.now() + 60_000 });
    store.add(due);
    store.add(later);
    expect(store.popDue(Date.now()).map((r) => r.id)).toEqual([due.id]);
    expect(store.list().map((r) => r.id)).toEqual([later.id]);
    expect(store.popDue(Date.now())).toEqual([]);
  });

  test("popDue sees reminders written to the file by reminder-mcp", () => {
    const path = freshPath();
    const store = new ReminderStore(path);
    const external = reminder({ fireAt: 1_000, text: "from mcp" });
    writeFileSync(path, JSON.stringify({ reminders: [external] }));
    expect(store.popDue(Date.now()).map((r) => r.text)).toEqual(["from mcp"]);
  });

  test("corrupt file: empty list, no crash", () => {
    const path = freshPath();
    writeFileSync(path, "{broken");
    expect(new ReminderStore(path).list()).toEqual([]);
  });

  test("id: base36 time and a short random suffix", () => {
    expect(generateReminderId()).toMatch(/^[0-9a-z]+-[0-9a-z]{1,3}$/);
  });
});

describe("ReminderScheduler", () => {
  test("overdue reminders fire on start; a failed send is dropped, not retried", async () => {
    const store = new ReminderStore(freshPath());
    store.add(reminder({ fireAt: 1, text: "a" }));
    store.add(reminder({ fireAt: 2, text: "b", runClaude: true }));
    store.add(reminder({ text: "later" }));
    const fired: Reminder[] = [];
    const scheduler = new ReminderScheduler(store, async (r) => {
      fired.push(r);
      if (r.text === "a") throw new Error("bot kicked");
    }, 60_000);
    scheduler.start();
    await Bun.sleep(20);
    scheduler.stop();
    expect(fired.map((r) => r.text)).toEqual(["a", "b"]);
    expect(fired[1].runClaude).toBe(true);
    expect(store.list().map((r) => r.text)).toEqual(["later"]);
  });
});
