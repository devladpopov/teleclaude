/**
 * Recurring scheduled tasks — мини-cron внутри ClaudeRouterBot.
 *
 * Пользователь пишет в любой топик `/loop 6h проверь все боты` — Director
 * каждые 6 часов спавнит Claude в этом топике с этим текстом.
 *
 * Идея вдохновлена /loop в Claude Code и Anthropic Routines, но мы
 * остаёмся локальными: используем уже существующий триггер-конвейер
 * (Director rate-limit / quota / spawn-mcp-config), не зависим от
 * облака. Когда облачные Routines стабилизируются — можно добавить
 * "переадресацию" туда (см. Phase 3d).
 *
 * Persistence: config/recurring.json. Атомарно через временный файл.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { dirname } from "path";

export interface RecurringTask {
  id: string;
  topicKey: string;        // chatId:threadId, "<chat>:general" for general
  interval: string;        // human-readable original ("6h", "30m", "1d")
  intervalMs: number;      // parsed for math
  text: string;            // user message Director will send
  createdAt: number;       // epoch ms
  createdBy?: number;      // Telegram user id who registered it
  lastRunAt?: number;      // epoch ms of last fire
  nextRunAt: number;       // epoch ms when due next
  /** If set, scheduler stops after N fires. Default: forever. */
  maxRuns?: number;
  runCount?: number;
}

const INTERVAL_RE = /^(\d+)\s*(s|m|h|d)$/i;

export function parseInterval(raw: string): number | undefined {
  const m = INTERVAL_RE.exec(raw.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  switch (m[2].toLowerCase()) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default:  return undefined;
  }
}

/** Minimum interval. Anything smaller is rate-spam. */
const MIN_INTERVAL_MS = 60 * 1000; // 1 min
/** Maximum interval, 30 days. Beyond that — schedule manually. */
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export class RecurringTaskStore {
  private path: string;
  private tasks = new Map<string, RecurringTask>();

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf-8");
      const data = JSON.parse(raw) as { tasks?: RecurringTask[] };
      if (Array.isArray(data.tasks)) {
        for (const t of data.tasks) {
          if (t && typeof t.id === "string") this.tasks.set(t.id, t);
        }
        console.log(`[Recurring] Loaded ${this.tasks.size} task(s) from ${this.path}`);
      }
    } catch (err) {
      console.error(`[Recurring] Failed to load ${this.path}:`, (err as Error).message);
    }
  }

  private save(): void {
    const tmp = this.path + ".tmp";
    const dir = dirname(this.path);
    try {
      // dirname guaranteed to exist via construction; no mkdir.
      writeFileSync(tmp, JSON.stringify({ tasks: [...this.tasks.values()] }, null, 2), "utf-8");
      renameSync(tmp, this.path);
    } catch (err) {
      console.error(`[Recurring] Save failed:`, (err as Error).message);
    }
    void dir;
  }

  add(opts: {
    topicKey: string;
    interval: string;
    text: string;
    createdBy?: number;
    maxRuns?: number;
    /** Override the default first-fire time (default: createdAt + intervalMs). */
    firstFireAt?: number;
  }): RecurringTask | { error: string } {
    const intervalMs = parseInterval(opts.interval);
    if (!intervalMs) {
      return { error: `Не понимаю интервал "${opts.interval}". Примеры: 5m, 30m, 1h, 6h, 12h, 1d.` };
    }
    if (intervalMs < MIN_INTERVAL_MS) {
      return { error: `Интервал слишком маленький — минимум 1m.` };
    }
    if (intervalMs > MAX_INTERVAL_MS) {
      return { error: `Интервал слишком большой — максимум 30d.` };
    }
    if (!opts.text.trim()) {
      return { error: `Текст пустой. /loop <interval> <text>.` };
    }
    const now = Date.now();
    const id = Math.random().toString(16).slice(2, 8);
    const task: RecurringTask = {
      id,
      topicKey: opts.topicKey,
      interval: opts.interval,
      intervalMs,
      text: opts.text.trim(),
      createdAt: now,
      createdBy: opts.createdBy,
      nextRunAt: opts.firstFireAt ?? (now + intervalMs),
      maxRuns: opts.maxRuns,
      runCount: 0,
    };
    this.tasks.set(id, task);
    this.save();
    return task;
  }

  remove(id: string): boolean {
    const ok = this.tasks.delete(id);
    if (ok) this.save();
    return ok;
  }

  list(topicKey?: string): RecurringTask[] {
    const all = [...this.tasks.values()];
    if (!topicKey) return all;
    return all.filter(t => t.topicKey === topicKey);
  }

  /**
   * Pop tasks whose nextRunAt <= now. Each popped task gets its
   * nextRunAt advanced by intervalMs (or removed if maxRuns reached).
   * Returned array is the list to fire this tick.
   */
  popDue(now: number): RecurringTask[] {
    const due: RecurringTask[] = [];
    let mutated = false;
    for (const t of this.tasks.values()) {
      if (t.nextRunAt > now) continue;
      due.push(t);
      const newCount = (t.runCount ?? 0) + 1;
      if (t.maxRuns && newCount >= t.maxRuns) {
        this.tasks.delete(t.id);
      } else {
        t.runCount = newCount;
        t.lastRunAt = now;
        t.nextRunAt = now + t.intervalMs;
      }
      mutated = true;
    }
    if (mutated) this.save();
    return due;
  }
}

export type RecurringFireFn = (task: RecurringTask) => Promise<void>;

export class RecurringTaskScheduler {
  private store: RecurringTaskStore;
  private fire: RecurringFireFn;
  private timer?: ReturnType<typeof setInterval>;
  private intervalMs: number;

  constructor(store: RecurringTaskStore, fire: RecurringFireFn, intervalMs = 30_000) {
    this.store = store;
    this.fire = fire;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    // First tick immediately so any tasks overdue from a previous run
    // get caught up. `popDue` only fires those with nextRunAt <= now.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    console.log(`[Recurring] Scheduler started (tick every ${this.intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      console.log(`[Recurring] Scheduler stopped`);
    }
  }

  private async tick(): Promise<void> {
    let due: RecurringTask[];
    try {
      due = this.store.popDue(Date.now());
    } catch (err) {
      console.error(`[Recurring] popDue failed:`, (err as Error).message);
      return;
    }
    for (const t of due) {
      try {
        await this.fire(t);
        console.log(`[Recurring] Fired ${t.id} → ${t.topicKey} (${t.interval}): ${t.text.slice(0, 60)}`);
      } catch (err) {
        // Don't roll back nextRunAt — same logic as Reminders. Otherwise
        // a transient failure means the task fires every tick forever.
        console.error(`[Recurring] Fire failed for ${t.id}:`, (err as Error).message);
      }
    }
  }
}
