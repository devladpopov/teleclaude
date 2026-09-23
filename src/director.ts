/**
 * Director — автономный операционный менеджер для топиков.
 *
 * Тикает каждые 15 минут (без ИИ):
 *   1. Обходит все проектные папки из topics.json
 *   2. Читает CHECKPOINT.md из каждой — статус, прогресс, подзадачи
 *   3. Определяет "зависшие" задачи (IN_PROGRESS + no activity > threshold)
 *   4. Обновляет director-registry.json (единый реестр)
 *   5. Генерирует director-dashboard.json (для хаба)
 *   6. Опционально: отправляет триггер-сообщение в зависший топик
 *
 * Стоимость: 0 токенов. Вся логика — файловый I/O.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, renameSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { TopicsConfig, TopicMapping } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TopicCategory = "development" | "communication" | "operations" | "ignore" | "other";
export type TopicStatus = "IN_PROGRESS" | "COMPLETED" | "STALLED" | "AWAITING_USER" | "NOT_STARTED" | "DEFERRED";

export interface SubTask {
  text: string;
  done: boolean;
  /** Telegram message_id of the last bot response when this subtask was marked done. */
  messageId?: number;
}

export interface CheckpointData {
  status: TopicStatus;
  task: string;
  progress: number;        // 0..100
  subtasks: SubTask[];
  lastAction: string;
  next: string;
  doNotRedo: string[];
  verifyBeforeAct: string;
  /**
   * Optional override: model alias to use when Director auto-triggers
   * this topic ("opus" | "sonnet" | "haiku" | "default").
   * Default for auto-triggers is "sonnet" (cheaper).
   * the user sets `AUTO_MODEL: opus` in CHECKPOINT.md for topics where
   * cheap model would cut corners.
   */
  autoModel?: string;
  /**
   * Optional override: if true, this topic is NEVER auto-triggered
   * during the night window (22:00–08:00 UK time). If false, it
   * IS triggered even if its category would normally be skipped at
   * night. Default depends on category: communication = blocked at
   * night, everything else = allowed.
   */
  blockedAtNight?: boolean;
  /**
   * If true, this topic is archived: Director never auto-triggers it,
   * regardless of any other field. Topic still appears on the dashboard
   * (in a separate "Archived" section) so you can see its last known
   * state, but no further work happens until you flip ARCHIVED back to
   * false (or delete the line).
   */
  archived?: boolean;
  /**
   * Optional priority hint: "high" | "normal" | "low" (default: "normal").
   * Director sorts stalled topics by priority desc, then lastActivity desc,
   * so high-priority topics get triggered first within the per-tick cap.
   */
  priority?: "high" | "normal" | "low";
  /**
   * Execution mode for Director auto-triggers:
   *   "simple" (default) — single Sonnet (or AUTO_MODEL) spawn per trigger.
   *   "pev"              — three-phase plan-execute-verify cycle:
   *                        Opus plans → Sonnet executes → Opus verifies.
   */
  executionMode?: "simple" | "pev";
  /** Auto-managed by Director when in PEV mode. Tracks current phase. */
  executionPhase?: "planning" | "executing" | "verifying" | "verifying-visual" | "fixing-visual";
  /** Path to the plan file produced in phase=planning. Carried into executing/verifying. */
  planFile?: string;
  /** Verifier feedback if phase loops back from verifying → executing. */
  feedback?: string;
  /**
   * Visual verification: Sonnet opens VISUAL_URL via Playwright, checks
   * rendering, writes issues to VISUAL_ISSUES.md. If issues found, Opus
   * fixes them (up to VISUAL_ITERATIONS cap, default 3).
   *
   * Activation:
   *   - Explicit: VISUAL_VERIFY: true + VISUAL_URL: <url> in CHECKPOINT.md
   *   - Auto-detect: keywords in TASK/NEXT (верстк, UI, страниц, render,
   *     css, layout, фронт, дизайн) + VISUAL_URL present
   *   - CLI: /visual on|off sets VISUAL_VERIFY
   */
  visualVerify?: boolean;
  visualUrl?: string;
  visualIterations?: number;
  /**
   * BLOCKS / BLOCKED_BY — DAG of inter-topic dependencies. Values are
   * topicKey strings (chatId:threadId form) or short aliases that the
   * router resolves later. Director skips a topic whose blockedBy list
   * contains anything not COMPLETED, and accelerates dependents the
   * tick after a blocker transitions to COMPLETED.
   *
   * Format in CHECKPOINT.md (comma-separated):
   *   BLOCKS: -1001234567890:42, -1001234567890:43
   *   BLOCKED_BY: -1001234567890:44
   */
  blocks?: string[];
  blockedBy?: string[];
  /**
   * Last successful timestamp parsed from `LAST_ACTION` line if it
   * starts with an ISO date (e.g. `2026-05-01 12:34: did X`). Falls
   * back to file mtime if absent. Currently unused — reserved for a
   * future "did the user work on this today?" signal.
   */
  // (no field — placeholder removed; mtime is sufficient signal)
}

export interface TopicState {
  topicKey: string;          // e.g. "-1001234567890:42"
  name: string;
  project: string;           // absolute path
  category: TopicCategory;
  status: TopicStatus;
  task: string;
  progress: number;
  subtasks: SubTask[];
  lastAction: string;
  lastActivity: string;      // ISO date of last CHECKPOINT.md modification
  lastActivityMs: number;    // epoch ms of CHECKPOINT.md mtime — for sort
  next: string;
  stalledMinutes: number;    // how long since last checkpoint update
  autoModel?: string;        // mirrored from CheckpointData
  blockedAtNight?: boolean;  // mirrored from CheckpointData
  archived?: boolean;        // mirrored from CheckpointData
  priority?: "high" | "normal" | "low";  // mirrored from CheckpointData
  executionMode?: "simple" | "pev";        // mirrored from CheckpointData
  executionPhase?: "planning" | "executing" | "verifying" | "verifying-visual" | "fixing-visual";
  planFile?: string;
  feedback?: string;
  visualVerify?: boolean;       // mirrored from CheckpointData
  visualUrl?: string;           // mirrored from CheckpointData
  visualIterations?: number;    // mirrored from CheckpointData
  blocks?: string[];            // mirrored from CheckpointData
  blockedBy?: string[];         // mirrored from CheckpointData
  /**
   * Transient — set by selectTriggerCandidates before fireTrigger, used
   * to label the trigger event ("stale-mtime" | "chain-on-progress" |
   * "fast-retry" | "pev:<phase>"). Not persisted to registry.
   */
  triggerReason?: string;
}

/**
 * State for a deferred topic (rate-limit retry queue).
 * Lives inside DirectorRegistry so it survives router restarts.
 */
export interface DeferredEntry {
  topicKey: string;
  name: string;
  next: string;
  account: string;          // OAuth slot used at the failed attempt
  deferredAt: number;       // epoch ms when we hit the rate limit
  reason: string;           // short tag, e.g. "rate_limit"
  modelOverride?: string;   // model we'd use on resume
}

/**
 * Per-account quota state. When Anthropic returns a rate-limit error
 * for an account, all future spawns on that account are paused until
 * `resumeAt`. Default cooldown is 4 hours (size of Max 5-hour window
 * minus a margin) when we can't parse an exact reset time.
 */
export interface AccountQuotaState {
  exhaustedAt: number;
  resumeAt: number;
  reason: string;
}

export interface DirectorRegistry {
  generatedAt: string;
  totalTopics: number;
  activeCount: number;
  stalledCount: number;
  completedCount: number;
  topics: TopicState[];
  /**
   * Persistent map: topicKey → epoch ms of last auto-trigger.
   * Loaded on Director.start(), rewritten on every tick.
   * Survives router restarts so 2-hour cooldown is honored across crashes.
   */
  lastTriggered?: Record<string, number>;
  /**
   * Deferred queue: topics we wanted to trigger but skipped because
   * their account hit a rate limit. Resumed automatically on the
   * next tick after the account's `resumeAt` passes.
   */
  deferredTopics?: DeferredEntry[];
  /**
   * Per-account quota state. Indexed by AccountManager slot name
   * (e.g. "main", "backup").
   */
  accountQuota?: Record<string, AccountQuotaState>;
  /**
   * Epoch ms of last daily morning summary sent. Persisted so a router
   * restart doesn't re-send the same day's summary.
   */
  lastDailySummaryAt?: number;
  /**
   * Per-topic timestamp of the last MANUAL user message (the user in chat,
   * not a Director auto-trigger). Used by the auto-archive policy:
   * topics idle > AUTO_ARCHIVE_DAYS get archived: "auto" and skipped
   * from auto-trigger. Cleared on next manual message.
   */
  lastManualUserAt?: Record<string, number>;
  /**
   * Per-topic count of consecutive triggers that did not advance state.
   * Drives adaptive cooldown — cooldown doubles each time, up to 24h cap.
   */
  failedCount?: Record<string, number>;
  /**
   * Per-topic per-day trigger counter. Keyed by topicKey, value is the
   * pair (BST date string, count). Used to enforce the daily trigger
   * budget — topics that hit their cap are skipped until midnight BST.
   */
  dailyTriggerCount?: Record<string, { date: string; count: number }>;
}

export interface DashboardData {
  totalTopics: number;
  activeCount: number;
  stalledCount: number;
  completedCount: number;
  deferredCount: number;
  lastScan: string;
  nextReview: string;
  topics: DashboardTopic[];
  /** Per-account quota state visible in the hub UI ("paused until 04:00 UTC" badges). */
  accountQuota?: Record<string, AccountQuotaState>;
}

/**
 * One row in the append-only activity log. Director emits these on each
 * tick when something changes per-topic, plus on every trigger attempt.
 * The hub UI renders them grouped by date in the "Активность" tab.
 */
export interface DirectorEvent {
  ts: string;            // ISO timestamp
  topicKey: string;
  name: string;
  category: TopicCategory;
  kind: "status" | "progress" | "next" | "archived" | "priority" |
        "trigger_started" | "trigger_success" | "trigger_failed" |
        "trigger_rate_limited" | "task" | "subtask";
  from?: string | number | boolean;
  to?: string | number | boolean;
  /** For trigger events: details (e.g. error message). */
  detail?: string;
}

export interface DashboardTopic {
  topicKey: string;
  name: string;
  category: TopicCategory;
  status: TopicStatus;
  task: string;
  progress: number;
  subtasks: SubTask[];
  lastAction: string;
  lastActivity: string;
  /** Set if Director auto-deferred this topic (e.g. account quota lockout). */
  deferred?: { reason: string; account: string; deferredAt: number };
  /** True if topic has ARCHIVED: true in its CHECKPOINT.md — UI hides it from active list. */
  archived?: boolean;
  /** Priority hint from CHECKPOINT.md: "high" | "normal" | "low". Default normal. */
  priority?: "high" | "normal" | "low";
}

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

/**
 * Topic classification by topic name. Lists live in
 * config/director-topics.json (gitignored, see
 * config/director-topics.example.json):
 *   { "ignored": [...], "communication": [...], "operations": [...] }
 * Missing file = everything is "development" except "general".
 */
function loadTopicLists(): { ignored: string[]; communication: string[]; operations: string[] } {
  const empty = { ignored: [], communication: [], operations: [] };
  try {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config", "director-topics.json");
    if (!existsSync(p)) return empty;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return {
      ignored: Array.isArray(raw.ignored) ? raw.ignored : [],
      communication: Array.isArray(raw.communication) ? raw.communication : [],
      operations: Array.isArray(raw.operations) ? raw.operations : [],
    };
  } catch (err) {
    console.warn("[Director] director-topics.json unreadable:", (err as Error).message);
    return empty;
  }
}
const TOPIC_LISTS = loadTopicLists();

/** Topics that Director should NOT track */
const IGNORED_TOPICS = new Set(["general", ...TOPIC_LISTS.ignored]);

