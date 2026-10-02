/**
 * Providers: which CLI (executor) and which model answers in a topic.
 *
 * config/providers.json (see providers.example.json) lists providers;
 * a topic picks one with /provider <id> (TopicMapping.provider), otherwise
 * the file "default", otherwise claude. Without the file only claude exists
 * and everything works exactly as before.
 *
 * Keys: keyFile is a .env file (relative paths are resolved against
 * TELECLAUDE_HOME, default ~/.teleclaude, so keys never live in the repo).
 * The key is read at spawn time and passed only to that job's env.
 *
 * TeleClaude never switches providers on its own. A rate limit pauses the
 * topic; changing the provider is always a manual /provider.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { TopicMapping } from "./config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type ExecutorId = "claude" | "opencode";

export interface ProviderConfig {
  id: string;
  executor: ExecutorId;
  name?: string;
  baseURL?: string;
  model?: string;
  apiKeyEnv?: string;
  keyFile?: string;
  npm?: string;
  /** Short tag for the reply prefix, default "<id>:<last model segment>". */
  tag?: string;
}

export interface ProvidersFile {
  default?: string;
  providers: ProviderConfig[];
}

export const CLAUDE_PROVIDER: ProviderConfig = { id: "claude", executor: "claude", name: "Claude Code" };

export const PROVIDERS_PATH = process.env.TELECLAUDE_PROVIDERS ?? join(ROOT, "config", "providers.json");
export const TELECLAUDE_HOME = process.env.TELECLAUDE_HOME ?? join(homedir(), ".teleclaude");

let cache: { path: string; mtimeMs: number; data: ProvidersFile } | null = null;

/** Problems of one provider entry, empty if it can be used. */
export function validateProvider(p: ProviderConfig): string[] {
  const errors: string[] = [];
  if (!p || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(p.id)) errors.push("id: латиница, цифры, - и _");
  if (p?.executor !== "claude" && p?.executor !== "opencode") errors.push(`executor: claude или opencode`);
  if (p?.executor === "opencode") {
    if (!p.baseURL || !/^https?:\/\//.test(p.baseURL)) errors.push("baseURL: нужен http(s) URL");
    if (!p.model) errors.push("model: не задан");
    if (!p.apiKeyEnv || !/^[A-Z_][A-Z0-9_]*$/.test(p.apiKeyEnv)) errors.push("apiKeyEnv: имя переменной, например DEEPSEEK_API_KEY");
  }
  return errors;
}

/** Reads providers.json, re-reads it when the file changes (no restart). */
export function loadProviders(path = PROVIDERS_PATH): ProvidersFile {
  let mtimeMs = -1;
  try {
    if (existsSync(path)) mtimeMs = statSync(path).mtimeMs;
  } catch {}
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.data;

  let data: ProvidersFile = { default: "claude", providers: [] };
  if (mtimeMs >= 0) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const list = Array.isArray(raw?.providers) ? raw.providers : [];
      const valid: ProviderConfig[] = [];
      for (const p of list) {
        const errors = validateProvider(p);
        if (errors.length) console.warn(`[providers] skip "${p?.id}": ${errors.join("; ")}`);
        else valid.push(p);
      }
      data = { default: typeof raw?.default === "string" ? raw.default : "claude", providers: valid };
    } catch (err) {
      console.warn(`[providers] ${path}: ${(err as Error).message}; only claude is available`);
    }
  }
  if (!data.providers.some((p) => p.id === "claude")) data.providers.unshift(CLAUDE_PROVIDER);
  cache = { path, mtimeMs, data };
  return data;
}

export function getProvider(id: string | undefined, file = loadProviders()): ProviderConfig | undefined {
  return id ? file.providers.find((p) => p.id === id) : undefined;
}

/** Provider of a topic: override, else file default, else claude. */
export function resolveTopicProvider(mapping: TopicMapping | undefined, file = loadProviders()): ProviderConfig {
  return getProvider(mapping?.provider, file) ?? getProvider(file.default, file) ?? CLAUDE_PROVIDER;
}

/** Reads the provider key: keyFile first, then the process env. */
export function readProviderKey(p: ProviderConfig): string | undefined {
  if (!p.apiKeyEnv) return undefined;
  if (p.keyFile) {
    const file = isAbsolute(p.keyFile) ? p.keyFile : join(TELECLAUDE_HOME, p.keyFile);
    try {
      for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && m[1] === p.apiKeyEnv) {
          const v = m[2].replace(/^(['"])(.*)\1$/, "$2").trim();
          if (v) return v;
        }
      }
    } catch {}
  }
  return process.env[p.apiKeyEnv] || undefined;
}

/** Reply prefix tag for non-claude providers, e.g. "deepseek:deepseek-chat". */
export function providerTag(p: ProviderConfig): string {
  if (p.tag) return p.tag;
  const last = (p.model || "").split("/").filter(Boolean).pop() || p.model || "";
  return last ? `${p.id}:${last}` : p.id;
}

// ─── Sessions per (topic, executor) ─────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]{8,64}$/;

/** Which executor a session id belongs to (by its format). */
export function executorOfSession(id: string | undefined): ExecutorId | undefined {
  if (!id) return undefined;
  if (UUID_RE.test(id)) return "claude";
  if (OPENCODE_SESSION_RE.test(id)) return "opencode";
  return undefined;
}

export function sessionFor(mapping: TopicMapping, executor: ExecutorId): string | undefined {
  const id = executor === "claude" ? mapping.sessionId : mapping.sessions?.[executor];
  return executorOfSession(id) === executor ? id : undefined;
}

/** Stores the id under the executor it belongs to. Returns true if changed. */
export function storeSession(mapping: TopicMapping, id: string | undefined): boolean {
  const executor = executorOfSession(id);
  if (!executor || !id) return false;
  if (executor === "claude") {
    if (mapping.sessionId === id) return false;
    mapping.sessionId = id;
    return true;
  }
  if (mapping.sessions?.[executor] === id) return false;
  mapping.sessions = { ...(mapping.sessions || {}), [executor]: id };
  return true;
}

/** Forgets the session of one executor. Returns true if something was removed. */
export function clearSession(mapping: TopicMapping, executor: ExecutorId): boolean {
  if (executor === "claude") {
    if (!mapping.sessionId) return false;
    delete mapping.sessionId;
    return true;
  }
  if (!mapping.sessions?.[executor]) return false;
  delete mapping.sessions[executor];
  if (Object.keys(mapping.sessions).length === 0) delete mapping.sessions;
  return true;
}

// ─── Job env for non-claude executors ───────────────────────────

const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|OAUTH/i;

/**
 * Env for an opencode job: the router env without secrets (bot token,
 * webhook secret, Claude OAuth/API keys, other providers' keys) plus the
 * key of this provider only.
 */
export function buildProviderEnv(base: Record<string, string>, p: ProviderConfig, key: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (SECRET_NAME_RE.test(k)) continue;
    env[k] = v;
  }
  if (p.apiKeyEnv && key) env[p.apiKeyEnv] = key;
  return env;
}
