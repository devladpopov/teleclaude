/**
 * Browser Pool Broker — изоляция вкладок по топикам.
 *
 * ПРОБЛЕМА
 * --------
 * Раньше все топики супергруппы делили один bot-Chrome (CDP :9222) через
 * один стоковый @playwright/mcp (:8931). В CDP-режиме @playwright/mcp
 * цепляется к ДЕФОЛТНОМУ browser context реального Chrome, поэтому все
 * сессии всех топиков попадали в один общий набор вкладок и дрались за
 * активную вкладку (bringToFront глобальный).
 *
 * РЕШЕНИЕ (пул)
 * ------------
 * На КАЖДЫЙ топик — свой изолированный браузер:
 *   - отдельный Chrome (свой --remote-debugging-port + свой --user-data-dir)
 *   - отдельный стоковый @playwright/mcp (свой --port, --cdp-endpoint на
 *     Chrome этого топика)
 * Стоковый MCP остаётся неизменным (его browser-тулзы обкатаны), а изоляция
 * достигается тем, что у каждого топика физически свой Chrome.
 *
 * Почему именно CDP-split (Chrome отдельно от MCP), а не стоковый persistent
 * режим: в persistent-режиме @playwright/mcp закрывает браузер по завершении
 * MCP-сессии, а каждый `claude -p`-вызов = новая сессия. Значит между
 * сообщениями в Telegram вкладки бы пропадали. CDP-split (Chrome — отдельный
 * процесс, MCP только подключается) сохраняет вкладки/формы между сообщениями.
 *
 * РЕСУРСЫ
 * -------
 * Ленивый старт (браузер топика поднимается только при первом обращении),
 * idle-reaper (простаивающие топики гасятся), лимит параллельных браузеров
 * (LRU-evict). user-data-dir на топик персистентный → cookies/логины
 * переживают reaping (на диске).
 *
 * API
 * ---
 *   POST /alloc { "topicKey": "<chatId>:<threadId>" }
 *        -> 200 { "mcpUrl": "http://127.0.0.1:<port>/mcp", "cdpPort": <n> }
 *        Идемпотентно: повторный вызов для того же топика возвращает тот же
 *        браузер (и продлевает lastUsed).
 *   GET  /health -> { ok, count, max, entries:[...] }
 *   POST /reap { "topicKey": "..." } -> освободить браузер топика немедленно
 *
 * Запускается из launchers\browser-pool-broker.vbs (silent) через
 * Scheduled Task BrowserPoolBroker (logon trigger). Health подхватывает
 * mcp-health-watchdog.ps1.
 *
 * Запуск вручную:  bun run scripts/browser-pool-broker.ts
 */

