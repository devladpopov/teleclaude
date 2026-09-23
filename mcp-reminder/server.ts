#!/usr/bin/env bun
/**
 * mcp-reminder — крошечный stdio-based MCP-сервер, который позволяет Claude
 * планировать напоминания напрямую, без слэш-команд.
 *
 * АРХИТЕКТУРА: сервер ничего НЕ диспатчит сам. Он только пишет в общий
 * config/reminders.json роутера (атомарно через temp+rename). Реальный
 * fire выполняет роутерный ReminderScheduler — он раз в 15 секунд
 * перечитывает файл. Если runClaude=true (default для MCP), вызывается
 * triggerTopicAuto (Claude spawn). Если false — обычный sendMessage.
 *
 * Это даёт нам ровно одну точку доставки напоминаний и отсутствие
 * дублирующих компонентов. Если роутер лежит — напоминания копятся в
 * JSON и сработают при подъёме.
 *
 * ENV CONTRACT (инжектится роутером в process-manager.ts):
 *   - REMINDERS_JSON_PATH    путь до config/reminders.json
 *   - TOPIC_CHAT_ID          chat_id текущего топика (default для tools)
 *   - TOPIC_THREAD_ID        thread_id текущего топика ("" = general)
 *
 * ИНСТРУМЕНТЫ:
 *   - schedule_reminder(text, when, chat_id?, thread_id?)
 *   - list_reminders(chat_id?, thread_id?, scope?)
 *   - cancel_reminder(id)
 *
 * "when" принимает:
 *   - relative:  "1h", "30m", "2д3ч", "90s"
 *   - natural:   "завтра в 9", "в пятницу 14:00", "10 апреля 18:00",
 *                "in 2 hours", "tomorrow at noon"
 *   - ISO:       "2026-04-10T18:00:00Z" или "2026-04-10 18:00"
 *
 * Стек: stdio JSON-RPC 2.0, никаких внешних SDK — экономит зависимости и
 * упрощает диагностику. Следуем спецификации MCP 2024-11-05 (initialize,
 * tools/list, tools/call).
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import * as chrono from "chrono-node";

// ----- Конфиг через env -------------------------------------------------

const REMINDERS_PATH =
  process.env.REMINDERS_JSON_PATH ||
  resolve(process.cwd(), "config/reminders.json");

const DEFAULT_CHAT_ID = process.env.TOPIC_CHAT_ID || "";
const DEFAULT_THREAD_ID_RAW = process.env.TOPIC_THREAD_ID || "";
const DEFAULT_THREAD_ID: number | null = DEFAULT_THREAD_ID_RAW
  ? parseInt(DEFAULT_THREAD_ID_RAW, 10)
  : null;

// ----- Reminder store (минимальная копия из reminders.ts) ----------------

interface Reminder {
  id: string;
  chatId: string;
  threadId: number | null;
  text: string;
  fireAt: number;
  createdAt: number;
  createdBy: number;
  runClaude?: boolean;
}
interface RemindersFile {
  reminders: Reminder[];
}

function loadFile(): RemindersFile {
  try {
    if (!existsSync(REMINDERS_PATH)) {
      const dir = dirname(REMINDERS_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      return { reminders: [] };
    }
    const raw = readFileSync(REMINDERS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as RemindersFile;
    return { reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [] };
  } catch (err) {
    log("loadFile failed:", (err as Error).message);
    return { reminders: [] };
  }
}

function saveFile(data: RemindersFile): void {
  const tmp = `${REMINDERS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, REMINDERS_PATH);
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 5);
  return `mcp-${ts}-${rnd}`;
}

// ----- Парсер «когда» (полная копия логики из reminders.ts) -------------

function parseDuration(input: string): number | null {
  if (!input) return null;
  const map: Record<string, number> = {
    s: 1_000, sec: 1_000, с: 1_000, сек: 1_000,
    m: 60_000, min: 60_000, м: 60_000, мин: 60_000,
    h: 3_600_000, hr: 3_600_000, ч: 3_600_000, час: 3_600_000,
    d: 86_400_000, day: 86_400_000, д: 86_400_000, дн: 86_400_000,
  };
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

function parseWhen(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const now = Date.now();

  // Сначала пробуем строгий relative
  const ms = parseDuration(trimmed);
  if (ms !== null && ms > 0) return now + ms;

  // ISO 8601
  const iso = Date.parse(trimmed);
  if (Number.isFinite(iso) && iso > now) return iso;

  // chrono natural language: ru → default
  const refDate = new Date(now);
  const tryParse = (parser: any): number | null => {
    try {
      const results = parser.parse(trimmed, refDate, { forwardDate: true });
      if (!Array.isArray(results) || results.length === 0) return null;
      const fa = results[0].start.date().getTime();
      return Number.isFinite(fa) && fa > now ? fa : null;
    } catch {
      return null;
    }
  };
  const ru = (chrono as any).ru ? tryParse((chrono as any).ru) : null;
  if (ru !== null) return ru;
  return tryParse(chrono);
}

function formatFireAt(epoch: number): string {
  const d = new Date(epoch);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const parts: string[] = [];
  if (d) parts.push(`${d}д`);
  if (h) parts.push(`${h}ч`);
  if (m) parts.push(`${m}м`);
  return parts.length ? parts.join(" ") : "<1м";
}

// ----- Tool implementations ---------------------------------------------

function toolScheduleReminder(args: any): any {
  const text = (args?.text ?? "").toString().trim();
  const when = (args?.when ?? "").toString().trim();
  const chatId = (args?.chat_id ?? DEFAULT_CHAT_ID).toString();
  const threadIdRaw = args?.thread_id;
  const threadId: number | null =
    threadIdRaw === undefined || threadIdRaw === null || threadIdRaw === ""
      ? DEFAULT_THREAD_ID
      : Number(threadIdRaw);

  if (!text) return { error: "text is required" };
  if (!when) return { error: "when is required" };
  if (!chatId) {
    return {
      error:
        "chat_id is required (no TOPIC_CHAT_ID env var found — pass chat_id explicitly)",
    };
  }

  const fireAt = parseWhen(when);
  if (fireAt === null) {
    return {
      error: `cannot parse "when": "${when}". Examples: "1h", "2д3ч", "tomorrow at 9", "завтра в 9", "в пятницу 14:00", "2026-04-10 18:00"`,
    };
  }

  const now = Date.now();
  const MAX_MS = 365 * 24 * 3_600_000;
  if (fireAt - now > MAX_MS) {
    return { error: "too far in the future (>1 year)" };
  }

  // Default run_claude=true for MCP-created reminders: Claude schedules
  // them to trigger actions, not just display text.
  const runClaude = args?.run_claude !== false;

  const reminder: Reminder = {
    id: generateId(),
    chatId,
    threadId: Number.isFinite(threadId as number) ? (threadId as number) : null,
    text,
    fireAt,
    createdAt: now,
    createdBy: 0, // MCP-источник, не телеграм-юзер
    runClaude,
  };

  const data = loadFile();
  data.reminders.push(reminder);
  saveFile(data);

  return {
    ok: true,
    id: reminder.id,
    fire_at: formatFireAt(fireAt),
    fire_at_epoch_ms: fireAt,
    fires_in: formatDuration(fireAt - now),
    chat_id: reminder.chatId,
    thread_id: reminder.threadId,
    text: reminder.text,
  };
}

function toolListReminders(args: any): any {
  const chatId = (args?.chat_id ?? "").toString();
  const threadIdRaw = args?.thread_id;
  const scope = (args?.scope ?? "").toString().toLowerCase();

  const data = loadFile();
  let list = data.reminders.slice();

  if (scope !== "all") {
    const cid = chatId || DEFAULT_CHAT_ID;
    if (cid) list = list.filter((r) => r.chatId === cid);
    if (threadIdRaw !== undefined && threadIdRaw !== null && threadIdRaw !== "") {
      const tid = Number(threadIdRaw);
      list = list.filter((r) => r.threadId === tid);
    } else if (DEFAULT_THREAD_ID !== null && !chatId) {
      list = list.filter((r) => r.threadId === DEFAULT_THREAD_ID);
    }
  }

  list.sort((a, b) => a.fireAt - b.fireAt);
  const now = Date.now();
  return {
    count: list.length,
    reminders: list.map((r) => ({
      id: r.id,
      chat_id: r.chatId,
      thread_id: r.threadId,
      text: r.text,
      fire_at: formatFireAt(r.fireAt),
      fires_in: formatDuration(r.fireAt - now),
    })),
  };
}

function toolCancelReminder(args: any): any {
  const id = (args?.id ?? "").toString();
  if (!id) return { error: "id is required" };
  const data = loadFile();
  const before = data.reminders.length;
  data.reminders = data.reminders.filter((r) => r.id !== id);
  if (data.reminders.length === before) {
    return { ok: false, error: `no reminder with id "${id}"` };
  }
  saveFile(data);
  return { ok: true, cancelled: id };
}

// ----- Tool definitions (MCP schema) ------------------------------------

const TOOLS = [
  {
    name: "schedule_reminder",
    description:
      "Schedule a Telegram reminder. The router's scheduler will deliver it to the specified chat/topic at the specified time. Supports relative times (1h, 2d3h, 30m), natural language in Russian and English (\"завтра в 9\", \"in 2 hours\", \"tomorrow at noon\", \"в пятницу 14:00\", \"10 апреля 18:00\"), and ISO timestamps. If chat_id/thread_id are omitted, uses TOPIC_CHAT_ID/TOPIC_THREAD_ID env vars (set automatically by the router for the current topic).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Reminder text content" },
        when: {
          type: "string",
          description:
            "When to fire. Examples: '1h', '2д3ч', '90s', 'завтра в 9', 'в пятницу 14:00', '10 апреля 18:00', 'in 2 hours', 'tomorrow at noon', '2026-04-10 18:00'",
        },
        chat_id: {
          type: "string",
          description:
            "Telegram chat_id (string form, e.g. '-1001234567890'). Optional — defaults to current topic via TOPIC_CHAT_ID env.",
        },
        thread_id: {
          type: ["number", "string", "null"],
          description:
            "Telegram message_thread_id for forum topics. Omit/null for general chat or private chats. Defaults to current topic.",
        },
        run_claude: {
          type: "boolean",
          description:
            "If true (default), when the reminder fires the router spawns Claude in the target topic with the reminder text as a user message (triggerTopicAuto). If false, just sends a plain sendMessage notification. Default: true — because when Claude schedules a reminder, it usually means 'do this action at that time', not 'just display text'.",
        },
      },
      required: ["text", "when"],
    },
  },
  {
    name: "list_reminders",
    description:
      "List pending reminders. By default — only the current topic (uses TOPIC_CHAT_ID/TOPIC_THREAD_ID env vars). Pass scope='all' to see everything across all topics, or specify chat_id/thread_id explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        thread_id: { type: ["number", "string", "null"] },
        scope: {
          type: "string",
          enum: ["topic", "all"],
          description: "'topic' (default) or 'all'",
        },
      },
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a pending reminder by its id (returned from schedule_reminder).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
];

// ----- JSON-RPC stdio loop ----------------------------------------------

function log(...args: any[]): void {
  // ВАЖНО: stderr only. stdout — это JSON-RPC канал.
  console.error("[mcp-reminder]", ...args);
}

function send(msg: any): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handleRequest(req: any): any {
  const { id, method, params } = req;

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "reminder-mcp", version: "0.1.0" },
        },
      };
    }
    if (method === "notifications/initialized" || method === "initialized") {
      return null; // notification, no response
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      let result: any;
      switch (toolName) {
        case "schedule_reminder":
          result = toolScheduleReminder(args);
          break;
        case "list_reminders":
          result = toolListReminders(args);
          break;
        case "cancel_reminder":
          result = toolCancelReminder(args);
          break;
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          };
      }
      const isError = !!result?.error;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError,
        },
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${method}` },
    };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: (err as Error).message },
    };
  }
}

// stdin → newline-delimited JSON-RPC
let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req: any;
    try {
      req = JSON.parse(line);
    } catch (err) {
      log("invalid JSON:", line);
      continue;
    }
    const resp = handleRequest(req);
    if (resp !== null) send(resp);
  }
});

process.stdin.on("end", () => {
  log("stdin closed, exiting");
  process.exit(0);
});

log(`started. reminders=${REMINDERS_PATH} topic=${DEFAULT_CHAT_ID}/${DEFAULT_THREAD_ID ?? "general"}`);
