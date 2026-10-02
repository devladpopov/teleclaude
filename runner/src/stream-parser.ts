/**
 * Parse stream-json events from claude CLI (NOT Anthropic API format).
 *
 * Claude CLI `--output-format stream-json` emits newline-delimited JSON
 * with these event types:
 *   - type: "init"      → { session_id }
 *   - type: "assistant"  → { message: { content: [{ type: "text", text }, { type: "tool_use", name, input }] } }
 *   - type: "result"     → { result: "final text", session_id }
 *   - type: "tool_result" etc.
 */

export interface ParsedEvent {
  raw: Record<string, unknown>;
  type: string;
  sessionId?: string;
  toolName?: string;
  toolDetail?: string;
  assistantText?: string;
  resultText?: string;
  isResult: boolean;
}

/**
 * Session ids differ per executor: claude uses UUIDs, opencode uses
 * "ses_<base62>". Anything else is rejected so garbage never reaches
 * --resume / --session.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]{8,64}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && (UUID_RE.test(id) || OPENCODE_SESSION_RE.test(id));
}

/** Short human-readable detail of a tool call input (first meaningful string). */
export function toolDetailFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  let detail = "";
  for (const k of ["command", "file_path", "filePath", "path", "url", "query", "pattern"]) {
    if (typeof obj[k] === "string") { detail = obj[k] as string; break; }
  }
  if (!detail) {
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === "string") { detail = obj[k] as string; break; }
    }
  }
  if (detail.length > 60) detail = detail.slice(0, 57) + "...";
  return detail || undefined;
}

export function parseStreamJsonEvent(jsonLine: string): ParsedEvent | null {
  try {
    const raw = JSON.parse(jsonLine);
    if (!raw || typeof raw !== "object") return null;

    const type = typeof raw.type === "string" ? raw.type : "unknown";

    const parsed: ParsedEvent = {
      raw,
      type,
      isResult: type === "result",
    };

    // Session ID — can appear in init, result, or other events
    if (isValidSessionId(raw.session_id)) {
      parsed.sessionId = raw.session_id;
    }

    // Assistant message content blocks
    if (type === "assistant" && raw.message?.content && Array.isArray(raw.message.content)) {
      for (const block of raw.message.content) {
        if (!block || typeof block !== "object") continue;

        if (block.type === "text" && typeof block.text === "string") {
          parsed.assistantText = (parsed.assistantText || "") + block.text;
        }

        if (block.type === "tool_use" && typeof block.name === "string") {
          parsed.toolName = block.name;
          parsed.toolDetail = toolDetailFromInput(block.input);
        }
      }
    }

    // Result event — final text
    if (type === "result" && typeof raw.result === "string") {
      parsed.resultText = raw.result;
    }

    return parsed;
  } catch {
    return null;
  }
}