import { spawn, execSync } from "node:child_process";
import net from "node:net";
import { mkdirSync, appendFileSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Конфиг ──────────────────────────────────────────────────────────────

const BROKER_PORT = 8930;                 // свободен (8931/8932/9222 заняты)
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE_ROOT = process.env.BROWSER_POOL_PROFILE_ROOT ?? join(homedir(), ".teleclaude", "browser-pool"); // per-topic user-data-dir
const LOG_DIR = process.env.BROWSER_POOL_LOG_DIR ?? join(REPO_ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "browser-pool-broker.log");
const LOCK_FILE = join(LOG_DIR, "browser-pool-broker.lock");
// Список pid'ов поднятых детей (chrome+mcp) — чтобы при нечистом выходе
// (Ctrl+C на Windows ловится ненадёжно, Stop-ScheduledTask убивает дерево)
// следующий старт мог прибить осиротевшие процессы. Self-heal.
const STATE_FILE = join(LOG_DIR, "browser-pool-broker.state.json");

const MAX_BROWSERS = 16;                    // лимит одновременных топик-демонов (лёгкие node-процессы); активные не вытесняются (см ensureEntry)
const IDLE_MINUTES = 60;                    // через сколько простоя гасить демон топика (backstop; активные не трогаем, см reaper)
const REAP_EVERY_MS = 60_000;              // как часто проверять idle
const SHARED_CDP_PORT = 9222;              // ОБЩИЙ bot-Chrome (профиль с логинами владельца), управляется PlaywrightMCPDaemon
// Выделенные Chrome на топик (свой user-data-dir + свой CDP-порт): логины делаются руками
// в этом профиле, cookies общего :9222 НЕ копируются. Chrome живёт постоянно (не гасится
// reaper'ом), при отсутствии поднимается брокером скрыто.
// Карта берётся из config/browser-dedicated.json (gitignored):
//   { "-1001234567890:42": { "cdpPort": 9223, "profile": "my-profile" } }
// profile — имя подкаталога в PROFILE_ROOT.
function loadDedicated(): Record<string, { cdpPort: number; userDataDir: string }> {
  const p = process.env.BROWSER_POOL_DEDICATED ?? join(REPO_ROOT, "config", "browser-dedicated.json");
  try {
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, { cdpPort: number; profile: string }>;
    const out: Record<string, { cdpPort: number; userDataDir: string }> = {};
    for (const [key, v] of Object.entries(raw)) out[key] = { cdpPort: v.cdpPort, userDataDir: join(PROFILE_ROOT, v.profile) };
    return out;
  } catch {
    return {};
  }
}
const DEDICATED = loadDedicated();
const MCP_PORT_BASE = 8940;                // пул mcp-портов: 8940..8999 (хватает на >50 топиков)
const READY_TIMEOUT_MS = 45_000;           // ждать готовности MCP
const NAV_TIMEOUT_MS = 60_000;             // таймаут навигации playwright (задаётся в browser-mcp/server.mjs CFG)
const ACTION_TIMEOUT_MS = 30_000;          // таймаут действий playwright (задаётся в browser-mcp/server.mjs CFG)
const BROWSER_MCP_SERVER = join(REPO_ROOT, "browser-mcp", "server.mjs"); // свой per-topic MCP

// ─── Состояние ───────────────────────────────────────────────────────────

interface Entry {
  topicKey: string;
  cdpPort: number;
  mcpPort: number;
  userDataDir: string;
  chromePid?: number;     // pid процесса chrome.exe (для taskkill /T)
  mcpPid?: number;        // pid обёртки cmd.exe запустившей npx (для taskkill /T)
  ready: boolean;
  lastUsed: number;
  starting?: Promise<Entry>; // дедуп параллельных /alloc одного топика
}

const pool = new Map<string, Entry>();

// ─── Утилиты ─────────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
  // eslint-disable-next-line no-console
  console.log(line.trimEnd());
}

function sanitizeKey(topicKey: string): string {
  return topicKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function usedPorts(field: "cdpPort" | "mcpPort"): Set<number> {
  const s = new Set<number>();
  for (const e of pool.values()) s.add(e[field]);
  return s;
}

function pickPort(base: number, span: number, used: Set<number>): number {
  for (let p = base; p < base + span; p++) if (!used.has(p)) return p;
  throw new Error(`no free port in range ${base}..${base + span}`);
}

/** TCP-проба: порт слушает? (Test-NetConnection ненадёжен для dual-stack). */
function tcpUp(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, "127.0.0.1");
  });
}

async function waitPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpUp(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Сохранить pid'ы живых детей на диск для self-heal после нечистого выхода. */
function persistState(): void {
  try {
    const pids: Array<{ chromePid?: number; mcpPid?: number }> = [];
    for (const e of pool.values()) pids.push({ chromePid: e.chromePid, mcpPid: e.mcpPid });
    writeFileSync(STATE_FILE, JSON.stringify(pids));
  } catch {}
}

/** При старте — синхронно прибить осиротевшие дети прошлого запуска. */
/**
 * Жив ли pid И это ожидаемый exe. process.kill(pid, 0) не годится: после
 * ребута Windows переиспользует pid (2026-09-10 lock указывал на wslhost.exe,
 * брокер двое суток считал себя "already running" и не слушал :8930).
 */
function pidImageIs(pid: number, images: string[]): boolean {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: "utf-8", windowsHide: true });
    const m = out.match(/^"([^"]+)","(\d+)"/m);
    return !!m && Number(m[2]) === pid && images.includes(m[1].toLowerCase());
  } catch {
    return false;
  }
}

