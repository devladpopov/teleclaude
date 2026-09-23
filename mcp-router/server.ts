#!/usr/bin/env bun
/**
 * mcp-router — stdio MCP сервер, даёт spawn'у легальный способ дёрнуть
 * spawn в ДРУГОМ топике. Без этого тула spawn'ы могли только bot.api.sendMessage,
 * а получающий топик такие сообщения игнорирует (allowedUsers фильтр), так
 * что cross-topic делегирование не работало.
 *
 * Tools:
 *   trigger_topic({topicKey, text})
 *      — запускает spawn в указанном топике с text как user-message.
 *        Тот же путь что Director auto-trigger / /loop / action-mode reminder.
 *
 *   current_topic()
 *      — возвращает topicKey текущего топика (chatId:threadId).
 *        Полезно когда spawn хочет знать "где я", чтобы что-то про себя
 *        написать в registry/dashboard.
 *
 * ENV CONTRACT (инжектится router'ом в process-manager / runner-client):
 *   - ROUTER_INTERNAL_URL    default http://127.0.0.1:7885
 *   - ROUTER_INTERNAL_SECRET optional, must match the router's value
 *   - TOPIC_CHAT_ID          chat_id текущего топика
 *   - TOPIC_THREAD_ID        thread_id текущего топика ("" = general)
 *
 * Стек: stdio JSON-RPC 2.0, MCP 2024-11-05, без внешних SDK.
 */

const ROUTER_URL = process.env.ROUTER_INTERNAL_URL || "http://127.0.0.1:7885";
const CURRENT_CHAT_ID = process.env.TOPIC_CHAT_ID || "";
const CURRENT_THREAD_ID_RAW = process.env.TOPIC_THREAD_ID || "";

function log(...args: any[]): void {
  process.stderr.write("[mcp-router] " + args.map(a =>
    typeof a === "string" ? a : JSON.stringify(a)
  ).join(" ") + "\n");
}

const TOOLS = [
  {
    name: "trigger_topic",
    description:
      "Запустить spawn в другом топике с заданным текстом. Использует тот " +
      "же путь что Director auto-trigger / /loop. ВАЖНО: bot.api.sendMessage " +
      "в чужой топик НЕ запускает spawn там — только этот tool. Возвращает " +
      "сразу после ack, реальный ответ spawn'а появится в целевом топике.",
    inputSchema: {
      type: "object",
      properties: {
        topicKey: {
          type: "string",
          description:
            "Целевой топик в формате 'chatId:threadId'. Например " +
            "'-1001234567890:42' для соседнего проекта. Используй current_topic() " +
            "чтобы узнать свой собственный topicKey.",
        },
        text: {
          type: "string",
          description:
            "Текст user-message для spawn'а в целевом топике. Будет передан " +
            "как обычное сообщение пользователя — spawn видит его, читает " +
            "CHECKPOINT.md, выполняет.",
        },
      },
      required: ["topicKey", "text"],
    },
  },
  {
    name: "current_topic",
    description:
      "Вернуть topicKey текущего топика (тот в котором ты сейчас работаешь). " +
      "Формат 'chatId:threadId' или 'chatId:general' для приватки/general.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function toolTriggerTopic(args: any): Promise<any> {
  const topicKey = String(args?.topicKey ?? "").trim();
  const text = String(args?.text ?? "").trim();
  if (!topicKey) return { error: "topicKey is required" };
  if (!text) return { error: "text is required" };
  if (!/^-?\d+:(?:\d+|general)$/.test(topicKey)) {
    return { error: `bad topicKey shape: '${topicKey}', expected 'chatId:threadId' or 'chatId:general'` };
  }
  try {
    const resp = await fetch(`${ROUTER_URL}/internal/trigger`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.ROUTER_INTERNAL_SECRET ? { "x-router-internal-secret": process.env.ROUTER_INTERNAL_SECRET } : {}),
      },
      body: JSON.stringify({ topicKey, text }),
    });
    const body = await resp.text();
    if (!resp.ok) {
      return { error: `router HTTP ${resp.status}: ${body}` };
    }
    return { ok: true, topicKey, ackedAt: new Date().toISOString() };
  } catch (err) {
    return { error: `router unreachable at ${ROUTER_URL}: ${(err as Error).message}` };
  }
}

function toolCurrentTopic(): any {
  if (!CURRENT_CHAT_ID) {
    return { error: "TOPIC_CHAT_ID env not set — router did not inject topic context" };
  }
  const tid = CURRENT_THREAD_ID_RAW || "general";
  return { topicKey: `${CURRENT_CHAT_ID}:${tid}` };
}

function send(msg: any): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleRequest(req: any): Promise<any> {
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "router-mcp", version: "0.1.0" },
        },
      };
    }
    if (method === "notifications/initialized" || method === "initialized") {
      return null;
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      let result: any;
      switch (toolName) {
        case "trigger_topic":
          result = await toolTriggerTopic(args);
          break;
        case "current_topic":
          result = toolCurrentTopic();
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

let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk) => {
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
    const resp = await handleRequest(req);
    if (resp !== null) send(resp);
  }
});

process.stdin.on("end", () => {
  log("stdin closed, exiting");
  process.exit(0);
});

log(`started. router=${ROUTER_URL} current=${CURRENT_CHAT_ID}/${CURRENT_THREAD_ID_RAW || "general"}`);