/**
 * Topics that Director must NEVER auto-trigger (still scanned and shown
 * on the dashboard, just no "Продолжай" message sent).
 *
 * Reason: the Director topic is the meta-channel where Director itself
 * lives. If its CHECKPOINT.md has a non-trivial NEXT (e.g. "Рестартовать
 * роутер"), Director would tell the bot in that topic to do the action,
 * the action would restart the router, the cooldown would reset, and the
 * bot would re-trigger itself in a tight loop. Hardcoded protection so
 * that even if NEXT is set sloppily, no self-trigger storm happens.
 */
const AUTO_TRIGGER_BLACKLIST = new Set([
  "Director",
  "Директор",
]);

const COMMUNICATION_TOPICS = new Set(TOPIC_LISTS.communication);

const OPERATIONS_TOPICS = new Set(TOPIC_LISTS.operations);

function classifyTopic(name: string): TopicCategory {
  if (IGNORED_TOPICS.has(name)) return "ignore";
  if (COMMUNICATION_TOPICS.has(name)) return "communication";
  if (OPERATIONS_TOPICS.has(name)) return "operations";
  // Default: development (most topics are dev projects)
  return "development";
}

// ---------------------------------------------------------------------------
// CHECKPOINT.md parser
// ---------------------------------------------------------------------------