function killOrphansFromPreviousRun(): void {
  if (!existsSync(STATE_FILE)) return;
  let pids: Array<{ chromePid?: number; mcpPid?: number }> = [];
  try { pids = JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch {}
  for (const p of pids) {
    for (const pid of [p.mcpPid, p.chromePid]) {
      if (!pid) continue;
      // После ребута pid мог достаться чужому процессу: бьём только node/chrome.
      if (!pidImageIs(pid, ["node.exe", "chrome.exe"])) continue;
      try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true }); } catch {}
    }
  }
  try { rmSync(STATE_FILE); } catch {}
  if (pids.length) log(`self-heal: killed ${pids.length} orphan entr(ies) from previous run`);
}

async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  await new Promise<void>((resolve) => {
    const p = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
    setTimeout(() => resolve(), 5000);
  });
}

/** Снимок netstat (TCP). Один вызов на тик/решение, переиспользуем. */
function netstatSnapshot(): string {
  try { return execSync("netstat -ano -p TCP", { encoding: "utf-8", windowsHide: true }); } catch { return ""; }
}

/** Есть ли активное соединение к mcp-порту (claude держит сессию весь спавн). */
function portHasActiveConn(port: number, ns: string): boolean {
  return new RegExp(`:${port}\\b.*ESTABLISHED`).test(ns);
}

// ─── Жизненный цикл браузера топика ─────────────────────────────────────

async function startEntry(topicKey: string): Promise<Entry> {
  const mcpPort = pickPort(MCP_PORT_BASE, 60, usedPorts("mcpPort"));
  const ded = DEDICATED[topicKey];

  if (ded) {
    const entry: Entry = { topicKey, cdpPort: ded.cdpPort, mcpPort, userDataDir: ded.userDataDir, ready: false, lastUsed: Date.now() };
    pool.set(topicKey, entry);
    log(`start topic=${topicKey} mcp=${mcpPort} -> DEDICATED Chrome cdp=${ded.cdpPort} profile=${ded.userDataDir}`);
    if (!(await tcpUp(ded.cdpPort))) {
      try { mkdirSync(ded.userDataDir, { recursive: true }); } catch {}
      const chrome = spawn(CHROME_PATH, [
        `--remote-debugging-port=${ded.cdpPort}`,
        `--user-data-dir=${ded.userDataDir}`,
        "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--window-position=100,100", "--window-size=1280,800", "about:blank",
      ], { detached: true, stdio: "ignore", windowsHide: true });
      // chromePid НЕ записываем: выделенный Chrome персистентный, его не должен убивать ни reaper, ни killOrphansFromPreviousRun
      chrome.unref();
      if (!(await waitPort(ded.cdpPort, READY_TIMEOUT_MS))) {
        await destroyEntry(topicKey, "dedicated-cdp-timeout");
        throw new Error(`Dedicated Chrome CDP :${ded.cdpPort} not ready for ${topicKey}`);
      }
      log(`dedicated Chrome started pid=${chrome.pid} cdp=${ded.cdpPort}`);
    }
    const mcp = spawn("node", [BROWSER_MCP_SERVER], {
      detached: false, stdio: "ignore", windowsHide: true,
      env: { ...process.env, MCP_PORT: String(mcpPort), MCP_TOPIC: topicKey, CDP_ENDPOINT: `http://127.0.0.1:${ded.cdpPort}`, MCP_CONTEXT_MODE: "default" },
    });
    entry.mcpPid = mcp.pid;
    mcp.unref();
    if (!(await waitPort(mcpPort, READY_TIMEOUT_MS))) {
      await destroyEntry(topicKey, "mcp-port-timeout");
      throw new Error(`Browser MCP :${mcpPort} not ready for ${topicKey}`);
    }
    entry.ready = true; entry.lastUsed = Date.now(); persistState();
    log(`ready  topic=${topicKey} mcpUrl=http://127.0.0.1:${mcpPort}/mcp (DEFAULT context of dedicated Chrome :${ded.cdpPort})`);
    return entry;
  }

  const entry: Entry = { topicKey, cdpPort: SHARED_CDP_PORT, mcpPort, userDataDir: "", ready: false, lastUsed: Date.now() };
  pool.set(topicKey, entry);

  log(`start topic=${topicKey} mcp=${mcpPort} -> shared Chrome cdp=${SHARED_CDP_PORT}`);

  // Требуется живой ОБЩИЙ bot-Chrome на :9222 (профиль с логинами/2FA владельца),
  // которым управляет PlaywrightMCPDaemon. Браузер здесь НЕ поднимаем — только
  // подключаемся к нему. Так все топики делят один профиль (cookies/логины),
  // а изоляция идёт по вкладкам: у каждого топика свой @playwright/mcp-демон
  // со своей "текущей вкладкой".
  if (!(await tcpUp(SHARED_CDP_PORT))) {
    await destroyEntry(topicKey, "shared-cdp-down");
    throw new Error(`Shared Chrome CDP :${SHARED_CDP_PORT} is down — запусти PlaywrightMCPDaemon`);
  }

  // Свой per-topic MCP (browser-mcp/server.mjs): подключается к общему :9222,
  // заводит СВОЙ изолированный контекст с перенесёнными cookies профиля. Так у
  // каждого топика своё окно/вкладки (детерминированная изоляция, не дерутся) +
  // логины. Все инструменты — родные @playwright/mcp (через coreBundle).
  // detached:false + windowsHide:true => скрыто, без всплывающего окна.
  const mcp = spawn("node", [BROWSER_MCP_SERVER], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      MCP_PORT: String(mcpPort),
      MCP_TOPIC: topicKey,
      CDP_ENDPOINT: `http://127.0.0.1:${SHARED_CDP_PORT}`,
    },
  });
  entry.mcpPid = mcp.pid;
  mcp.unref();

  if (!(await waitPort(mcpPort, READY_TIMEOUT_MS))) {
    await destroyEntry(topicKey, "mcp-port-timeout");
    throw new Error(`Browser MCP :${mcpPort} not ready for ${topicKey}`);
  }

  entry.ready = true;
  entry.lastUsed = Date.now();
  persistState();

  log(`ready  topic=${topicKey} mcpUrl=http://127.0.0.1:${mcpPort}/mcp (own context, shared logins from :${SHARED_CDP_PORT})`);
  return entry;
}

