import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Settings {
  telegram: {
    allowedUsers: number[];
  };
  processes: {
    ttlMinutes: number;
    maxConcurrent: number;
    claudePath: string;
    // Binary of the opencode executor (providers with executor "opencode").
    // Default: "opencode" from PATH.
    opencodePath?: string;
    defaultFlags: string[];
    defaultModel: string; // "opus" | "sonnet" | "haiku" etc.
    // Idle watchdog: kill process if no stream-json events for N minutes.
    // Replaces the old wall-clock 5-min hard limit so long agent tasks
    // (Figma, многочасовые правки) не убиваются по таймауту, пока Claude
    // реально что-то делает.
    idleTimeoutMinutes?: number;
    // Heartbeat: после N секунд молчания (без новых текстовых чанков)
    // роутер начинает редактировать статусное сообщение каждые N секунд,
    // показывая текущий tool и прошедшее время. 0 — отключено.
    heartbeatAfterSeconds?: number;
    heartbeatIntervalSeconds?: number;
  };
  compaction: {
    reserveTokens: number;
    keepRecentTokens: number;
    enabled: boolean;
  };
  memory: {
    revisionIntervalMinutes: number;
    maxFileLines: number;
    deduplication: boolean;
    enabled: boolean;
  };
  runner?: {
    enabled: boolean;   // true = use runner sidecar, false = direct spawn
    port?: number;      // default 7878
  };
  // Runtime-флаги, которые меняются из самого бота через команды
  // (/pause, /resume). Живут в том же settings.json — чтобы пауза
  // переживала рестарт роутера.
  runtime?: {
    paused?: boolean;
    pausedAt?: number;
    pausedReason?: string;
  };
  projectsRoot: string;
  templatesDir: string;
  whisper: {
    enabled: boolean;
    url: string;
    language: string;
    // Auto-start: при первом обращении проверять что сервис жив, и если
    // нет — пытаться поднять его через scripts/ensure-whisper.ps1.
    // По умолчанию true. Отключить можно если whisper не используется.
    autoStart?: boolean;
    // Имя docker-контейнера. ensure-whisper.ps1 сначала пробует
    // `docker start <containerName>`, а если не задано — ищет
    // контейнер с image, содержащим "whisper". Опционально.
    containerName?: string;
    // Сколько секунд ждать поднятия контейнера до первого ответа /docs.
    // По умолчанию 90.
    startupTimeoutSeconds?: number;
    // HTTP timeout health-check (мс). По умолчанию 1500.
    healthTimeoutMs?: number;
  };
}

export interface TopicMapping {
  name: string;
  project: string;
  sessionId?: string; // claude session (executor "claude")
  // Sessions of other executors, e.g. { opencode: "ses_..." }. Kept apart
  // from sessionId so switching /provider back and forth keeps both.
  sessions?: Record<string, string>;
  provider?: string; // override per-topic: id from config/providers.json
  model?: string; // override per-topic: "opus", "sonnet", etc.
  effort?: string; // override per-topic: low|medium|high|max (claude --effort); нет поля = дефолт CLI (high)
  memory: string[];
  contextFiles?: string[]; // relative paths within MEMORY_BASE_DIR to inject as extra context
  created: string;
}

/**
 * Base directory for global memory files referenced by contextFiles.
 * Each entry in contextFiles is resolved relative to this path.
 */
export const MEMORY_BASE_DIR = process.env.TELECLAUDE_MEMORY_DIR ?? join(homedir(), ".teleclaude", "memory");

/**
 * Static MCP config passed to every spawned claude via --mcp-config.
 * Override with TELECLAUDE_MCP_CONFIG.
 */
export const SPAWN_MCP_CONFIG = process.env.TELECLAUDE_MCP_CONFIG ?? join(homedir(), ".claude", "spawn-mcp-config.json");

/**
 * Режим группы:
 *   "active"        — бот реагирует на все сообщения от разрешённых
 *                     пользователей (текущее поведение, default для
 *                     уже зарегистрированных групп).
 *   "mention-only"  — бот молчит, пока в сообщении (text/caption) нет
 *                     @<botUsername>. Нужно чтобы в группах, которые
 *                     используются для публикаций (например,
 *                     "попов в ии — отложка"), бот не читал КАЖДОЕ
 *                     сообщение владельца и не расходовал модели.
 *                     Auto-registered группы теперь создаются именно
 *                     в этом режиме — безопасный дефолт (2026-04-19).
 */
export type GroupMode = "active" | "mention-only";

export interface GroupConfig {
  name: string;
  enabled: boolean;
  mode?: GroupMode;
}

export interface TopicsConfig {
  groups: Record<string, GroupConfig>;
  topics: Record<string, TopicMapping>;
}

