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
    if (typeof raw.session_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.session_id)) {
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
          // Extract short detail from input
          const input = block.input;
          if (input && typeof input === "object") {
            let detail = "";
            if (typeof input.command === "string") detail = input.command;
            else if (typeof input.file_path === "string") detail = input.file_path;
            else if (typeof input.path === "string") detail = input.path;
            else if (typeof input.url === "string") detail = input.url;
            else if (typeof input.query === "string") detail = input.query;
            else {
              for (const k of Object.keys(input)) {
                if (typeof (input as any)[k] === "string") {
                  detail = (input as any)[k];
                  break;
                }
              }
            }
            if (detail.length > 60) detail = detail.slice(0, 57) + "...";
            parsed.toolDetail = detail || undefined;
          }
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
