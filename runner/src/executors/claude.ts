import { parseStreamJsonEvent } from "../stream-parser.ts";
import type { Executor } from "./types.ts";

/** Claude Code CLI: `claude -p --output-format stream-json`. Default executor. */
export const claudeExecutor: Executor = {
  id: "claude",

  launch(request) {
    const args: string[] = [
      request.claudePath,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      request.model || "opus",
    ];

    if (request.sessionId) {
      args.push("--resume", request.sessionId);
    }

    if (request.appendSystemPrompt) {
      args.push("--append-system-prompt", request.appendSystemPrompt);
    }

    if (request.flags && request.flags.length > 0) {
      args.push(...request.flags);
    }

    args.push("--dangerously-skip-permissions");

    return { args };
  },

  createParser() {
    return parseStreamJsonEvent;
  },
};