/**
 * Allowlist алиасов моделей для команды /model в router.
 * Claude CLI принимает эти короткие формы и сам резолвит их в актуальную
 * версию (sonnet → latest sonnet, opus → latest opus). Поэтому храним
 * алиас в TopicMapping.model, а не полный slug — переживёт апгрейд
 * моделей без миграций.
 *
 * "default" НЕ входит в этот список: это сентинел для снятия per-topic
 * override, обрабатывается отдельно в handleCommand.
 */
export const MODEL_ALIASES = ["fable", "opus", "sonnet"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

export function isValidModelAlias(name: string): name is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(name);
}

/**
 * Маппинг alias → точный API model slug. Нужен для system prompt:
 * модель не знает собственную версию из API, она судит по training cutoff,
 * поэтому без этой подсказки будет утверждать устаревший релиз (например,
 * «я opus-4.6», когда реально --model opus резолвится в claude-opus-4-7).
 *
 * System prompt авторитетнее training data, поэтому модель доверяет тому,
 * что мы ей сюда кладём. Обновлять вручную при релизе новой версии
 * от Anthropic (redeploy router — достаточно, никаких миграций).
 *
 * Последняя проверка: 2026-09-23 (Fable 5.1, Opus 5.5, Sonnet 5, Haiku 4.5 current
 * по platform.claude.com/docs/en/models/overview; с поколения 4.6 dateless ID —
 * это пиннед-снапшоты, alias = сам ID).
 */
export const MODEL_SLUGS: Record<ModelAlias, string> = {
  fable: "claude-fable-5-1", // latest fable (Mythos-класс) — обновлять вручную при релизе
  opus: "claude-opus-5-5", // latest opus (23.09.2026, Opus 5.5, требует Claude Code >= 2.1.280) — обновлять вручную при релизе
  sonnet: "claude-sonnet-5", // latest sonnet — обновлять вручную при релизе
};

/**
 * Legacy-алиасы, которые могут остаться в topics.json / settings.
 * Убраны из кнопок /model, но старые конфиги должны продолжать
 * работать и получать корректный slug в system prompt.
 * 2026-09-17: opus-4.7 убран из кнопок (заменён на "opus" = latest),
 * "opus" наоборот возвращён в основные алиасы.
 * 2026-09-21: opus-4.8 убран из кнопок (opus теперь = opus-5).
 */
export const LEGACY_MODEL_SLUGS: Record<string, string> = {
  "opus-4.7": "claude-opus-4-7", // пиннед-версия, осталась в старых topics.json
  "opus-4.8": "claude-opus-4-8", // пиннед-версия, осталась в старых topics.json
  "opus-5": "claude-opus-5", // пиннед Opus 5 (legacy с 23.09.2026, opus теперь = 5.5)
  haiku: "claude-haiku-4-5", // не в кнопках (решение 21.09: не нужна), но руками задать можно
};

/**
 * Что передавать в `claude --model` для алиаса.
 * 2026-09-21: всегда передаём точный slug из MODEL_SLUGS/LEGACY, а не
 * короткие формы "opus"/"sonnet". Причина: короткую форму CLI резолвит
 * сам, и его представление о "latest" может отличаться от slug'а,
 * который мы кладём в system prompt (модель тогда врёт про свой префикс).
 * Неизвестные строки пропускаем как есть (на случай ручного slug
 * в topics.json / settings).
 */
export function cliModelArg(aliasOrSlug: string): string {
  return (MODEL_SLUGS as Record<string, string>)[aliasOrSlug]
    ?? LEGACY_MODEL_SLUGS[aliasOrSlug]
    ?? aliasOrSlug;
}

/**
 * Уровни усилий (thinking effort) для `claude --effort` (CLI >= 2.1.9x).
 * Дефолт CLI = high; уровень claude.ai "Extra" в CLI отсутствует.
 * "default" — сентинел снятия override (не передаём флаг вовсе).
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isValidEffortLevel(name: string): name is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(name);
}

/**
 * Человекочитаемый префикс для сообщений: "claude-opus-4-7" -> "opus-4.7".
 * Используется в system prompt как требуемый префикс каждого ответа.
 */
export function shortModelTag(slug: string): string {
  return slug.replace(/^claude-/, "").replace(/(\d+)-(\d+)$/, "$1.$2");
}

export function loadSettings(): Settings {
  const path = resolve(ROOT, "config/settings.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function loadTopics(): TopicsConfig {
  const path = resolve(ROOT, "config/topics.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveTopics(config: TopicsConfig): void {
  const path = resolve(ROOT, "config/topics.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

export function getTemplatesDir(): string {
  return resolve(ROOT, "templates");
}

export function getBotToken(): string {
  const envPath = resolve(ROOT, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/TELEGRAM_BOT_TOKEN=(.+)/);
    if (match) return match[1].trim();
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set. Create .env file or set env variable.");
  return token;
}
