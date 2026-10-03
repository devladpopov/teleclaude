/**
 * Reminders — встроенная фича роутера для отложенных напоминаний.
 *
 * Идея: пользователь говорит "/remind 1h текст" в любом топике (или в
 * личке), запись падает в config/reminders.json, фоновый scheduler раз
 * в 15 секунд проверяет файл и отправляет sendMessage в нужный
 * chat_id + message_thread_id, когда время пришло.
 *
 * Никакой Claude-сессии и никаких внешних cron'ов — всё внутри Bun-
 * процесса роутера. Переживает рестарт бота: при старте scheduler
 * перечитывает файл и работает с тем, что не успело сработать
 * (включая «просроченные» — они отправляются сразу).
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import * as chrono from "chrono-node";

export interface Reminder {
  id: string;
  chatId: string;          // string-form, как в TopicsConfig
  threadId: number | null; // null для личных чатов / general
  text: string;
  fireAt: number;          // epoch ms
  createdAt: number;
  createdBy: number;       // telegram user id
  /**
   * Если true — при срабатывании запустится Claude в этом топике с
   * текстом напоминания как user-message (через triggerTopicAuto),
   * вместо обычной отправки sendMessage. Включается флагом /remind --do
   * или NL-паттерном time-prefix без слова "напомни"
   * ("через час проверь...", "в 8 запусти...", "завтра в 9 пришли...").
   */
  runClaude?: boolean;
}

interface RemindersFile {
  reminders: Reminder[];
}

// ----- Парсер длительности ----------------------------------------------

/**
 * Парсит человеческую длительность в миллисекунды.
 *
 *   "1h"      → 3 600 000
 *   "30m"     → 1 800 000
 *   "1d2h"    → 93 600 000
 *   "90s"     → 90 000
 *   "2ч30м"   → 9 000 000
 *
 * Поддерживаемые единицы (англ. + рус.):
 *   секунды: s, sec, с, сек
 *   минуты:  m, min, м, мин
 *   часы:    h, hr, ч, час
 *   дни:     d, day, д, дн
 *
 * Возвращает null, если не нашёл ни одной валидной пары.
 */
export function parseDuration(input: string): number | null {
  if (!input) return null;
  const map: Record<string, number> = {
    s: 1_000, sec: 1_000, с: 1_000, сек: 1_000,
    m: 60_000, min: 60_000, м: 60_000, мин: 60_000,
    h: 3_600_000, hr: 3_600_000, ч: 3_600_000, час: 3_600_000,
    d: 86_400_000, day: 86_400_000, д: 86_400_000, дн: 86_400_000,
  };
  // Длинные алиасы — раньше коротких, чтобы не схватить "м" вместо "мин".
  const re = /(\d+)\s*(сек|мин|час|дн|day|min|sec|hr|с|м|ч|д|s|m|h|d)/gi;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const n = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const ms = map[unit];
    if (ms === undefined) return null;
    total += n * ms;
    matched = true;
  }
  return matched && total > 0 ? total : null;
}

/**
 * Форматирует ms в короткую человеческую строку: "1д 2ч 30м", "45с".
 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const parts: string[] = [];
  if (d) parts.push(`${d}д`);
  if (h) parts.push(`${h}ч`);
  if (m) parts.push(`${m}м`);
  if (s && !d && !h) parts.push(`${s}с`);
  return parts.length ? parts.join(" ") : "0с";
}

/**
 * Парсит "когда" — относительную длительность ИЛИ абсолютную дату на
 * естественном языке (рус/англ через chrono-node).
 *
 * Стратегия:
 *   1. Сначала пробуем strict relative на ПЕРВОМ токене ("1h", "2д3ч").
 *      Это быстро и не путается с chrono.
 *   2. Если не сработало — отдаём всю строку chrono, сначала ru-парсеру,
 *      потом дефолтному (en + casual). forwardDate=true гарантирует, что
 *      "пятница" / "в 14:00" — это ближайшее будущее.
 *
 * Возвращает:
 *   - fireAt — целевой epoch ms
 *   - consumed — подстрока, которую парсер «съел» как дату
 *   - rest — то, что осталось от input (это будет текст напоминания)
 */
export function parseWhen(
  input: string,
  now: number = Date.now(),
): { fireAt: number; consumed: string; rest: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1) Strict relative duration on the FIRST token
  const firstToken = trimmed.split(/\s+/)[0];
  const ms = parseDuration(firstToken);
  if (ms !== null && ms > 0) {
    return {
      fireAt: now + ms,
      consumed: firstToken,
      rest: trimmed.slice(firstToken.length).trim(),
    };
  }

  // 2) chrono natural language — Russian first, then default
  const refDate = new Date(now);
  const tryParse = (parser: any) => {
    try {
      const results = parser.parse(trimmed, refDate, { forwardDate: true });
      return Array.isArray(results) && results.length > 0 ? results[0] : null;
    } catch {
      return null;
    }
  };

  let result = (chrono as any).ru ? tryParse((chrono as any).ru) : null;
  if (!result) result = tryParse(chrono);
  if (!result) return null;

  const fireAt = result.start.date().getTime();
  if (!Number.isFinite(fireAt) || fireAt <= now) return null;

  const matchedText: string = result.text;
  const idx: number = result.index;
  const before = trimmed.slice(0, idx);
  const after = trimmed.slice(idx + matchedText.length);
  const rest = (before + " " + after).trim().replace(/\s+/g, " ");

  return { fireAt, consumed: matchedText, rest };
}

