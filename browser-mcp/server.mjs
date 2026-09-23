/**
 * Custom per-topic browser MCP — одно соединение к общему Chrome :9222,
 * СВОЙ изолированный контекст на этот процесс (= на топик) с перенесёнными
 * cookies реального профиля. Переиспользует ВСЕ инструменты @playwright/mcp
 * через playwright-core/lib/coreBundle -> tools.createConnection(cfg, ctxGetter).
 *
 * Зачем так: общий профиль (default context :9222) даёт логины, но стоковый MCP
 * на нём садится на общую активную вкладку — топики дерутся. Отдельный контекст
 * на топик = свои вкладки/окно (изоляция), а cookies из профиля переносим, чтобы
 * сохранить логины/2FA. Каждый топик = своё окно incognito с твоими логинами.
 *
 * Запуск (один процесс на топик, порт из пула брокера):
 *   node server.mjs            (порт из env MCP_PORT, топик из MCP_TOPIC)
 *   node server.mjs <port> <topic>
 *
 * HTTP MCP (streamable) на 127.0.0.1:<port>/mcp.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createRequire } from "module";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const require = createRequire(import.meta.url);
const { tools } = require("playwright-core/lib/coreBundle");

const PORT = parseInt(process.env.MCP_PORT || process.argv[2] || "8940", 10);
const TOPIC = process.env.MCP_TOPIC || process.argv[3] || "topic";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
// "default" = работать в default context выделенного Chrome (свой user-data-dir,
// логины сделаны руками в этом профиле, cookies НЕ копируются из общего :9222).
// Иначе "isolated" (поведение по умолчанию).
const CONTEXT_MODE = process.env.MCP_CONTEXT_MODE || "isolated";
const CFG = { timeouts: { navigation: 60000, action: 30000 } };

const log = (...a) => console.log(new Date().toISOString(), `[${TOPIC}:${PORT}]`, ...a);

// Человекочитаемое имя топика из config/topics.json (для подписи окна).
function resolveLabel() {
  try {
    const t = JSON.parse(readFileSync(fileURLToPath(new URL("../config/topics.json", import.meta.url)), "utf8"));
    const name = t?.topics?.[TOPIC]?.name;
    if (name && String(name).trim()) return String(name).trim();
  } catch {}
  return TOPIC;
}
const LABEL = resolveLabel();

const browser = await chromium.connectOverCDP(CDP);
const defaultCtx = browser.contexts()[0];

let topicCtx = null;
async function ensureContext() {
  if (topicCtx) return topicCtx;
  if (CONTEXT_MODE === "default") {
    topicCtx = defaultCtx;
    log("using DEFAULT context of dedicated Chrome (cdp " + CDP + ")");
    return topicCtx;
  }
  let cookies = [];
  try { cookies = await defaultCtx.cookies(); } catch {}
  const ctx = await browser.newContext();
  if (cookies.length) { try { await ctx.addCookies(cookies); } catch (e) { log("addCookies warn:", e.message); } }

  // Подпись окна именем топика: префикс [Имя] в заголовке КАЖDOЙ вкладки этого
  // контекста. Так пользователь опознаёт, какое окно к какому топику относится.
  // addInitScript применяется ко всем будущим страницам контекста; setInterval
  // держит префикс даже если сайт сам меняет document.title (SPA).
  try {
    const prefix = `[${LABEL}] `;
    await ctx.addInitScript(`(() => {
      const P = ${JSON.stringify(prefix)};
      const apply = () => { try {
        const base = (document.title || "").replace(/^\\[[^\\]]*\\]\\s*/, "");
        const want = P + base;
        if (document.title !== want) document.title = want;
      } catch (e) {} };
      apply();
      try { setInterval(apply, 1000); } catch (e) {}
      try { document.addEventListener("DOMContentLoaded", apply); } catch (e) {}
    })();`);
  } catch (e) { log("addInitScript(label) warn:", e.message); }

  ctx.on("close", () => { log("topic context closed"); topicCtx = null; });
  topicCtx = ctx;
  log("topic context ready (seeded cookies:", cookies.length + ")");
  return ctx;
}

const transports = Object.create(null);
const isInit = (b) => b && (Array.isArray(b) ? b.some((m) => m?.method === "initialize") : b.method === "initialize");

const httpServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    try {
      let body;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; } catch { body = undefined; }
      const sid = req.headers["mcp-session-id"];
      let transport = sid ? transports[sid] : undefined;

      if (!transport && !sid && isInit(body)) {
        const ctx = await ensureContext();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports[id] = transport; },
        });
        transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
        const server = await tools.createConnection(CFG, async () => ctx);
        await server.connect(transport);
        log("new MCP session");
      }

      if (!transport) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session (initialize first)" }, id: null }));
        return;
      }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log("request error:", e?.message || e);
      try { res.writeHead(500); res.end(); } catch {}
    }
  });
});

httpServer.listen(PORT, "127.0.0.1", () => log(`listening on http://127.0.0.1:${PORT}/mcp (cdp ${CDP})`));

async function shutdown() {
  log("shutdown");
  try { if (topicCtx && CONTEXT_MODE !== "default") await topicCtx.close(); } catch {}
  try { await browser.close(); } catch {} // только отключение CDP, реальный Chrome жив
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
try { process.on("SIGBREAK", shutdown); } catch {}
