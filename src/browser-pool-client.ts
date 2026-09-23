/**
 * Browser Pool Client — мост между runner-client и browser-pool-broker.
 *
 * Когда в settings.json включён `browserPool.enabled`, на каждый job просим
 * у брокера (scripts/browser-pool-broker.ts) изолированный playwright-MCP для
 * данного топика и пишем per-topic mcp-config: берём статичный
 * spawn-mcp-config.json и подменяем в нём playwright.url на топиковый.
 * Остальные MCP (chrome-devtools, reminder-mcp) остаются как есть.
 *
 * ВАЖНО: любая ошибка (брокер не запущен, таймаут, что угодно) → возвращаем
 * null, и вызывающий код откатывается на статичный --mcp-config. То есть
 * фича не может уронить обычную работу бота. По умолчанию выключена.
 *
 * Настройка в config/settings.json:
 *   "browserPool": {
 *     "enabled": true,
 *     "brokerUrl": "http://127.0.0.1:8930",      // опционально
 *     "staticConfig": "~/.claude/spawn-mcp-config.json", // опц.
 *     "outDir": "<router>/runner/data/mcp-configs"  // опционально
 *   }
 */

import { resolve, dirname, join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { SPAWN_MCP_CONFIG } from "./config";

const RC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BROKER = "http://127.0.0.1:8930";
const DEFAULT_STATIC = SPAWN_MCP_CONFIG;
const DEFAULT_OUTDIR = resolve(RC_ROOT, "runner", "data", "mcp-configs");
const ALLOC_TIMEOUT_MS = 50_000; // брокер ждёт старта Chrome+MCP, даём запас

interface BrowserPoolSettings {
  enabled?: boolean;
  brokerUrl?: string;
  staticConfig?: string;
  outDir?: string;
}

function sanitizeKey(topicKey: string): string {
  return topicKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

/**
 * Если browserPool включён — гарантирует изолированный браузер для топика
 * и возвращает путь к per-topic mcp-config. Иначе (или при любой ошибке)
 * возвращает null — вызывающий код использует статичный конфиг.
 */
export async function resolveTopicMcpConfig(
  topicKey: string,
  settings: unknown,
): Promise<string | null> {
  const bp = (settings as { browserPool?: BrowserPoolSettings })?.browserPool;
  if (!bp?.enabled) return null;

  const brokerUrl = (bp.brokerUrl || DEFAULT_BROKER).replace(/\/$/, "");
  const staticPath = bp.staticConfig || DEFAULT_STATIC;
  const outDir = bp.outDir || DEFAULT_OUTDIR;

  try {
    // 1) Попросить у брокера браузер этого топика.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ALLOC_TIMEOUT_MS);
    let mcpUrl: string;
    try {
      const resp = await fetch(`${brokerUrl}/alloc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicKey }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        console.warn(`[browser-pool] alloc ${resp.status} for ${topicKey} — fallback to static config`);
        return null;
      }
      const data = (await resp.json()) as { mcpUrl?: string };
      if (!data.mcpUrl) return null;
      mcpUrl = data.mcpUrl;
    } finally {
      clearTimeout(t);
    }

    // 2) Взять статичный конфиг как базу и подменить playwright.url.
    let base: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };
    if (existsSync(staticPath)) {
      try { base = JSON.parse(readFileSync(staticPath, "utf-8")); } catch {}
    }
    base.mcpServers = base.mcpServers || {};
    base.mcpServers.playwright = { type: "http", url: mcpUrl };

    // 3) Записать per-topic конфиг.
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${sanitizeKey(topicKey)}.json`);
    writeFileSync(outPath, JSON.stringify(base, null, 2), "utf-8");
    return outPath;
  } catch (err) {
    console.warn(`[browser-pool] resolve failed for ${topicKey}: ${err instanceof Error ? err.message : err} — fallback to static config`);
    return null;
  }
}