async function destroyEntry(topicKey: string, reason: string): Promise<void> {
  const e = pool.get(topicKey);
  if (!e) return;
  pool.delete(topicKey);
  // Гасим ТОЛЬКО mcp-демон топика. Общий Chrome :9222 НЕ трогаем — он один на всех.
  log(`destroy topic=${topicKey} reason=${reason} (mcpPid=${e.mcpPid})`);
  await killTree(e.mcpPid);
  persistState();
}

/** Гарантирует живой браузер для топика, дедупит параллельные старты. */
async function ensureEntry(topicKey: string): Promise<Entry> {
  const existing = pool.get(topicKey);
  if (existing) {
    if (existing.ready) {
      // быстрый sanity-check, что mcp-порт ещё жив
      if (await tcpUp(existing.mcpPort)) {
        existing.lastUsed = Date.now();
        return existing;
      }
      log(`stale topic=${topicKey}: mcp port dead, recreating`);
      await destroyEntry(topicKey, "stale-mcp");
    } else if (existing.starting) {
      return existing.starting;
    }
  }

  // лимит параллельных демонов — LRU-evict, но НЕ трогаем активные
  // (у кого есть живое соединение claude). Иначе вытеснили бы рабочий топик.
  if (pool.size >= MAX_BROWSERS) {
    const ns = netstatSnapshot();
    const victims = [...pool.values()]
      .filter((e) => e.ready && !portHasActiveConn(e.mcpPort, ns))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    if (victims.length > 0) {
      await destroyEntry(victims[0].topicKey, "lru-evict");
    } else {
      throw new Error(`browser pool full (${pool.size}/${MAX_BROWSERS}), все демоны активны`);
    }
  }

  const p = startEntry(topicKey);
  // временный плейсхолдер с обещанием, чтобы дедупить конкурентные /alloc
  const placeholder: Entry = {
    topicKey, cdpPort: -1, mcpPort: -1, userDataDir: "", ready: false, lastUsed: Date.now(), starting: p,
  };
  if (!pool.has(topicKey)) pool.set(topicKey, placeholder);
  try {
    const e = await p;
    return e;
  } catch (err) {
    if (pool.get(topicKey) === placeholder) pool.delete(topicKey);
    throw err;
  }
}