/**
 * Форматирует абсолютное время в локальную ISO-подобную строку.
 */
export function formatFireAt(epoch: number): string {
  const d = new Date(epoch);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ----- Хранилище ---------------------------------------------------------

export class ReminderStore {
  private path: string;
  private data: RemindersFile = { reminders: [] };

  constructor(filePath: string) {
    this.path = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) {
        // Гарантируем, что директория есть
        const dir = dirname(this.path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        this.data = { reminders: [] };
        this.persistSync();
        return;
      }
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as RemindersFile;
      this.data = {
        reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      };
    } catch (err) {
      console.error(`[Reminders] Failed to load ${this.path}:`, (err as Error).message);
      this.data = { reminders: [] };
    }
  }

  /**
   * Атомарная запись через temp+rename — защита от corrupt-файла, если
   * процесс упадёт посреди записи (Bun на Windows ловит ECONNRESET и т.п.).
   */
  private persistSync(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
    renameSync(tmp, this.path);
  }

  // list/add/remove re-read the file first: reminder-mcp (inside running
  // jobs) writes the same file, and writing a stale in-memory copy back
  // would drop the reminders it added since our last read.
  list(filter?: { chatId?: string; threadId?: number | null }): Reminder[] {
    this.load();
    let out = [...this.data.reminders];
    if (filter?.chatId !== undefined) {
      out = out.filter(r => r.chatId === filter.chatId);
    }
    if (filter?.threadId !== undefined) {
      out = out.filter(r => r.threadId === filter.threadId);
    }
    return out.sort((a, b) => a.fireAt - b.fireAt);
  }

  add(r: Reminder): void {
    this.load();
    this.data.reminders.push(r);
    this.persistSync();
  }

  remove(id: string): boolean {
    this.load();
    const before = this.data.reminders.length;
    this.data.reminders = this.data.reminders.filter(r => r.id !== id);
    if (this.data.reminders.length !== before) {
      this.persistSync();
      return true;
    }
    return false;
  }

  /**
   * Возвращает всё, что должно было сработать к указанному моменту,
   * и удаляет эти записи из хранилища одной транзакцией.
   *
   * Перед выборкой re-load с диска: позволяет внешним инструментам
   * (например, Claude-MCP-tool, или ручная правка JSON) добавлять
   * напоминания без рестарта роутера. Persist гарантирует, что наши
   * собственные in-memory изменения уже на диске, так что re-read
   * идемпотентен.
   */
  popDue(now: number): Reminder[] {
    this.load();
    const due: Reminder[] = [];
    const remaining: Reminder[] = [];
    for (const r of this.data.reminders) {
      if (r.fireAt <= now) due.push(r);
      else remaining.push(r);
    }
    if (due.length > 0) {
      this.data.reminders = remaining;
      this.persistSync();
    }
    return due;
  }
}

// ----- Генератор ID ------------------------------------------------------

/**
 * Короткий, уникальный, читаемый: base36 timestamp + 3 случайных символа.
 * Пример: "lkz1m8a-x4q"
 */
export function generateReminderId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 5);
  return `${ts}-${rnd}`;
}

// ----- Scheduler ---------------------------------------------------------

export type ReminderFireFn = (r: Reminder) => Promise<void>;

export class ReminderScheduler {
  private store: ReminderStore;
  private fire: ReminderFireFn;
  private timer?: ReturnType<typeof setInterval>;
  private intervalMs: number;

  constructor(store: ReminderStore, fire: ReminderFireFn, intervalMs = 15_000) {
    this.store = store;
    this.fire = fire;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    // Первый тик — сразу: разгребаем «просроченные» с прошлой жизни процесса.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    console.log(`[Reminders] Scheduler started (tick every ${this.intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      console.log("[Reminders] Scheduler stopped");
    }
  }

  private async tick(): Promise<void> {
    let due: Reminder[];
    try {
      due = this.store.popDue(Date.now());
    } catch (err) {
      console.error("[Reminders] popDue failed:", (err as Error).message);
      return;
    }
    for (const r of due) {
      try {
        await this.fire(r);
        console.log(`[Reminders] Fired ${r.id} → chat ${r.chatId}/${r.threadId ?? "general"}`);
      } catch (err) {
        // Если отправка упала (например, бот выкинут из чата) —
        // НЕ возвращаем напоминание обратно: иначе будем долбить
        // одну и ту же ошибку каждые 15 секунд.
        console.error(`[Reminders] Fire failed for ${r.id}:`, (err as Error).message);
      }
    }
  }
}
