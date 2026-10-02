import { join } from "path";
import { isValidSessionId, toolDetailFromInput } from "../stream-parser.ts";
import type { ParsedEvent } from "../stream-parser.ts";
import type { JobRequest } from "../types.ts";
import type { Executor, ExecutorLaunch, LineParser } from "./types.ts";

/**
 * OpenCode CLI (https://opencode.ai): `opencode run --format json`.
 *
 * Works with any OpenAI-compatible provider. The runner keeps the router
 * protocol unchanged: every opencode event is converted into the same
 * shape as claude stream-json (system/init, assistant, result), so the
 * router, the Director and the rate-limit logic see one format.
 *
 * Mapping (opencode 1.18, see runner/test/fixtures/opencode):
 *   step_start (first)        -> {type:"system", subtype:"init", session_id}
 *   text                      -> {type:"assistant", message.content:[text]}
 *   tool_use                  -> {type:"assistant", message.content:[tool_use]}
 *   step_finish reason!=tool  -> {type:"result", subtype:"success", result}
 *   error                     -> {type:"result", subtype:"error_during_execution"}
 *   runner_exit (synthetic)   -> error result if no result was emitted;
 *                                "Session not found" becomes the claude
 *                                "No conversation found" so the router
 *                                drops the dead session id.
 */

const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]{8,64}$/;
const SYSTEM_PROMPT_FILE = "system-prompt.md";

export function buildOpencodeConfig(request: JobRequest, jobDir: string): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};

  if (request.appendSystemPrompt) {
    // opencode has no --append-system-prompt; "instructions" files are
    // added to the system prompt next to AGENTS.md of the project.
    config.instructions = [join(jobDir, SYSTEM_PROMPT_FILE).replace(/\\/g, "/")];
  }

  const p = request.provider;
  if (p) {
    const options: Record<string, unknown> = { baseURL: p.baseURL };
    // The key is referenced, never inlined: it lives only in the job env.
    if (p.apiKeyEnv) options.apiKey = `{env:${p.apiKeyEnv}}`;
    config.provider = {
      [p.id]: {
        npm: p.npm || "@ai-sdk/openai-compatible",
        name: p.name || p.id,
        options,
        models: { [p.model]: { name: p.model, tool_call: true } },
      },
    };
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

export const opencodeExecutor: Executor = {
  id: "opencode",

  launch(request, jobDir): ExecutorLaunch {
    const args: string[] = [
      request.executorPath || "opencode",
      "run",
      "--format",
      "json",
      // Same trust level as claude --dangerously-skip-permissions:
      // headless, nobody to answer a permission prompt.
      "--auto",
    ];

    const model = request.provider
      ? `${request.provider.id}/${request.provider.model}`
      : request.model && request.model.includes("/") ? request.model : undefined;
    if (model) args.push("--model", model);

    // A claude UUID must never reach opencode (and vice versa): the router
    // keeps one session id per (topic, executor), this is the last guard.
    if (request.sessionId && OPENCODE_SESSION_RE.test(request.sessionId)) {
      args.push("--session", request.sessionId);
    }

    const files: Record<string, string> = {};
    if (request.appendSystemPrompt) files[SYSTEM_PROMPT_FILE] = request.appendSystemPrompt;

    const env: Record<string, string> = {};
    const config = buildOpencodeConfig(request, jobDir);
    if (config) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

    return { args, env, files, exitEvent: true };
  },

  createParser(): LineParser {
    return createOpencodeParser();
  },
};

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function createOpencodeParser(): LineParser {
  let initSent = false;
  let resultSent = false;
  let sessionId: string | undefined;
  const textByMessage = new Map<string, string>();

  const make = (raw: Record<string, unknown>, extra: Partial<ParsedEvent> = {}): ParsedEvent => {
    if (sessionId) raw.session_id = sessionId;
    return {
      raw,
      type: typeof raw.type === "string" ? raw.type : "unknown",
      sessionId,
      isResult: raw.type === "result",
      ...extra,
    };
  };

  const errorResult = (text: string, errors: string[] = [text]): ParsedEvent => {
    resultSent = true;
    return make(
      { type: "result", subtype: "error_during_execution", is_error: true, result: text, errors },
      { resultText: text },
    );
  };

  return (jsonLine: string): ParsedEvent | null => {
    let ev: any;
    try {
      ev = JSON.parse(jsonLine);
    } catch {
      return null;
    }
    if (!ev || typeof ev !== "object") return null;

    if (isValidSessionId(ev.sessionID)) sessionId = ev.sessionID;
    const part = ev.part && typeof ev.part === "object" ? ev.part : {};

    switch (ev.type) {
      case "step_start":
        if (!initSent) {
          initSent = true;
          return make({ type: "system", subtype: "init", executor: "opencode" });
        }
        return make({ type: "system", subtype: "step_start" });

      case "text": {
        const text = typeof part.text === "string" ? part.text : "";
        if (typeof part.messageID === "string") {
          textByMessage.set(part.messageID, (textByMessage.get(part.messageID) || "") + text);
        }
        return make(
          { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
          { assistantText: text },
        );
      }

      case "tool_use": {
        const name = typeof part.tool === "string" ? part.tool : "tool";
        const input = part.state?.input ?? {};
        return make(
          {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "tool_use", id: part.callID, name, input }] },
          },
          { toolName: name, toolDetail: toolDetailFromInput(input) },
        );
      }

      case "step_finish": {
        const tokens = part.tokens || {};
        const usage = { input_tokens: tokens.input ?? 0, output_tokens: tokens.output ?? 0 };
        if (part.reason === "tool-calls") {
          return make({ type: "system", subtype: "step_finish", usage });
        }
        const text = textByMessage.get(part.messageID) || "";
        resultSent = true;
        return make(
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: text,
            usage,
            total_cost_usd: typeof part.cost === "number" ? part.cost : 0,
            stop_reason: part.reason,
          },
          { resultText: text },
        );
      }

      case "error": {
        const err = ev.error || {};
        const msg = String(err.data?.message || err.message || err.name || "unknown error");
        const status = err.data?.statusCode;
        // "API Error: 429 ..." matches the router rate-limit detector,
        // so the Director pauses the same way as for claude.
        const text = status ? `API Error: ${status} ${msg}` : `${err.name || "Error"}: ${msg}`;
        return errorResult(text);
      }

      case "runner_exit": {
        const stderr = stripAnsi(String(ev.stderr || "")).trim();
        if (resultSent) {
          return make({ type: "system", subtype: "exit", code: ev.code });
        }
        if (/session not found/i.test(stderr)) {
          return errorResult(`opencode: ${stderr}`, [`No conversation found (opencode: ${stderr})`]);
        }
        return errorResult(`opencode exited with code ${ev.code}${stderr ? `: ${stderr.slice(-500)}` : ""}`);
      }

      default:
        // Unknown/new event types pass through untouched (router ignores them).
        return make({ ...ev });
    }
  };
}