function parseCheckpoint(content: string): CheckpointData {
  const lines = content.split("\n").map(l => l.trim());

  const get = (key: string): string => {
    const line = lines.find(l => l.startsWith(key + ":"));
    return line ? line.slice(key.length + 1).trim() : "";
  };

  const status = (get("STATUS") || "NOT_STARTED") as TopicStatus;
  const task = get("TASK");
  const progressStr = get("PROGRESS");
  const progress = parseInt(progressStr) || 0;
  const lastAction = get("LAST_ACTION");
  const next = get("NEXT");
  const verifyBeforeAct = get("VERIFY_BEFORE_ACT");
  const autoModelRaw = get("AUTO_MODEL").toLowerCase();
  const autoModel = autoModelRaw && autoModelRaw !== "default" ? autoModelRaw : undefined;
  const blockedAtNightRaw = get("BLOCKED_AT_NIGHT").toLowerCase();
  let blockedAtNight: boolean | undefined;
  if (blockedAtNightRaw === "true") blockedAtNight = true;
  else if (blockedAtNightRaw === "false") blockedAtNight = false;
  const archivedRaw = get("ARCHIVED").toLowerCase();
  const archived = archivedRaw === "true" ? true : undefined;
  const priorityRaw = get("PRIORITY").toLowerCase();
  const priority: "high" | "normal" | "low" | undefined =
    priorityRaw === "high" ? "high" :
    priorityRaw === "low" ? "low" :
    priorityRaw === "normal" ? "normal" : undefined;
  const modeRaw = get("EXECUTION_MODE").toLowerCase();
  const executionMode: "simple" | "pev" | undefined =
    modeRaw === "pev" ? "pev" : modeRaw === "simple" ? "simple" : undefined;
  const phaseRaw = get("EXECUTION_PHASE").toLowerCase();
  const executionPhase: "planning" | "executing" | "verifying" | "verifying-visual" | "fixing-visual" | undefined =
    phaseRaw === "planning" ? "planning" :
    phaseRaw === "executing" ? "executing" :
    phaseRaw === "verifying" ? "verifying" :
    phaseRaw === "verifying-visual" ? "verifying-visual" :
    phaseRaw === "fixing-visual" ? "fixing-visual" : undefined;
  const planFile = get("PLAN_FILE") || undefined;
  const feedback = get("FEEDBACK") || undefined;
  const visualVerifyRaw = get("VISUAL_VERIFY").toLowerCase();
  const visualUrl = get("VISUAL_URL") || undefined;
  const visualIterationsRaw = get("VISUAL_ITERATIONS");
  const visualIterations = parseInt(visualIterationsRaw) || undefined;
  // Auto-detect visual task: keywords in TASK or NEXT + VISUAL_URL present.
  const visualKeywords = /верстк|страниц|ui\b|render|css|layout|фронт|дизайн|визуал/i;
  const visualVerify =
    visualVerifyRaw === "true" ? true :
    visualVerifyRaw === "false" ? false :
    (visualUrl && visualKeywords.test(task + " " + next)) ? true : undefined;

  // Parse subtasks (- [x] or - [ ])
  const subtasks: SubTask[] = [];
  let inSubtasks = false;
  for (const line of lines) {
    if (line === "SUBTASKS:") { inSubtasks = true; continue; }
    if (inSubtasks) {
      if (line.startsWith("- [x]") || line.startsWith("- [X]")) {
        subtasks.push({ text: line.slice(6).trim(), done: true });
      } else if (line.startsWith("- [ ]")) {
        subtasks.push({ text: line.slice(6).trim(), done: false });
      } else if (line.startsWith("- ")) {
        subtasks.push({ text: line.slice(2).trim(), done: false });
      } else if (line && !line.startsWith("-")) {
        inSubtasks = false; // End of subtasks section
      }
    }
  }

  // Parse DO_NOT_REDO
  const doNotRedo: string[] = [];
  let inDnr = false;
  for (const line of lines) {
    if (line === "DO_NOT_REDO:") { inDnr = true; continue; }
    if (inDnr) {
      if (line.startsWith("- ")) {
        doNotRedo.push(line.slice(2).trim());
      } else if (line && !line.startsWith("-")) {
        inDnr = false;
      }
    }
  }

  // BLOCKS / BLOCKED_BY — comma-separated topicKeys.
  const parseList = (raw: string): string[] | undefined => {
    if (!raw) return undefined;
    const items = raw.split(",").map(x => x.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  };
  const blocks = parseList(get("BLOCKS"));
  const blockedBy = parseList(get("BLOCKED_BY"));

  return {
    status, task, progress, subtasks, lastAction, next, doNotRedo, verifyBeforeAct,
    autoModel, blockedAtNight, archived, priority,
    executionMode, executionPhase, planFile, feedback,
    visualVerify, visualUrl, visualIterations,
    blocks, blockedBy,
  };
}

// ---------------------------------------------------------------------------
// Director class
// ---------------------------------------------------------------------------

export interface TriggerResult {
  ok: boolean;
  rateLimited?: boolean;
  /** Account name AT the time of spawn — for quota tracking. */
  account?: string;
  /** When to retry. If absent and rateLimited, fallback = now + 4h. */
  resumeAt?: number;
  error?: string;
}

/**
 * Computed by Director per-topic per-phase. Passed to onStaleTopic so
 * the router knows what user-message text to send to Claude and which
 * model to use. PEV phases use different prompts and models; simple
 * mode reduces to the original "[Director auto] Продолжай: NEXT".
 */
export interface TriggerOptions {
  modelOverride: string;
  userMessage: string;
  noticeText: string;       // What appears in Telegram chat ("[Director auto] ...")
  phase?: "planning" | "executing" | "verifying" | "verifying-visual" | "fixing-visual";
}

export interface DirectorConfig {
  topics: TopicsConfig;
  registryPath: string;      // e.g. config/director-registry.json
  dashboardPath: string;     // e.g. config/director-dashboard.json
  tickIntervalMs?: number;   // default 15 * 60 * 1000 (15 min)
  staleThresholdMs?: number; // default 15 * 60 * 1000 (15 min)
  /**
   * Maximum auto-triggers fired per single tick. Default 3 — protects
   * the OAuth account from a triggers-storm right after waking from a
   * router restart that finds dozens of stalled topics. Topics that
   * don't fit go either to next tick or to deferred queue.
   */
  maxTriggersPerTick?: number;
  /** Default model alias for auto-triggers (overridable via CHECKPOINT.md AUTO_MODEL). */
  defaultAutoModel?: string;
  /**
   * Path to the activity events log (append-only JSON). Director writes
   * here after each tick. If unset, no events are recorded.
   */
  eventsPath?: string;
  /** Soft cap on events file size — rotate to .old when exceeded. Default 5 MB. */
  eventsMaxBytes?: number;
  /**
   * Optional async loader for web-toggle overrides. Director calls it at
   * the start of every tick. Returns a Map keyed by topicKey containing
   * fields that override the corresponding CHECKPOINT.md values.
   * If undefined / loader throws — Director uses CHECKPOINT.md as-is.
   */
  loadOverrides?: () => Promise<Map<string, { archived?: boolean; priority?: "high" | "normal" | "low" }>>;
  /**
   * Allowlist of Telegram chat IDs Director is allowed to auto-trigger.
   * Topics outside this list are still scanned (so the dashboard reflects
   * their state) but never auto-pinged. Default: only "и так сойдёт"
   * supergroup. Other groups (popov-otlozhka, content groups, etc.) get
   * read-only treatment.
   */
  allowedChatIds?: string[];
  /**
   * Returns topicKeys whose last runner job ended with timeout or failure
   * within the last N minutes. Director uses this to fast-retry instead
   * of waiting the full cooldown — catches mid-task context breaks.
   */
  getRecentJobFailures?: () => Promise<Set<string>>;
  /**
   * Returns currently-active OAuth slot name. Used to tag deferred
   * entries with the account that hit the rate limit.
   * If not provided, Director uses "default".
   */
  getActiveAccountName?: () => string;
  /**
   * Called when Director picks a topic to trigger. Implementor sends
   * a Telegram notification AND spawns Claude. Returns ok / rateLimited /
   * account / resumeAt so Director can update quota state and the
   * deferred queue.
   *
   * Backward-compat: returning void is treated as ok=true.
   */
  onStaleTopic?: (
    topicKey: string,
    state: TopicState,
    options: TriggerOptions,
  ) => Promise<TriggerResult | void>;
  onDashboardUpdate?: (dashboard: DashboardData) => Promise<void>;
  /**
   * Called once per day at ~08:00 BST with a pre-formatted summary text.
   * The implementor sends it to the designated Telegram topic.
   */
  onMorningSummary?: (summary: string) => Promise<void>;
  /**
   * Optional notification fired at the end of every successful tick. Used
   * by the router's /health endpoint to track lastTickAt and tickCount.
   * Errors thrown here are caught and logged — never crash a tick.
   */
  onTickComplete?: (registry: DirectorRegistry) => void;
  /**
   * Returns the message_id of the last bot message sent in a given topic.
   * Used to attach messageId to subtasks when they transition to done.
   */
  getLastBotMsgId?: (topicKey: string) => number | undefined;
}

export class Director {
  private config: DirectorConfig;
  private timer?: ReturnType<typeof setInterval>;
  private tickIntervalMs: number;
  private staleThresholdMs: number;
  /** Track when we last triggered each topic to avoid spam */
  private lastTriggered = new Map<string, number>();
  /** Minimum interval between triggers for the same topic (2 hours) */
  private readonly TRIGGER_COOLDOWN_MS = 2 * 60 * 60 * 1000;
  /** High-priority topics get a shorter cooldown (30 min). */
  private readonly HIGH_PRIORITY_COOLDOWN_MS = 30 * 60 * 1000;
  /** Default deferred-queue retry window when Anthropic gives no precise reset time. */
  private readonly DEFAULT_QUOTA_COOLDOWN_MS = 4 * 60 * 60 * 1000;
  /**
   * `false` until the first tick after start() finishes. While `false`,
   * we collect state and write the dashboard but DO NOT fire any
   * auto-triggers. Reason: a fresh router process starts with an empty
   * in-memory cooldown map; if we triggered immediately we'd spam every
   * stalled topic on every restart. The persistent cooldown loaded from
   * disk plus this guard together prevent restart-storms.
   */
  private firstTickDone = false;
  /** Per-topic deferred entries (key = topicKey). Persisted in registry. */
  private deferred = new Map<string, DeferredEntry>();
  /** Per-account quota lockouts (key = account slot). Persisted in registry. */
  private accountQuota = new Map<string, AccountQuotaState>();
  /** Web-toggle overrides loaded at start of each tick. Refreshed every tick. */
  private overrides = new Map<string, { archived?: boolean; priority?: "high" | "normal" | "low" }>();
  /** Snapshot of the prior tick's TopicState[] — used for diffing on each scan. */
  private prevTopicState = new Map<string, TopicState>();
  /** Set true by stop() to prevent the recursive setTimeout loop from re-scheduling. */
  private isStopping = false;
  /**
   * Per-topic count of consecutive auto-triggers without manual user
   * activity. Reset to 0 when:
   *   - the user sends a real message in the topic (in handleMessage)
   *   - Cooldown elapses naturally (long idle)
   * Used as anti-runaway cap inside selectTriggerCandidates.
   */
  private consecutiveTriggers = new Map<string, number>();
  /** Pending events from this tick — flushed to disk at end of tick. */
  private pendingEvents: DirectorEvent[] = [];
  /** Epoch ms of last morning summary sent. Persisted in registry. */
  private lastDailySummaryAt = 0;
  /**
   * Per-topic last manual user message timestamp. Bumped by router via
   * recordUserMessage on every user-typed message. Topics with values
   * older than AUTO_ARCHIVE_DAYS_MS get auto-archived (skipped from
   * auto-trigger, not deleted). Persisted in registry.
   *
   * Topics without an entry are treated as "fresh" — never auto-archived
   * until they accumulate at least one manual message timestamp. This
   * prevents cold-archiving topics on first Director boot.
   */
  private lastManualUserAt = new Map<string, number>();
  /** Auto-archive threshold: 30 days of no manual user activity. */
  private readonly AUTO_ARCHIVE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  /**
   * Per-topic count of consecutive auto-triggers that did NOT advance
   * CHECKPOINT.md mtime. Used to escalate cooldown for stuck topics:
   * cooldown = base * min(2^failedCount, 12), capped at 24h.
   * Reset to 0 when a tick observes lastActivityMs > lastTriggered.
   * Persisted in registry.
   */
  private failedCount = new Map<string, number>();
  /** Hard cap on adaptive cooldown. */
  private readonly ADAPTIVE_COOLDOWN_CAP_MS = 24 * 60 * 60 * 1000;
  /**
   * Per-topic per-day trigger counter. Keyed by topicKey. Resets on
   * BST date rollover. Used by the daily trigger budget — topics that
   * hit their cap (default 3 / high-priority 6) are skipped until
   * midnight BST. Persisted in registry.
   */
  private dailyTriggerCount = new Map<string, { date: string; count: number }>();
  /** Default daily trigger cap per topic (normal priority). */
  private readonly DAILY_BUDGET_NORMAL = 3;
  /** Daily trigger cap for high-priority topics. */
  private readonly DAILY_BUDGET_HIGH = 6;

  constructor(config: DirectorConfig) {
    this.config = config;
    this.tickIntervalMs = config.tickIntervalMs ?? 15 * 60 * 1000;
    this.staleThresholdMs = config.staleThresholdMs ?? 15 * 60 * 1000;
  }

  start(): void {
    if (this.timer) return;
    this.isStopping = false;
    // Restore cooldown state from previous run before the first tick.
    this.loadTriggerState();
    // Self-scheduling loop instead of setInterval. setInterval fires
    // every N ms regardless of whether the previous tick has finished,
    // which causes overlapping ticks to clobber each other's writes
    // (Gemini code review #1, 2026-05-02). With chain-on-progress + PEV,
    // a tick can take 5-15 min, so overlap with 15-min interval is real.
    // Recursive setTimeout schedules the NEXT tick only after current one
    // finishes, fully serializing tick execution.
    const loop = async (): Promise<void> => {
      if (this.isStopping) return;
      try {
        await this.tick();
      } catch (err) {
        console.error("[Director] Unhandled error in tick:", err);
      } finally {
        if (!this.isStopping) {
          this.timer = setTimeout(loop, this.tickIntervalMs) as unknown as ReturnType<typeof setInterval>;
        }
      }
    };
    void loop();
    console.log(`[Director] Started (tick every ${Math.round(this.tickIntervalMs / 60000)} min)`);
  }

  /**
   * Read previous registry from disk and rehydrate the lastTriggered
   * map, deferred queue, and per-account quota state. Silent if the
   * file is missing or malformed — first run is fine.
   */
  private loadTriggerState(): void {
    try {
      if (!existsSync(this.config.registryPath)) return;
      const raw = readFileSync(this.config.registryPath, "utf-8");
      const data = JSON.parse(raw) as Partial<DirectorRegistry>;

      // 1) Cooldowns
      if (data.lastTriggered) {
        let loaded = 0;
        for (const [k, v] of Object.entries(data.lastTriggered)) {
          if (typeof v === "number" && Number.isFinite(v)) {
            this.lastTriggered.set(k, v);
            loaded++;
          }
        }
        if (loaded > 0) {
          console.log(`[Director] Loaded ${loaded} cooldown timestamps from registry`);
        }
      }

      // 2) Deferred queue
      if (Array.isArray(data.deferredTopics)) {
        for (const entry of data.deferredTopics) {
          if (entry && typeof entry.topicKey === "string") {
            this.deferred.set(entry.topicKey, entry);
          }
        }
        if (this.deferred.size > 0) {
          console.log(`[Director] Loaded ${this.deferred.size} deferred topic(s) from registry`);
        }
      }

      // 3) Last daily summary timestamp
      if (typeof data.lastDailySummaryAt === "number" && Number.isFinite(data.lastDailySummaryAt)) {
        this.lastDailySummaryAt = data.lastDailySummaryAt;
        console.log(
          `[Director] Loaded lastDailySummaryAt: ${new Date(data.lastDailySummaryAt).toISOString()}`
        );
      }

      // 4) Account quota state
      if (data.accountQuota && typeof data.accountQuota === "object") {
        for (const [account, q] of Object.entries(data.accountQuota)) {
          if (q && typeof (q as AccountQuotaState).resumeAt === "number") {
            this.accountQuota.set(account, q as AccountQuotaState);
          }
        }
        if (this.accountQuota.size > 0) {
          const summary = [...this.accountQuota.entries()]
            .map(([a, q]) => `${a} until ${new Date(q.resumeAt).toISOString().slice(11, 16)}`)
            .join(", ");
          console.log(`[Director] Loaded account quota state: ${summary}`);
        }
      }

      // 5) Last manual user message per topic (auto-archive support)
      if (data.lastManualUserAt && typeof data.lastManualUserAt === "object") {
        let loaded = 0;
        for (const [k, v] of Object.entries(data.lastManualUserAt)) {
          if (typeof v === "number" && Number.isFinite(v)) {
            this.lastManualUserAt.set(k, v);
            loaded++;
          }
        }
        if (loaded > 0) {
          console.log(`[Director] Loaded ${loaded} lastManualUserAt entries`);
        }
      }

      // 6) Per-topic adaptive-cooldown failure counter
      if (data.failedCount && typeof data.failedCount === "object") {
        for (const [k, v] of Object.entries(data.failedCount)) {
          if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            this.failedCount.set(k, v);
          }
        }
        if (this.failedCount.size > 0) {
          console.log(`[Director] Loaded ${this.failedCount.size} failedCount entries`);
        }
      }

      // 7) Per-topic daily trigger counter (BST-day-keyed)
      if (data.dailyTriggerCount && typeof data.dailyTriggerCount === "object") {
        for (const [k, v] of Object.entries(data.dailyTriggerCount)) {
          if (v && typeof v.date === "string" && typeof v.count === "number") {
            this.dailyTriggerCount.set(k, { date: v.date, count: v.count });
          }
        }
      }
    } catch (err) {
      console.error("[Director] Failed to load trigger state:", (err as Error).message);
    }
  }

  /**
   * Public: bump the last-manual-user-message timestamp for a topic.
   * Called by Router.handleMessage on every user-authored message that
   * passes auth/pause/mention gates. Auto-archive policy uses these
   * timestamps to skip topics idle > 30 days.
   */
  recordUserMessage(topicKey: string, ms = Date.now()): void {
    this.lastManualUserAt.set(topicKey, ms);
    // Reset consecutiveTriggers on any real activity — the user is engaged
    // again, the runaway cap should not punish chain-on-progress that
    // follows from a manual continuation.
    this.consecutiveTriggers.set(topicKey, 0);
    // Adaptive cooldown also resets on manual activity: the user's
    // intervention is a meaningful state change. If the topic was
    // stuck in a 24h escalated cooldown, this brings it back to base.
    this.failedCount.set(topicKey, 0);
  }

  // ─── Selection / trigger pipeline ─────────────────────────────────────

  /**
   * Pick stalled topics that are eligible for auto-trigger this tick,
   * sorted by recency of last activity (most recent first — i.e. the
   * topics the user worked on today come first).
   *
   * Filters applied (in order):
   *   - status = IN_PROGRESS
   *   - NEXT non-empty and != "await user input"
   *   - stalled longer than threshold
   *   - not in AUTO_TRIGGER_BLACKLIST (e.g. Director itself)
   *   - cooldown not active (≥ 2h since last auto-trigger)
   *   - night filter: at 22:00–08:00 UK, communication-category
   *     topics are skipped unless CHECKPOINT.md has BLOCKED_AT_NIGHT: false
   *   - already in deferred queue → skip (handled by processDeferredQueue)
   */
  /** Fast-retry cooldown for topics whose last runner job timed out / failed. */
  private readonly FAST_RETRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

  private selectTriggerCandidates(
    states: TopicState[], now: number, recentFailures?: Set<string>,
  ): TopicState[] {
    const isNight = this.isNightUk(now);
    const allowedChatIds = this.config.allowedChatIds;
    const out: TopicState[] = [];
    // For BLOCKED_BY dependency check
    const stateMap = new Map(states.map(x => [x.topicKey, x]));

    for (const s of states) {
      // Fast-retry override: if the runner reports a recent timeout/failure
      // for this topic, the bot WAS actively working — bypass status and
      // await-user-input filters. The bot likely didn't update CHECKPOINT
      // before it died, so STATUS/NEXT are stale.
      //
      // Fallback: if runner lost job history (restart), detect abandoned
      // sessions via lastManualUserAt — the user sent a message recently
      // (< 2h ago) but the topic is AWAITING_USER with no running job.
      // This means the bot started, then crashed without updating CHECKPOINT.
      const ABANDONED_SESSION_MS = 2 * 60 * 60 * 1000; // 2 hours
      const lastManualMsg = this.lastManualUserAt.get(s.topicKey);
      const isAbandonedSession =
        !recentFailures?.has(s.topicKey) &&
        s.status === "AWAITING_USER" &&
        lastManualMsg !== undefined &&
        (now - lastManualMsg) < ABANDONED_SESSION_MS &&
        (now - lastManualMsg) > 10 * 60 * 1000; // at least 10 min since message (give bot time to work)
      const isFastRetryCandidate = (recentFailures?.has(s.topicKey) ?? false) || isAbandonedSession;

      // Never re-trigger COMPLETED topics, even on fast-retry.
      if (s.status === "COMPLETED") continue;

      if (!isFastRetryCandidate) {
        if (s.status !== "IN_PROGRESS") continue;
        if (!s.next) continue;
        // In PEV mode mid-cycle, NEXT may carry sub-task text but Director
        // dispatches by phase, not by NEXT. Only respect await-user phrases
        // when NOT in an active PEV phase (executionPhase set).
        const inActivePev = s.executionMode === "pev" && !!s.executionPhase;
        // Visual phases are also active PEV phases.
        const inVisualPhase = s.executionPhase === "verifying-visual" || s.executionPhase === "fixing-visual";
        const nextLow = s.next.toLowerCase().trim();
        if (!inActivePev && !inVisualPhase) {
          // Match "await user input" anywhere in NEXT (handles "await user input | some info")
          if (nextLow.includes("await user input")) continue;
          if (/(?:^|\|)\s*(ждём|ждем|жду|ожида|дожида|дождат|дождё|дожда|wait\b|waiting\b|awaiting\b)/i.test(s.next)) continue;
        }
      }
      if (!isFastRetryCandidate && s.stalledMinutes <= this.staleThresholdMs / 60000) continue;
      if (AUTO_TRIGGER_BLACKLIST.has(s.name)) continue;

      // Group allowlist: topicKey shape is "<chatId>:<threadId|general>".
      // If allowlist is configured and chatId is not on it — never trigger.
      // Topic still appears on the dashboard, just no auto-spawn.
      if (allowedChatIds && allowedChatIds.length > 0) {
        const chatIdPart = s.topicKey.split(":")[0];
        if (!allowedChatIds.includes(chatIdPart)) continue;
      }

      // Archived topics: visible on dashboard but no auto-trigger.
      // Set ARCHIVED: true in CHECKPOINT.md to pause work in a topic.
      // Also check topic name prefix "Архив:" as a fallback — topics
      // renamed to "Архив: ..." should never be auto-triggered even if
      // CHECKPOINT.md doesn't have ARCHIVED: true yet.
      if (s.archived) continue;
      if (s.name.startsWith("Архив:") || s.name.startsWith("Архив ")) continue;

      // Auto-archive: topics with no manual user message for > 30 days.
      // Topics that have NEVER had a recorded manual message timestamp
      // are treated as fresh (don't auto-archive) — they may be brand
      // new or pre-date the lastManualUserAt mechanism.
      const lastManual = this.lastManualUserAt.get(s.topicKey);
      if (lastManual !== undefined && now - lastManual > this.AUTO_ARCHIVE_DAYS_MS) {
        // Mark on the in-memory state so dashboard reflects the archived
        // status even though CHECKPOINT.md still says ARCHIVED: false.
        // Don't write to disk — the user can un-archive by sending any
        // message into the topic, which bumps lastManualUserAt and
        // re-enables auto-trigger on the next tick.
        s.archived = true;
        continue;
      }

      // BLOCKED_BY dependency: skip if any blocker isn't COMPLETED.
      // Blocker can reference a topicKey that doesn't exist (yet) — we
      // treat unknown blockers as "still pending" to be safe (typo
      // protection: if the user writes a wrong topicKey, the dependent
      // never auto-fires, which is loud and obvious in the dashboard).
      if (s.blockedBy && s.blockedBy.length > 0) {
        const pending = s.blockedBy.filter(bk => {
          const blocker = stateMap.get(bk);
          return !blocker || blocker.status !== "COMPLETED";
        });
        if (pending.length > 0) {
          // Keep state.archived false here — it's not archived, it's
          // blocked. The dashboard distinguishes via blockedBy field.
          continue;
        }
      }

      // Daily trigger budget per topic. Hard cap on auto-triggers per
      // BST day. Without this, a stuck topic can burn 24 sonnet calls
      // overnight chasing the 24h adaptive cooldown ceiling.
      const today = this.bstDateStr(now);
      const budgetEntry = this.dailyTriggerCount.get(s.topicKey);
      const usedToday = budgetEntry?.date === today ? budgetEntry.count : 0;
      const dailyCap = s.priority === "high" ? this.DAILY_BUDGET_HIGH : this.DAILY_BUDGET_NORMAL;
      if (usedToday >= dailyCap) {
        // Cap reached. Director defers until midnight BST (rollover
        // resets the counter). Skip silently — emitting an event every
        // 15 min would spam the activity log.
        continue;
      }

      const lastTrigger = this.lastTriggered.get(s.topicKey) ?? 0;
      // Chain-on-progress. If the topic's CHECKPOINT.md was modified
      // AFTER our last trigger, treat it as real progress and bypass
      // the standard cooldown. Anti-runaway: cap consecutive auto-runs
      // (no manual user activity in between) — see consecutiveTriggers.
      const progressed = lastTrigger > 0 && s.lastActivityMs > lastTrigger;
      const consec = this.consecutiveTriggers.get(s.topicKey) ?? 0;
      const RUNAWAY_CAP = s.priority === "high" ? 15 : 5;
      // Adaptive cooldown: each consecutive trigger that didn't move
      // CHECKPOINT.md mtime doubles the cooldown. Reset on progress.
      // Cap at 24h so a truly stuck topic doesn't burn 24 sonnet calls.
      if (progressed && this.failedCount.get(s.topicKey)) {
        this.failedCount.set(s.topicKey, 0);
      }
      const failedN = this.failedCount.get(s.topicKey) ?? 0;
      let reason: string;
      if (progressed && consec < RUNAWAY_CAP) {
        // Allow re-trigger immediately. Skipping cooldown intentional.
        reason = "chain-on-progress";
      } else if (recentFailures?.has(s.topicKey) || isAbandonedSession) {
        // Last runner job for this topic timed out, failed, or went silent,
        // OR the user sent a message recently but the bot died without updating
        // CHECKPOINT (abandoned session fallback).
        if (now - lastTrigger <= this.FAST_RETRY_COOLDOWN_MS) continue;
        reason = isAbandonedSession ? "abandoned-session" : "fast-retry";
      } else {
        const baseCooldown = s.priority === "high" ? this.HIGH_PRIORITY_COOLDOWN_MS : this.TRIGGER_COOLDOWN_MS;
        const multiplier = Math.min(Math.pow(2, failedN), 12);
        const cooldown = Math.min(baseCooldown * multiplier, this.ADAPTIVE_COOLDOWN_CAP_MS);
        if (now - lastTrigger <= cooldown) continue;
        reason = `stale-${Math.round(s.stalledMinutes)}m`;
        if (failedN > 0) reason += `/no-progress=${failedN}`;
      }
      s.triggerReason = reason;

      if (this.deferred.has(s.topicKey)) continue;

      // Night filter: communication-category default-blocked at night,
      // overridable per-topic via BLOCKED_AT_NIGHT in CHECKPOINT.md.
      if (isNight) {
        const explicit = s.blockedAtNight;
        const blocked =
          explicit === true ? true :
          explicit === false ? false :
          s.category === "communication";
        if (blocked) continue;
      }

      out.push(s);
    }

    // Sort: priority desc (high → normal → low), then most recent activity first.
    // High-priority topics get triggered first within the per-tick cap.
    // Within same priority, freshly-touched topics (where the user worked
    // most recently) come first.
    const priorityWeight = (p?: string): number => {
      if (p === "high") return 2;
      if (p === "low") return 0;
      return 1; // normal / unset
    };
    out.sort((a, b) => {
      const pw = priorityWeight(b.priority) - priorityWeight(a.priority);
      if (pw !== 0) return pw;
      return b.lastActivityMs - a.lastActivityMs;
    });
    return out;
  }

  /**
   * Fire the user-supplied onStaleTopic callback for one topic.
   * Returns true if the trigger ran (even if it later turned out
   * rate-limited; that's accounted for by quota state).
   */
  private async fireTrigger(state: TopicState, account: string, now: number): Promise<boolean> {
    const cb = this.config.onStaleTopic;
    if (!cb) return false;

    const opts = this.buildTriggerOptions(state);

    // Visual-fix iteration management: Director owns the counter.
    // When dispatching fixing-visual, increment VISUAL_ITERATIONS in
    // CHECKPOINT.md so the cap is enforced across retries.
    if (opts.phase === "fixing-visual") {
      const newIter = (state.visualIterations ?? 0) + 1;
      const VISUAL_CAP = 3;
      if (newIter > VISUAL_CAP) {
        // Cap exceeded — force AWAITING_USER instead of triggering.
        try {
          const cpPath = join(state.project, "CHECKPOINT.md");
          if (existsSync(cpPath)) {
            let cp = readFileSync(cpPath, "utf-8");
            cp = cp.replace(/^EXECUTION_PHASE:.*/m, "")
                   .replace(/^VISUAL_ITERATIONS:.*/m, "")
                   .replace(/^STATUS:.*/m, "STATUS: AWAITING_USER")
                   .replace(/^NEXT:.*/m, `NEXT: Visual issues не решены за ${VISUAL_CAP} итераций, нужна помощь пользователя`);
            writeFileSync(cpPath, cp, "utf-8");
            console.log(`[Director] Visual cap exceeded for ${state.name} — set AWAITING_USER`);
          }
        } catch (err) {
          console.error(`[Director] Failed to update visual cap for ${state.name}:`, (err as Error).message);
        }
        return false;
      }
      // Increment counter in CHECKPOINT.md.
      try {
        const cpPath = join(state.project, "CHECKPOINT.md");
        if (existsSync(cpPath)) {
          let cp = readFileSync(cpPath, "utf-8");
          if (/^VISUAL_ITERATIONS:/m.test(cp)) {
            cp = cp.replace(/^VISUAL_ITERATIONS:.*/m, `VISUAL_ITERATIONS: ${newIter}`);
          } else {
            cp = cp.replace(/^EXECUTION_PHASE:.*/m, `EXECUTION_PHASE: fixing-visual\nVISUAL_ITERATIONS: ${newIter}`);
          }
          writeFileSync(cpPath, cp, "utf-8");
        }
      } catch (err) {
        console.warn(`[Director] Failed to increment VISUAL_ITERATIONS for ${state.name}:`, (err as Error).message);
      }
    }

    // Compose the per-event detail with the trigger reason so a future reader
    // (and the hub UI) can tell why this fired: stale-mtime, chain-on-
    // progress, fast-retry, pev:<phase>, orphan-recovery, etc.
    const reasonTag = state.triggerReason
      ?? (opts.phase ? `pev:${opts.phase}` : "unknown");
    const detailWithReason =
      `reason=${reasonTag} / model=${opts.modelOverride}` +
      (opts.phase ? ` / phase=${opts.phase}` : "");

    // Emit trigger_started BEFORE awaiting the spawn so the hub Activity
    // tab can show "spawning..." within seconds, not minutes. The matching
    // trigger_success / _failed / _rate_limited event is emitted at the
    // bottom of this method after Claude returns.
    this.recordEvent({
      ts: new Date(now).toISOString(), topicKey: state.topicKey,
      name: state.name, category: state.category,
      kind: "trigger_started",
      detail: detailWithReason,
    });

    let result: TriggerResult | void;
    try {
      result = await cb(state.topicKey, state, opts);
    } catch (err) {
      console.error(`[Director] onStaleTopic threw for ${state.topicKey}:`, (err as Error).message);
      return false;
    }

    // void return = treat as success (back-compat with older callbacks).
    const ok = result == null ? true : result.ok;
    const rateLimited = result != null && result.rateLimited === true;

    if (rateLimited) {
      const resumeAt = result?.resumeAt ?? now + this.DEFAULT_QUOTA_COOLDOWN_MS;
      const acct = result?.account ?? account;
      this.accountQuota.set(acct, {
        exhaustedAt: now,
        resumeAt,
        reason: result?.error?.slice(0, 200) || "rate_limit",
      });
      this.enqueueDeferred(state, acct, "rate_limit", resumeAt);
      this.recordEvent({
        ts: new Date(now).toISOString(), topicKey: state.topicKey,
        name: state.name, category: state.category,
        kind: "trigger_rate_limited", detail: acct,
      });
      console.warn(
        `[Director] Account "${acct}" rate-limited; pausing all auto-triggers ` +
        `until ${new Date(resumeAt).toISOString()}. Topic ${state.name} deferred.`,
      );
      return true;
    }

    if (ok) {
      // Successful trigger — full 2h cooldown unless chain-on-progress kicks in.
      this.lastTriggered.set(state.topicKey, now);
      this.consecutiveTriggers.set(
        state.topicKey,
        (this.consecutiveTriggers.get(state.topicKey) ?? 0) + 1,
      );
      // Pre-emptively count as a "no-progress" trigger. The next tick's
      // selectTriggerCandidates will reset this to 0 if mtime advances.
      // If it stays incremented, cooldown doubles next time.
      this.failedCount.set(
        state.topicKey,
        (this.failedCount.get(state.topicKey) ?? 0) + 1,
      );
      // Bump the daily trigger budget counter (BST date keyed).
      const today = this.bstDateStr(now);
      const cur = this.dailyTriggerCount.get(state.topicKey);
      if (cur && cur.date === today) {
        this.dailyTriggerCount.set(state.topicKey, { date: today, count: cur.count + 1 });
      } else {
        this.dailyTriggerCount.set(state.topicKey, { date: today, count: 1 });
      }
      this.recordEvent({
        ts: new Date(now).toISOString(), topicKey: state.topicKey,
        name: state.name, category: state.category,
        kind: "trigger_success",
        detail: detailWithReason,
      });
    } else {
      // Failed trigger (runner timeout, transport error, etc.) — apply
      // a SHORTER cooldown so transient infrastructure issues don't trap
      // a topic in 2h limbo, but Director also doesn't retry the same
      // topic every 15 min if the cause is persistent. We push
      // lastTriggered back 90 min so the effective cooldown is 30 min.
      const FAILED_COOLDOWN_MS = 30 * 60 * 1000;
      const fakeStamp = now - (this.TRIGGER_COOLDOWN_MS - FAILED_COOLDOWN_MS);
      this.lastTriggered.set(state.topicKey, fakeStamp);
      this.recordEvent({
        ts: new Date(now).toISOString(), topicKey: state.topicKey,
        name: state.name, category: state.category,
        kind: "trigger_failed",
        detail: `reason=${reasonTag} / err=${(result?.error || "unknown").slice(0, 160)}`,
      });
      console.warn(
        `[Director] Trigger failed for ${state.name}; cooling down 30 min ` +
        `(error: ${(result?.error || "unknown").slice(0, 120)})`,
      );
    }
    return ok;
  }

  /**
   * Compute the user-message text and model for a given trigger.
   *
   * Simple mode (default):
   *   "[Director auto] Продолжай с того, на чём остановился: <NEXT>"
   *   model = AUTO_MODEL || defaultAutoModel || "sonnet"
   *
   * PEV mode (EXECUTION_MODE: pev in CHECKPOINT.md): three-phase pipeline.
   * Director picks the prompt + model for the CURRENT phase based on
   * EXECUTION_PHASE in CHECKPOINT.md. Each phase ends with Claude updating
   * CHECKPOINT.md to advance to the next phase. Director's chain-on-progress
   * fix means progress is detected on the very next tick and the chain
   * continues automatically.
   */
  private buildTriggerOptions(state: TopicState): TriggerOptions {
    const isPev = state.executionMode === "pev";
    // Compact reason tag for the Telegram notice. Hidden inside square
    // brackets so it doesn't compete with the actual NEXT text. Helps
    // the user scan auto-triggers and tell at a glance which were reflex
    // (chain-on-progress) vs rare (fast-retry / stale).
    const reasonTag = state.triggerReason ?? "auto";
    if (!isPev) {
      const model = state.autoModel ?? this.config.defaultAutoModel ?? "sonnet";
      // Fast-retry after timeout: the previous session crashed/timed out.
      // The bot may not have updated CHECKPOINT, so NEXT could be stale
      // (e.g. "await user input" even though work was in progress).
      // Use a recovery prompt instead of the standard "continue" prompt.
      const isFastRetry = state.triggerReason === "fast-retry" || state.triggerReason === "abandoned-session";
      const nextText = state.next || "(не указан)";
      const userMessage = isFastRetry
        ? [
            `[Director auto / fast-retry] Предыдущая сессия прервалась (timeout/crash).`,
            ``,
            `CHECKPOINT.md мог не обновиться. Прочитай его, проверь реальное состояние проекта:`,
            `- git log --oneline -5`,
            `- проверь файлы, которые должны были измениться`,
            ``,
            `Затем продолжи работу с того места, где прервалось.`,
            `Если NEXT устарел (написано "await user input", но есть незакрытые задачи) — обнови NEXT и работай.`,
            ``,
            `Текущий NEXT в CHECKPOINT: ${nextText}`,
            ``,
            `ВАЖНО: после завершения текущей задачи — проверь BACKLOG / оставшиеся подзадачи.`,
            `Ставь "NEXT: await user input" ТОЛЬКО если ВСЕ задачи выполнены и нужно решение пользователя.`,
            `НЕ понижай PRIORITY — им управляет Director.`,
          ].join("\n")
        : [
            `[Director auto] Продолжай с того, на чём остановился: ${nextText}`,
            ``,
            `ВАЖНО: после завершения текущей задачи — проверь BACKLOG / оставшиеся подзадачи в CHECKPOINT.md.`,
            `Если есть ещё задачи — бери следующую и пиши её в NEXT.`,
            `Ставь "NEXT: await user input" ТОЛЬКО если ВСЕ задачи выполнены и нужно решение пользователя.`,
            `НЕ понижай PRIORITY — им управляет Director.`,
          ].join("\n");
      return {
        modelOverride: model,
        noticeText: `[Director / ${reasonTag}] Продолжаю: ${nextText}`,
        userMessage,
      };
    }

    // Visual phases (can appear outside the planning/executing/verifying flow).
    if (isPev && state.executionPhase === "verifying-visual") {
      return {
        modelOverride: "sonnet",
        phase: "verifying-visual",
        noticeText: `[Director PEV / visual-check / ${reasonTag}] ${state.visualUrl ?? state.next}`,
        userMessage: this.pevVisualVerifyPrompt(state),
      };
    }
    if (isPev && state.executionPhase === "fixing-visual") {
      return {
        modelOverride: "opus",
        phase: "fixing-visual",
        noticeText: `[Director PEV / visual-fix / ${reasonTag}] итерация ${state.visualIterations ?? 1}/3`,
        userMessage: this.pevVisualFixPrompt(state),
      };
    }

    // PEV. If no phase yet → start with planning.
    const phase = state.executionPhase ?? "planning";
    if (phase === "planning") {
      return {
        modelOverride: "opus",
        phase,
        noticeText: `[Director PEV / план / ${reasonTag}] ${state.next}`,
        userMessage: this.pevPlanningPrompt(state),
      };
    }
    if (phase === "executing") {
      return {
        modelOverride: state.autoModel ?? "sonnet",
        phase,
        noticeText: `[Director PEV / выполнение / ${reasonTag}] по плану ${state.planFile ?? "(не указан)"}`,
        userMessage: this.pevExecutingPrompt(state),
      };
    }
    // verifying
    return {
      modelOverride: "opus",
      phase: "verifying",
      noticeText: `[Director PEV / проверка / ${reasonTag}] по плану ${state.planFile ?? "(не указан)"}`,
      userMessage: this.pevVerifyingPrompt(state),
    };
  }

  private pevPlanningPrompt(state: TopicState): string {
    return [
      `[Director PEV / phase=planning]`,
      ``,
      `Задача (NEXT в CHECKPOINT.md): ${state.next}`,
      ``,
      `Цель этой фазы — НАПИСАТЬ ПЛАН, а не выполнять работу.`,
      ``,
      `Сделай:`,
      `1. Прочитай CHECKPOINT.md в корне проекта (DO_NOT_REDO, текущий прогресс).`,
      `2. Прочитай SOUL.md, topic-memory.md, main-memory.md если есть.`,
      `3. Изучи code-base в части, которая касается NEXT.`,
      `4. Создай файл .director/plans/${state.topicKey.split(":")[1] ?? "x"}-$(date +%Y%m%d-%H%M).md с разделами:`,
      `   - Acceptance criteria — что значит "готово"`,
      `   - Шаги (3-7) — атомарные, тестируемые`,
      `   - Риски и edge cases`,
      `   - Verify-команды для каждого шага`,
      `   - Rollback plan`,
      `5. Обнови CHECKPOINT.md в КОРНЕ проекта:`,
      `   EXECUTION_PHASE: executing`,
      `   PLAN_FILE: .director/plans/<имя файла из шага 4>`,
      ``,
      `НЕ ДЕЛАЙ:`,
      `- Не пиши код по этой задаче (только план).`,
      `- Не запускай миграции / деплои.`,
      `- Не меняй файлов кроме .director/plans/ и CHECKPOINT.md.`,
      `- Не отмечай подзадачу done в SUBTASKS — это сделает фаза executing.`,
    ].join("\n");
  }

  private pevExecutingPrompt(state: TopicState): string {
    const fb = state.feedback
      ? [
          ``,
          `Фидбэк от прошлой verify-фазы (доделать):`,
          state.feedback,
          ``,
        ].join("\n")
      : "";
    return [
      `[Director PEV / phase=executing]`,
      ``,
      `План: ${state.planFile ?? "(не указан — попроси пересоздать)"}`,
      fb,
      `Выполни план шаг за шагом:`,
      `1. Прочитай весь план из ${state.planFile}.`,
      `2. Для каждого шага сделай работу.`,
      `3. После каждого шага запусти verify-команду из плана.`,
      `4. Если verify прошёл — двигайся к следующему.`,
      `5. Если verify упал — попробуй починить или останови с STATUS: BLOCKED + пояснение.`,
      ``,
      `В конце:`,
      `- git add ; git commit -m "..." (один коммит на всю задачу)`,
      `- Краткий отчёт (что сделано, что не сделано).`,
      `- Обнови CHECKPOINT.md:`,
      `    EXECUTION_PHASE: verifying`,
      `    Не сбрасывай PLAN_FILE.`,
      `    Если что-то не получилось — добавь FEEDBACK: <причина>.`,
    ].join("\n");
  }

  private pevVerifyingPrompt(state: TopicState): string {
    const hasVisual = state.visualVerify && state.visualUrl;
    const approvedBlock = hasVisual
      ? [
          `- APPROVED → обнови CHECKPOINT.md:`,
          `    EXECUTION_PHASE: verifying-visual`,
          `    VISUAL_ITERATIONS: 0`,
          `    (Не удаляй PLAN_FILE и VISUAL_URL — нужны для visual-check.)`,
        ]
      : [
          `- APPROVED → обнови CHECKPOINT.md:`,
          `    Если задача целиком закрыта: STATUS: COMPLETED, NEXT: await user input`,
          `    Если есть следующая подзадача: STATUS: IN_PROGRESS, NEXT: <она>`,
          `    Удали EXECUTION_PHASE и PLAN_FILE.`,
        ];

    return [
      `[Director PEV / phase=verifying]`,
      ``,
      `План: ${state.planFile ?? "(не указан)"}`,
      `Sonnet выполнил его. Твоя задача — независимая проверка.`,
      ``,
      `1. Прочитай весь план из ${state.planFile}.`,
      `2. Прочитай отчёт Sonnet'а (его последний ответ в этом топике).`,
      `3. \`git log -10 --oneline\` и \`git diff HEAD~1\` чтобы увидеть фактические изменения.`,
      `4. Запусти все verify-команды из плана СВОИМИ руками (не доверяй Sonnet'у на слово).`,
      `5. Проверь acceptance criteria.`,
      ``,
      `Вердикт:`,
      ...approvedBlock,
      `- NEEDS_FIX → обнови CHECKPOINT.md:`,
      `    STATUS: IN_PROGRESS`,
      `    EXECUTION_PHASE: executing`,
      `    PLAN_FILE: <тот же>`,
      `    FEEDBACK: <конкретно что Sonnet'у доделать или поправить>`,
      `- ROLLBACK → \`git revert HEAD --no-edit\`, потом обнови CHECKPOINT.md:`,
      `    STATUS: AWAITING_USER`,
      `    NEXT: await user input`,
      `    Добавь ROLLBACK_REASON: <короткое пояснение>`,
      `    Удали EXECUTION_PHASE и PLAN_FILE.`,
    ].join("\n");
  }

  /**
   * Sonnet opens VISUAL_URL via Playwright, inspects the page visually,
   * and writes any rendering / layout / UX issues to VISUAL_ISSUES.md.
   */
  private pevVisualVerifyPrompt(state: TopicState): string {
    const url = state.visualUrl ?? "(URL не указан)";
    const iteration = state.visualIterations ?? 0;
    return [
      `[Director PEV / phase=verifying-visual] (итерация ${iteration}/3)`,
      ``,
      `Задача: визуальная проверка результата в браузере.`,
      `URL: ${url}`,
      ``,
      `Инструкция:`,
      `1. Открой ${url} через Playwright MCP (browser_navigate).`,
      `2. Сделай browser_snapshot — прочитай accessibility tree.`,
      `3. Сделай browser_take_screenshot — визуально проверь результат.`,
      `4. Проверь:`,
      `   - Страница загружается без ошибок (проверь browser_console_messages)`,
      `   - Элементы на месте, нет broken layout`,
      `   - Текст читаемый, шрифты загружены`,
      `   - Нет JS-ошибок в консоли`,
      `   - Мобильная верстка: browser_resize до 375x812, snapshot + screenshot`,
      `   - Ссылки/кнопки кликабельны (проверь выборочно)`,
      `5. Если нашёл проблемы — запиши их в VISUAL_ISSUES.md в корне проекта:`,
      `   Каждая проблема = блок: описание + серьёзность (critical/major/minor) + как воспроизвести.`,
      `6. Обнови CHECKPOINT.md:`,
      `   - Если проблем НЕТ:`,
      `       Если задача целиком закрыта: STATUS: COMPLETED, NEXT: await user input`,
      `       Если есть следующая подзадача: STATUS: IN_PROGRESS, NEXT: <она>`,
      `       Удали EXECUTION_PHASE, PLAN_FILE, VISUAL_ITERATIONS.`,
      `   - Если проблемы ЕСТЬ:`,
      `       EXECUTION_PHASE: fixing-visual`,
      `       FEEDBACK: краткий перечень найденных проблем`,
      `       (НЕ меняй VISUAL_ITERATIONS — Director сам инкрементирует.)`,
      ``,
      `НЕ ДЕЛАЙ:`,
      `- Не исправляй код сам — только диагностика.`,
      `- Не меняй файлы кроме VISUAL_ISSUES.md и CHECKPOINT.md.`,
    ].join("\n");
  }

  /**
   * Opus reads VISUAL_ISSUES.md and fixes the found problems.
   * After fixing, sets phase back to verifying-visual for re-check.
   */
  private pevVisualFixPrompt(state: TopicState): string {
    const iteration = state.visualIterations ?? 0;
    const cap = 3;
    return [
      `[Director PEV / phase=fixing-visual] (итерация ${iteration}/${cap})`,
      ``,
      `Sonnet проверил страницу визуально и нашёл проблемы.`,
      ``,
      `1. Прочитай VISUAL_ISSUES.md в корне проекта.`,
      `2. Прочитай FEEDBACK в CHECKPOINT.md для краткого описания.`,
      `3. Исправь каждую проблему:`,
      `   - critical — обязательно`,
      `   - major — обязательно`,
      `   - minor — по возможности`,
      `4. После исправления: git add && git commit.`,
      `5. Если задача требует деплоя — задеплой (если есть скрипт деплоя).`,
      `6. Обнови CHECKPOINT.md:`,
      `   EXECUTION_PHASE: verifying-visual`,
      `   FEEDBACK: (удали или обнови)`,
      `   НЕ МЕНЯЙ VISUAL_ITERATIONS.`,
      ``,
      `Если итерация ${iteration} >= ${cap} и проблемы всё ещё есть:`,
      `   STATUS: AWAITING_USER`,
      `   NEXT: Visual issues не решены за ${cap} итерации, нужна помощь пользователя`,
      `   Удали EXECUTION_PHASE.`,
    ].join("\n");
  }

  /** Buffer one event in memory; flushed at end of tick by flushEvents(). */
  private recordEvent(ev: DirectorEvent): void {
    this.pendingEvents.push(ev);
  }

  /**
   * Append pendingEvents to the on-disk events file, rotate if too big,
   * then clear the buffer. Called once at end of each tick after the
   * registry/dashboard have been written.
   */
  private flushEvents(): void {
    if (!this.config.eventsPath) { this.pendingEvents = []; return; }
    if (this.pendingEvents.length === 0) return;
    const path = this.config.eventsPath;
    const cap = this.config.eventsMaxBytes ?? 5 * 1024 * 1024;
    try {
      // Rotate if oversized.
      if (existsSync(path) && statSync(path).size > cap) {
        const old = path + ".old";
        if (existsSync(old)) {
          // Drop the older .old to keep at most 2 generations.
          try { (require("fs") as typeof import("fs")).unlinkSync(old); } catch {}
        }
        try { (require("fs") as typeof import("fs")).renameSync(path, old); } catch {}
      }
      // Read existing, append, atomic-write back.
      let data: { version: number; events: DirectorEvent[] } =
        { version: 1, events: [] };
      if (existsSync(path)) {
        try {
          const raw = readFileSync(path, "utf-8");
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.events)) {
            data = { version: parsed.version || 1, events: parsed.events };
          }
        } catch {}
      }
      data.events.push(...this.pendingEvents);
      // Cap retention to last 30 days even before file-size rotation kicks in.
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      data.events = data.events.filter(e => {
        const t = Date.parse(e.ts);
        return Number.isFinite(t) ? t >= cutoff : true;
      });
      this.writeJson(path, data);
    } catch (err) {
      console.error("[Director] flushEvents failed:", (err as Error).message);
    } finally {
      this.pendingEvents = [];
    }
  }

  /**
   * Re-attempt deferred topics whose account quota has reset.
   * Returns count of triggers fired this round.
   */
  private async processDeferredQueue(states: TopicState[], now: number): Promise<number> {
    if (this.deferred.size === 0) return 0;
    const cb = this.config.onStaleTopic;
    if (!cb) return 0;

    const cap = this.config.maxTriggersPerTick ?? 3;
    let fired = 0;
    const stateByKey = new Map(states.map(s => [s.topicKey, s]));

    for (const entry of [...this.deferred.values()]) {
      if (fired >= cap) break;

      // Check if the account that hit the limit has reset.
      const quota = this.accountQuota.get(entry.account);
      if (quota && quota.resumeAt > now) continue;

      // Make sure the topic is still around and still stalled.
      const state = stateByKey.get(entry.topicKey);
      if (!state) {
        this.deferred.delete(entry.topicKey);
        continue;
      }
      if (
        state.status !== "IN_PROGRESS" ||
        !state.next ||
        state.next.toLowerCase() === "await user input"
      ) {
        // The topic resolved itself — the user replied or Claude finished.
        this.deferred.delete(entry.topicKey);
        continue;
      }

      // Try again. fireTrigger handles re-deferral if it fails again.
      // Tag the reason so the event log distinguishes deferred retries
      // from fresh stale-mtime triggers.
      state.triggerReason = "deferred-retry";
      const wasFired = await this.fireTrigger(state, entry.account, now);
      if (wasFired) {
        fired++;
        // Successful retry — drop from deferred queue (fireTrigger only
        // re-adds if rate-limited again).
        if (!this.accountQuota.get(entry.account) || this.accountQuota.get(entry.account)!.resumeAt <= now) {
          this.deferred.delete(entry.topicKey);
        }
      }
    }

    if (fired > 0) {
      console.log(`[Director] Resumed ${fired} deferred topic(s)`);
    }
    return fired;
  }

  /**
   * Public entry called by Router when a real human message arrives in
   * a topic. Resets the consecutive-trigger counter so this topic is
   * eligible for chain-on-progress again from zero — the user is back
   * in the loop, the auto cap shouldn't keep punishing the topic.
   */
  resetConsecutiveTriggers(topicKey: string): void {
    if (this.consecutiveTriggers.delete(topicKey)) {
      console.log(`[Director] Reset consecutive triggers for ${topicKey} (user message)`);
    }
  }

  private enqueueDeferred(state: TopicState, account: string, reason: string, _resumeAt: number): void {
    this.deferred.set(state.topicKey, {
      topicKey: state.topicKey,
      name: state.name,
      next: state.next,
      account,
      deferredAt: Date.now(),
      reason,
      modelOverride: state.autoModel ?? this.config.defaultAutoModel ?? "sonnet",
    });
  }

  /**
   * Return true if "now" falls in the night window (22:00–08:00 UK).
   * Communication-category topics are skipped during this window
   * because their NEXT is usually reactive ("ждём ответа от X") and
   * progressing them at 3am doesn't help.
   */
  private isNightUk(now: number): boolean {
    // Construct a UK-local hour without dragging in moment/luxon.
    // Europe/London handles DST automatically via toLocaleString.
    const hourStr = new Date(now).toLocaleString("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    });
    const hour = parseInt(hourStr, 10);
    if (!Number.isFinite(hour)) return false;
    return hour >= 22 || hour < 8;
  }

  /**
   * "YYYY-MM-DD" in Europe/London time. Used as the rollover key for
   * the per-topic daily trigger budget — when this string changes,
   * the per-topic counter resets to 0.
   */
  private bstDateStr(now: number): string {
    const parts = new Date(now).toLocaleDateString("en-CA", {
      timeZone: "Europe/London",
    });
    // en-CA gives YYYY-MM-DD natively.
    return parts;
  }

  /**
   * Multi-signal "last activity" computation for a project. Returns the
   * max mtime across CHECKPOINT.md, .git/HEAD (if any), and the most
   * recent meaningful file in the project root + 1 level deep.
   *
   * Excluded: dotfiles, node_modules, .bun-build, .cache, .tmp, .director,
   * runner/data, .vault, *.log, *.tmp, *.lock.
   *
   * Walks at most ~200 entries to keep tick cost predictable on big
   * projects. CHECKPOINT mtime is always at least the lower bound.
   */
  private computeRichLastActivity(projectPath: string, checkpointMtimeMs: number): number {
    let best = checkpointMtimeMs;

    // 1) git HEAD as a clean "did something get committed" signal
    try {
      const gitHead = join(projectPath, ".git", "HEAD");
      if (existsSync(gitHead)) {
        const m = statSync(gitHead).mtimeMs;
        if (m > best) best = m;
      }
    } catch { /* no .git, skip */ }

    // 2) Most recent meaningful file (root + depth-1 subdirs)
    const skipDir = (name: string): boolean => {
      if (name.startsWith(".")) return true;
      const blacklist = ["node_modules", "dist", "build", ".bun-build", ".cache", ".tmp", "runner", ".vault"];
      return blacklist.includes(name);
    };
    const skipFile = (name: string): boolean => {
      if (name.startsWith(".")) return true;
      if (name.endsWith(".log")) return true;
      if (name.endsWith(".tmp")) return true;
      if (name.endsWith(".lock")) return true;
      if (name.endsWith(".pyc")) return true;
      return false;
    };
    let scanned = 0;
    const SCAN_BUDGET = 200;
    const scanDir = (dir: string, depth: number): void => {
      if (scanned >= SCAN_BUDGET) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        if (scanned >= SCAN_BUDGET) return;
        const full = join(dir, entry);
        let st;
        try { st = statSync(full); } catch { continue; }
        scanned++;
        if (st.isDirectory()) {
          if (depth > 0 && !skipDir(entry)) {
            scanDir(full, depth - 1);
          }
          continue;
        }
        if (skipFile(entry)) continue;
        if (st.mtimeMs > best) best = st.mtimeMs;
      }
    };
    try { scanDir(projectPath, 1); } catch { /* permissions or whatever */ }

    return best;
  }

  stop(): void {
    this.isStopping = true;
    if (this.timer) {
      clearTimeout(this.timer as unknown as ReturnType<typeof setTimeout>);
      this.timer = undefined;
      console.log("[Director] Stopped");
    }
  }

  /** Run a single scan cycle. Can be called manually. */
  async tick(): Promise<DirectorRegistry> {
    const now = Date.now();
    const states: TopicState[] = [];

    // 0) Refresh web-toggle overrides (downloaded from the dashboard host). Failure
    //    is non-fatal — we just keep stale (or empty) overrides and log.
    if (this.config.loadOverrides) {
      try {
        this.overrides = await this.config.loadOverrides();
        if (this.overrides.size > 0) {
          console.log(`[Director] Loaded ${this.overrides.size} web override(s)`);
        }
      } catch (err) {
        console.warn(`[Director] loadOverrides failed: ${(err as Error).message}`);
      }
    }

    // 1) Scan: read every CHECKPOINT.md and build TopicState[]. No
    //    triggers fired in this loop — selection happens in pass 2.
    for (const [topicKey, mapping] of Object.entries(this.config.topics.topics)) {
      const category = classifyTopic(mapping.name);
      if (category === "ignore") continue;
      const state = this.scanTopic(topicKey, mapping, category, now);
      states.push(state);
    }

    // 1.5) Diff against previous tick's state and emit events for any
    //      per-topic changes. Skipped on boot tick (no prior state).
    // Track topics that just transitioned to COMPLETED so we can
    // accelerate any dependents that BLOCKED_BY them.
    const justCompleted = new Set<string>();
    if (this.firstTickDone) {
      for (const s of states) {
        const prev = this.prevTopicState.get(s.topicKey);
        if (!prev) continue;
        if (prev.status !== s.status) {
          this.recordEvent({
            ts: new Date(now).toISOString(), topicKey: s.topicKey,
            name: s.name, category: s.category, kind: "status",
            from: prev.status, to: s.status,
          });
          if (prev.status !== "COMPLETED" && s.status === "COMPLETED") {
            justCompleted.add(s.topicKey);
          }
        }
        if (prev.progress !== s.progress) {
          this.recordEvent({
            ts: new Date(now).toISOString(), topicKey: s.topicKey,
            name: s.name, category: s.category, kind: "progress",
            from: prev.progress, to: s.progress,
          });
        }
        if ((prev.next || "") !== (s.next || "")) {
          this.recordEvent({
            ts: new Date(now).toISOString(), topicKey: s.topicKey,
            name: s.name, category: s.category, kind: "next",
            from: prev.next, to: s.next,
          });
        }
        if (Boolean(prev.archived) !== Boolean(s.archived)) {
          this.recordEvent({
            ts: new Date(now).toISOString(), topicKey: s.topicKey,
            name: s.name, category: s.category, kind: "archived",
            from: Boolean(prev.archived), to: Boolean(s.archived),
          });
        }
        if ((prev.priority || "normal") !== (s.priority || "normal")) {
          this.recordEvent({
            ts: new Date(now).toISOString(), topicKey: s.topicKey,
            name: s.name, category: s.category, kind: "priority",
            from: prev.priority || "normal", to: s.priority || "normal",
          });
        }
        if ((prev.task || "") !== (s.task || "")) {
          this.recordEvent({
            ts: new Date(now).toISOString(), topicKey: s.topicKey,
            name: s.name, category: s.category, kind: "task",
            from: prev.task, to: s.task,
          });
        }
        // Detect subtask transitions: done:false → done:true.
        // Attach lastBotMsgId so dashboard can link to the exact message.
        // Also carry forward messageId from previous tick for already-done subtasks.
        if (s.subtasks.length > 0) {
          const lastMsgId = this.config.getLastBotMsgId?.(s.topicKey);
          // Build a lookup by text for prev subtasks (text is the stable key)
          const prevMap = new Map(prev.subtasks.map(t => [t.text, t]));
          for (const sub of s.subtasks) {
            const prevSub = prevMap.get(sub.text);
            if (prevSub && !prevSub.done && sub.done) {
              // Transition detected — stamp messageId
              if (lastMsgId) sub.messageId = lastMsgId;
              this.recordEvent({
                ts: new Date(now).toISOString(), topicKey: s.topicKey,
                name: s.name, category: s.category, kind: "subtask",
                detail: sub.text.slice(0, 120),
              });
            } else if (prevSub?.messageId && sub.done) {
              // Carry forward messageId from previous tick
              sub.messageId = prevSub.messageId;
            }
          }
        }
      }
    }
    // BLOCKS/BLOCKED_BY acceleration: when a blocker just transitioned
    // to COMPLETED, clear the cooldown of any dependents so they fire
    // this tick (instead of waiting up to 2h for the standard gate).
    if (justCompleted.size > 0) {
      for (const s of states) {
        if (!s.blockedBy || s.blockedBy.length === 0) continue;
        const someJust = s.blockedBy.some(bk => justCompleted.has(bk));
        if (!someJust) continue;
        // Are ALL blockers now done? (Any non-COMPLETED still blocks.)
        const stateMap = new Map(states.map(x => [x.topicKey, x]));
        const stillPending = s.blockedBy.some(bk => {
          const blocker = stateMap.get(bk);
          return !blocker || blocker.status !== "COMPLETED";
        });
        if (stillPending) continue;
        // Unblock: zero cooldown so the topic fires this tick.
        this.lastTriggered.set(s.topicKey, 0);
        this.recordEvent({
          ts: new Date(now).toISOString(), topicKey: s.topicKey,
          name: s.name, category: s.category, kind: "next",
          detail: `unblocked: blockers now COMPLETED (${s.blockedBy.join(", ")})`,
        });
      }
    }

    // Snapshot for next tick's diff.
    this.prevTopicState = new Map(states.map(s => [s.topicKey, s]));

    // 1.7) Morning summary — once per day at ~08:00 BST.
    if (this.config.onMorningSummary && this.shouldSendMorningSummary(now)) {
      try {
        const summary = this.buildMorningSummary(states, now);
        await this.config.onMorningSummary(summary);
        this.lastDailySummaryAt = now;
        // Cache to disk so the /morning-summary endpoint can serve it
        // to a cloud Routine that pings via cloudflared. Survives a
        // router restart between 08:00 and the time the Routine wakes.
        try {
          const summaryPath = this.config.registryPath.replace(
            /director-registry\.json$/,
            "morning-summary.json",
          );
          writeFileSync(summaryPath, JSON.stringify({
            generatedAt: now,
            generatedAtIso: new Date(now).toISOString(),
            text: summary,
          }, null, 2), "utf-8");
        } catch (writeErr) {
          console.warn("[Director] morning-summary cache failed:", (writeErr as Error).message);
        }
        console.log("[Director] Morning summary sent");
      } catch (err) {
        console.error("[Director] Morning summary failed:", (err as Error).message);
      }
    }

    // 2) Selection. Skipped on the boot tick (firstTickDone guard) so a
    //    fresh router process doesn't fire a stampede before cooldowns
    //    are loaded.
    let firedCount = 0;
    if (this.firstTickDone && this.config.onStaleTopic) {
      // 2a) First, try resuming previously deferred topics whose
      //     account quota has now reset. Resumed entries count toward
      //     maxTriggersPerTick like fresh ones.
      firedCount += await this.processDeferredQueue(states, now);

      // 2b) Pick fresh stalled topics, sort by recency, take top N.
      // Query runner for recent timeouts/failures so we can fast-retry
      // topics whose last job broke mid-task (5 min instead of 30 min).
      let recentFailures: Set<string> | undefined;
      if (this.config.getRecentJobFailures) {
        try {
          recentFailures = await this.config.getRecentJobFailures();
          if (recentFailures.size > 0) {
            console.log(`[Director] Fast-retry candidates from runner: ${[...recentFailures].join(", ")}`);
          }
        } catch (err) {
          // Non-fatal — fall back to normal cooldowns.
        }
      }
      // Triggers fire in PARALLEL via Promise.all so the tick's wall-clock
      // is max(spawn) rather than sum(spawn). The runner serializes per-topic
      // already, so cross-topic parallelism is safe. We still respect the
      // account quota lockout — if any of the parallel triggers hits a rate
      // limit first, the others will be re-classified into deferred on
      // their own callbacks. trigger_started events flush as soon as
      // they're emitted, so Activity tab sees "spawning…" right away.
      const cap = this.config.maxTriggersPerTick ?? 3;
      const remaining = Math.max(0, cap - firedCount);
      if (remaining > 0) {
        const candidates = this.selectTriggerCandidates(states, now, recentFailures);
        const account = this.config.getActiveAccountName?.() ?? "default";
        // Account already locked? Defer all candidates without spawning.
        const quota = this.accountQuota.get(account);
        if (quota && quota.resumeAt > now) {
          for (const state of candidates.slice(0, remaining)) {
            this.enqueueDeferred(state, account, "rate_limit", quota.resumeAt);
          }
        } else {
          const slice = candidates.slice(0, remaining);
          // Push trigger_started events FIRST so the activity log shows
          // them immediately even if spawns take a while.
          this.flushEvents();
          // Fire all in parallel and wait for all to settle.
          const results = await Promise.allSettled(
            slice.map(state => this.fireTrigger(state, account, now)),
          );
          for (const r of results) {
            if (r.status === "fulfilled" && r.value) firedCount++;
          }
        }
      }
    }

    // 3) Build registry, dashboard, persist, sync to the dashboard host.
    const registry: DirectorRegistry = {
      generatedAt: new Date(now).toISOString(),
      totalTopics: states.length,
      activeCount: states.filter(s => s.status === "IN_PROGRESS").length,
      stalledCount: states.filter(s =>
        s.status === "IN_PROGRESS" &&
        s.stalledMinutes > (this.staleThresholdMs / 60000)
      ).length,
      completedCount: states.filter(s => s.status === "COMPLETED").length,
      topics: states,
      // Persist cooldown map so a router restart doesn't reset triggers.
      lastTriggered: this.serializeLastTriggered(states),
      deferredTopics: [...this.deferred.values()],
      accountQuota: Object.fromEntries(this.accountQuota.entries()),
      lastDailySummaryAt: this.lastDailySummaryAt || undefined,
      lastManualUserAt: Object.fromEntries(this.lastManualUserAt.entries()),
      failedCount: Object.fromEntries(this.failedCount.entries()),
      dailyTriggerCount: Object.fromEntries(this.dailyTriggerCount.entries()),
    };

    // Persist
    this.writeJson(this.config.registryPath, registry);

    // Build dashboard
    const dashboard: DashboardData = {
      totalTopics: registry.totalTopics,
      activeCount: registry.activeCount,
      stalledCount: registry.stalledCount,
      completedCount: registry.completedCount,
      deferredCount: Math.max(this.deferred.size, states.filter(s => s.status === "DEFERRED").length),
      lastScan: new Date(now).toLocaleString("ru-RU", { timeZone: "Europe/London" }),
      nextReview: "09:00 tomorrow",
      accountQuota: Object.fromEntries(this.accountQuota.entries()),
      topics: states.map(s => ({
        topicKey: s.topicKey,
        name: s.name,
        category: s.category,
        status: s.status,
        task: s.task,
        progress: s.progress,
        subtasks: s.subtasks,
        lastAction: s.lastAction,
        lastActivity: s.lastActivity,
        deferred: this.deferred.get(s.topicKey) ? {
          reason: this.deferred.get(s.topicKey)!.reason,
          account: this.deferred.get(s.topicKey)!.account,
          deferredAt: this.deferred.get(s.topicKey)!.deferredAt,
        } : undefined,
        archived: s.archived,
        priority: s.priority,
      })),
    };

    this.writeJson(this.config.dashboardPath, dashboard);

    if (this.config.onDashboardUpdate) {
      try {
        await this.config.onDashboardUpdate(dashboard);
      } catch (err) {
        console.error("[Director] onDashboardUpdate failed:", (err as Error).message);
      }
    }

    const tickSuffix =
      (firedCount > 0 ? ` | fired ${firedCount} trigger${firedCount === 1 ? "" : "s"}` : "") +
      (this.deferred.size > 0 ? ` | deferred ${this.deferred.size}` : "") +
      (this.firstTickDone ? "" : " (boot tick — auto-triggers suppressed)");
    console.log(
      `[Director] Scan complete: ${registry.totalTopics} topics, ` +
      `${registry.activeCount} active, ${registry.stalledCount} stalled, ` +
      `${registry.completedCount} completed${tickSuffix}`
    );

    // After the first successful tick, future ticks may fire triggers.
    this.firstTickDone = true;

    // Persist pending events (diffs + trigger results from this tick).
    this.flushEvents();

    // Notify the /health endpoint so it can report fresh lastTickAt.
    if (this.config.onTickComplete) {
      try { this.config.onTickComplete(registry); }
      catch (err) { console.warn("[Director] onTickComplete threw:", (err as Error).message); }
    }

    return registry;
  }

  /**
   * Filter the in-memory cooldown map down to topics that still exist
   * (so deleted topics don't accumulate forever) and return as a plain
   * object suitable for JSON serialization.
   */
  private serializeLastTriggered(states: TopicState[]): Record<string, number> {
    const liveKeys = new Set(states.map(s => s.topicKey));
    const out: Record<string, number> = {};
    for (const [k, v] of this.lastTriggered.entries()) {
      if (liveKeys.has(k)) out[k] = v;
    }
    return out;
  }

  private scanTopic(
    topicKey: string,
    mapping: TopicMapping,
    category: TopicCategory,
    now: number,
  ): TopicState {
    const projectDir = mapping.project;
    const checkpointPath = join(projectDir, "CHECKPOINT.md");

    const base: Omit<TopicState, "status" | "task" | "progress" | "subtasks" | "lastAction" | "next" | "lastActivity" | "lastActivityMs" | "stalledMinutes" | "autoModel" | "blockedAtNight"> = {
      topicKey,
      name: mapping.name,
      project: projectDir,
      category,
    };

    if (!existsSync(checkpointPath)) {
      return {
        ...base,
        status: "NOT_STARTED",
        task: "",
        progress: 0,
        subtasks: [],
        lastAction: "",
        next: "",
        lastActivity: "",
        lastActivityMs: 0,
        stalledMinutes: 0,
      };
    }

    try {
      const rawContent = readFileSync(checkpointPath, "utf-8");
      // Strip UTF-8 BOM (ef bb bf) — some editors add it, causes mojibake
      // when Director embeds NEXT text into Telegram messages.
      const content = rawContent.replace(/^\uFEFF/, "");
      const checkpoint = parseCheckpoint(content);
      const stat = statSync(checkpointPath);
      const checkpointMtime = stat.mtimeMs;
      // Multi-signal stalled detection. CHECKPOINT.md mtime is the primary
      // signal but unreliable: a spawn can do real work without writing
      // CHECKPOINT (e.g. only edited code), or CHECKPOINT can get bumped
      // by an unrelated tool. Take max over: CHECKPOINT mtime, git HEAD
      // mtime, most recent meaningful file in the project. This way
      // Director sees actual progress even when CHECKPOINT lags.
      const richMtime = this.computeRichLastActivity(projectDir, checkpointMtime);
      const lastModified = richMtime;
      const stalledMinutes = Math.round((now - lastModified) / 60000);
      const lastActivity = new Date(lastModified).toISOString().slice(0, 16).replace("T", " ");

      // Auto-detect AWAITING_USER from NEXT field.
      // Beyond the canonical "await user input", we also catch natural-
      // language phrases that humans actually type — Russian "Ждём", "Жду",
      // "Ожидаем" and English "Wait", "Waiting", "Awaiting". This prevents
      // Director from treating "Ждём ответа от X" as actionable work.
      let status = checkpoint.status;
      if (status === "IN_PROGRESS") {
        const nextLow = (checkpoint.next || "").toLowerCase().trim();
        if (
          nextLow.includes("await user input") ||
          /(?:^|\|)\s*(ждём|ждем|жду|ожида|дожида|дождат|дождё|дожда|wait\b|waiting\b|awaiting\b)/i.test(checkpoint.next || "")
        ) {
          status = "AWAITING_USER";
        }
      }

      // Apply web-toggle overrides on top of CHECKPOINT.md values.
      // Override wins. Removing override (PHP returns 200 with delete) =
      // back to CHECKPOINT.md value on next tick.
      const ovr = this.overrides.get(topicKey);
      const finalArchived = ovr?.archived !== undefined ? ovr.archived : checkpoint.archived;
      const finalPriority = ovr?.priority !== undefined ? ovr.priority : checkpoint.priority;
      return {
        ...base,
        status,
        task: checkpoint.task,
        progress: checkpoint.progress,
        subtasks: checkpoint.subtasks,
        lastAction: checkpoint.lastAction,
        next: checkpoint.next,
        lastActivity,
        lastActivityMs: lastModified,
        stalledMinutes,
        autoModel: checkpoint.autoModel,
        blockedAtNight: checkpoint.blockedAtNight,
        archived: finalArchived,
        priority: finalPriority,
        executionMode: checkpoint.executionMode,
        executionPhase: checkpoint.executionPhase,
        planFile: checkpoint.planFile,
        feedback: checkpoint.feedback,
        visualVerify: checkpoint.visualVerify,
        visualUrl: checkpoint.visualUrl,
        visualIterations: checkpoint.visualIterations,
        blocks: checkpoint.blocks,
        blockedBy: checkpoint.blockedBy,
      };
    } catch (err) {
      console.error(`[Director] Failed to read ${checkpointPath}:`, (err as Error).message);
      return {
        ...base,
        status: "NOT_STARTED",
        task: "",
        progress: 0,
        subtasks: [],
        lastAction: "",
        next: "",
        lastActivity: "",
        lastActivityMs: 0,
        stalledMinutes: 0,
      };
    }
  }

  // ─── Morning summary ───────────────────────────────────────────────

  /**
   * Return true if it's time to send today's morning summary.
   * Window: 07:45–08:30 BST, and we haven't sent one today.
   */
  private shouldSendMorningSummary(now: number): boolean {
    const ukTime = new Date(now).toLocaleString("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const [hourStr, minStr] = ukTime.split(":");
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minStr, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
    const minuteOfDay = hour * 60 + minute;
    // Window: 07:45 (465) to 08:30 (510)
    if (minuteOfDay < 465 || minuteOfDay > 510) return false;
    // Already sent today? Compare calendar dates in UK timezone.
    if (this.lastDailySummaryAt > 0) {
      const lastDate = new Date(this.lastDailySummaryAt).toLocaleDateString("en-GB", {
        timeZone: "Europe/London",
      });
      const todayDate = new Date(now).toLocaleDateString("en-GB", {
        timeZone: "Europe/London",
      });
      if (lastDate === todayDate) return false;
    }
    return true;
  }

  /**
   * Build a formatted plain-text morning summary from the current states
   * and the events log (last 24 hours of activity).
   */
  /**
   * Convert topicKey "-1001234567890:9" → "https://t.me/c/1234567890/9".
   * Strip the "-100" prefix from chatId for t.me/c/ links.
   */
  private topicLink(topicKey: string): string {
    const [chatId, threadId] = topicKey.split(":");
    const stripped = chatId.replace(/^-100/, "");
    if (threadId === "general" || !threadId) {
      return `https://t.me/c/${stripped}`;
    }
    return `https://t.me/c/${stripped}/${threadId}`;
  }

  private buildMorningSummary(states: TopicState[], now: number): string {
    const todayStr = new Date(now).toLocaleDateString("ru-RU", {
      timeZone: "Europe/London",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    // Load events from last 24 hours for "what changed" context.
    const recentEvents = this.loadRecentEvents(now - 24 * 60 * 60 * 1000);
    const triggersByTopic = new Map<string, number>();
    const statusChanges = new Map<string, { from: string; to: string }>();
    const progressChanges = new Map<string, { from: number; to: number }>();
    for (const ev of recentEvents) {
      if (ev.kind === "trigger_success") {
        triggersByTopic.set(ev.topicKey, (triggersByTopic.get(ev.topicKey) ?? 0) + 1);
      }
      if (ev.kind === "status") {
        statusChanges.set(ev.topicKey, { from: String(ev.from), to: String(ev.to) });
      }
      if (ev.kind === "progress") {
        const prev = progressChanges.get(ev.topicKey);
        progressChanges.set(ev.topicKey, {
          from: prev ? prev.from : Number(ev.from),
          to: Number(ev.to),
        });
      }
    }

    // Partition topics.
    const active = states.filter(s => s.status === "IN_PROGRESS");
    const awaiting = states.filter(s => s.status === "AWAITING_USER");
    const completedRecently = states.filter(s =>
      s.status === "COMPLETED" &&
      statusChanges.get(s.topicKey)?.to === "COMPLETED"
    );

    const lines: string[] = [];
    lines.push(`Доброе утро. Сводка за ${todayStr}`);
    lines.push("");

    // Active topics — sorted by priority desc, then progress desc.
    if (active.length > 0) {
      lines.push(`--- Активные (${active.length}) ---`);
      const sorted = [...active].sort((a, b) => {
        const pw = (p?: string) => p === "high" ? 2 : p === "low" ? 0 : 1;
        const pd = pw(b.priority) - pw(a.priority);
        return pd !== 0 ? pd : b.progress - a.progress;
      });
      for (const s of sorted) {
        const prog = progressChanges.get(s.topicKey);
        const delta = prog ? ` (+${prog.to - prog.from}%)` : "";
        const triggers = triggersByTopic.get(s.topicKey);
        const trigStr = triggers ? `, ${triggers} триггер${triggers > 1 ? "а/ов" : ""}` : "";
        const doneCount = s.subtasks.filter(t => t.done).length;
        const totalCount = s.subtasks.length;
        const subtaskStr = totalCount > 0
          ? `, подзадачи ${doneCount}/${totalCount}`
          : "";
        const remain = totalCount > 0
          ? s.subtasks.filter(t => !t.done).map(t => t.text).slice(0, 2).join("; ")
          : s.next || "";
        const prioTag = s.priority === "high" ? " [!]" : "";

        const link = this.topicLink(s.topicKey);
        lines.push(`${s.name} (${link})${prioTag} — ${s.progress}%${delta}${trigStr}${subtaskStr}`);
        if (remain) {
          lines.push(`  осталось: ${remain.slice(0, 120)}`);
        }
      }
      lines.push("");
    }

    // Completed in the last 24h.
    if (completedRecently.length > 0) {
      lines.push(`--- Завершены за сутки (${completedRecently.length}) ---`);
      for (const s of completedRecently) {
        lines.push(`${s.name} (${this.topicLink(s.topicKey)}) — ${s.task.slice(0, 100)}`);
      }
      lines.push("");
    }

    // Awaiting user.
    if (awaiting.length > 0) {
      lines.push(`--- Ждут пользователя (${awaiting.length}) ---`);
      for (const s of awaiting) {
        lines.push(`${s.name} (${this.topicLink(s.topicKey)}) — ${(s.next || s.task).slice(0, 100)}`);
      }
      lines.push("");
    }

    // Deferred (rate-limited).
    if (this.deferred.size > 0) {
      lines.push(`--- Отложены (rate limit): ${this.deferred.size} ---`);
      for (const d of this.deferred.values()) {
        lines.push(`${d.name} (${this.topicLink(d.topicKey)}) — ${d.reason}`);
      }
      lines.push("");
    }

    // Footer.
    const totalActive = active.length;
    const totalDone = states.filter(s => s.status === "COMPLETED").length;
    const totalAwaiting = awaiting.length;
    const totalTriggers24h = [...triggersByTopic.values()].reduce((a, b) => a + b, 0);
    lines.push(
      `Итого: ${totalActive} активных, ${totalDone} завершено, ` +
      `${totalAwaiting} ждут пользователя, ${totalTriggers24h} авто-триггеров за сутки`
    );

    return lines.join("\n");
  }

  /**
   * Read events from the events file that occurred after `sinceMs`.
   * Fail-soft: returns [] on any read/parse error.
   */
  private loadRecentEvents(sinceMs: number): DirectorEvent[] {
    if (!this.config.eventsPath) return [];
    try {
      if (!existsSync(this.config.eventsPath)) return [];
      const raw = readFileSync(this.config.eventsPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.events)) return [];
      return (parsed.events as DirectorEvent[]).filter(e => {
        const t = Date.parse(e.ts);
        return Number.isFinite(t) && t >= sinceMs;
      });
    } catch {
      return [];
    }
  }

  private writeJson(path: string, data: unknown): void {
    try {
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmp, path);
    } catch (err) {
      console.error(`[Director] Failed to write ${path}:`, (err as Error).message);
    }
  }
}