// ─── Idle reaper ─────────────────────────────────────────────────────────

setInterval(() => {
  // Один netstat на тик: ищем активные TCP-подключения к mcp-портам.
  // claude держит SSE-сессию на mcpPort всё время спавна, поэтому наличие
  // ESTABLISHED = демон сейчас используется. Без этой проверки reaper
  // (меряющий простой по времени /alloc) убивал бы playwright прямо посреди
  // длинной задачи → "MCP server playwright is not connected".
  const ns = netstatSnapshot();
  const cutoff = Date.now() - IDLE_MINUTES * 60_000;
  for (const e of [...pool.values()]) {
    if (!e.ready) continue;
    if (portHasActiveConn(e.mcpPort, ns)) {
      e.lastUsed = Date.now(); // активен — продлеваем, не трогаем
      continue;
    }
    if (e.lastUsed < cutoff) void destroyEntry(e.topicKey, `idle>${IDLE_MINUTES}m`);
  }
}, REAP_EVERY_MS);

// ─── HTTP сервер ─────────────────────────────────────────────────────────

async function readJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

Bun.serve({
  port: BROKER_PORT,
  hostname: "127.0.0.1",
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      const entries = [...pool.values()].map((e) => ({
        topicKey: e.topicKey, cdpPort: e.cdpPort, mcpPort: e.mcpPort,
        ready: e.ready, idleSec: Math.round((Date.now() - e.lastUsed) / 1000),
      }));
      return Response.json({ ok: true, count: pool.size, max: MAX_BROWSERS, entries });
    }

    if (req.method === "POST" && url.pathname === "/alloc") {
      const body = await readJson(req);
      const topicKey = String(body.topicKey || "").trim();
      if (!topicKey) return Response.json({ error: "topicKey required" }, { status: 400 });
      try {
        const e = await ensureEntry(topicKey);
        return Response.json({ mcpUrl: `http://127.0.0.1:${e.mcpPort}/mcp`, cdpPort: e.cdpPort });
      } catch (err) {
        log(`alloc FAIL topic=${topicKey}: ${err instanceof Error ? err.message : err}`);
        return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/reap") {
      const body = await readJson(req);
      const topicKey = String(body.topicKey || "").trim();
      if (!topicKey) return Response.json({ error: "topicKey required" }, { status: 400 });
      await destroyEntry(topicKey, "manual-reap");
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});

// ─── Single-instance lock + graceful shutdown ────────────────────────────

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(PROFILE_ROOT, { recursive: true });
if (existsSync(LOCK_FILE)) {
  const old = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
  if (old && old !== process.pid && pidImageIs(old, ["bun.exe"])) {
    log(`already running (pid=${old}), exiting`);
    process.exit(0);
  }
  try { rmSync(LOCK_FILE); } catch {}
}
writeFileSync(LOCK_FILE, String(process.pid));

// Self-heal: после нечистого выхода прошлого запуска прибиваем осиротевшие
// Chrome/MCP (их pid'ы записаны в STATE_FILE). Делаем только после получения
// lock — чтобы второй инстанс не убил детей первого.
killOrphansFromPreviousRun();

async function shutdown() {
  log("shutdown: killing all topic browsers");
  for (const key of [...pool.keys()]) await destroyEntry(key, "broker-shutdown");
  try { rmSync(LOCK_FILE); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Ctrl+Break на Windows доставляется надёжнее, чем Ctrl+C под Bun.
try { process.on("SIGBREAK" as NodeJS.Signals, shutdown); } catch {}

log(`Browser Pool Broker listening on http://127.0.0.1:${BROKER_PORT} (max=${MAX_BROWSERS}, idle=${IDLE_MINUTES}m)`);
