/**
 * RunnerClient — drop-in replacement for ProcessManager.
 *
 * Instead of spawning claude.exe directly, delegates to the
 * claude-runner sidecar daemon via HTTP + SSE. This lets
 * claude processes survive router restarts.
 *
 * Public API matches ProcessManager exactly so router.ts
 * can use either without changes.
 */

import { resolve, dirname } from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { cliModelArg, SPAWN_MCP_CONFIG, type Settings } from "./config";
import type { AccountManager } from "./account-manager";
import { resolveTopicMcpConfig } from "./browser-pool-client";
import { buildProviderEnv, executorOfSession, type ProviderConfig } from "./providers";

/** Provider of a topic for the next spawn; undefined = claude (default path). */
export type ProviderResolver = (topicKey: string) => { provider: ProviderConfig; key?: string } | undefined;

const RC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ProcessStatus {
  active: boolean;
  startedAt: number | null;
  lastEventAt: number | null;
  stepCount: number;
  currentTool: string | null;
  toolDetail: string | null;
}

export interface ProgressEvent {
  type: string;
  toolName?: string;
  toolDetail?: string;
  stepCount: number;
  startedAt: number;
  lastEventAt: number;
}

interface TopicState {
  topicKey: string;
  projectPath: string;
  sessionId: string;
  active: boolean;
  startedAt: number | null;
  lastEventAt: number | null;
  stepCount: number;
  currentTool: string | null;
  toolDetail: string | null;
  lastActivity: number;
}

export class RunnerClient {
  private settings: Settings;
  private accounts: AccountManager | null;
  private onCleanup?: (topicKey: string) => void;
  private topicState = new Map<string, TopicState>();
  private topicQueues = new Map<string, Promise<unknown>>();
  private cachedPort: number | null = null;
  private portFileLastCheck = 0;
  private providerResolver: ProviderResolver | null = null;

  constructor(settings: Settings, accounts?: AccountManager) {
    this.settings = settings;
    this.accounts = accounts ?? null;
  }

  /**
   * Resolve runner URL dynamically.
   * Re-reads .runner.port file every 5 seconds (cheap fs read) so the router
   * automatically picks up port changes when the runner restarts on a different port.
   * This fixes the race condition where router starts before runner writes .port.
   */
  private get runnerUrl(): string {
    const now = Date.now();
    if (!this.cachedPort || now - this.portFileLastCheck > 5000) {
      this.cachedPort = this.resolveRunnerPort(this.settings);
      this.portFileLastCheck = now;
    }
    return `http://127.0.0.1:${this.cachedPort}`;
  }

  private resolveRunnerPort(settings: Settings): number {
    const portFile = resolve(RC_ROOT, "runner", "data", ".runner.port");
    try {
      if (existsSync(portFile)) {
        const filePort = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
        if (!isNaN(filePort) && filePort > 0) return filePort;
      }
    } catch {}
    return (settings as any).runner?.port || 7878;
  }

  /** Router tells which provider a topic uses (see providers.ts). */
  setProviderResolver(resolver: ProviderResolver): void {
    this.providerResolver = resolver;
  }

  setCleanupCallback(callback: (topicKey: string) => void): void {
    this.onCleanup = callback;
  }

  /**
   * Send a message to Claude via the runner sidecar.
   * Same signature as ProcessManager.sendMessage.
   */
  async sendMessage(
    topicKey: string,
    projectPath: string,
    message: string,
    sessionId?: string,
    onData?: (chunk: string, accumulated: string) => void,
    model?: string,
    appendSystemPrompt?: string,
    onProgress?: (ev: ProgressEvent) => void,
    onMessageBlock?: (text: string) => void,
    effort?: string
  ): Promise<string> {
    // Per-topic serialized queue (same pattern as ProcessManager)
    const prev = this.topicQueues.get(topicKey) ?? Promise.resolve();
    const task = prev.then(
      () => this.runOne(topicKey, projectPath, message, sessionId, onData, model, appendSystemPrompt, onProgress, onMessageBlock, effort),
      () => this.runOne(topicKey, projectPath, message, sessionId, onData, model, appendSystemPrompt, onProgress, onMessageBlock, effort)
    );
    this.topicQueues.set(topicKey, task.catch(() => {}));
    return task;
  }

  getStatus(topicKey: string): ProcessStatus {
    const state = this.topicState.get(topicKey);
    if (!state) {
      return { active: false, startedAt: null, lastEventAt: null, stepCount: 0, currentTool: null, toolDetail: null };
    }
    return {
      active: state.active,
      startedAt: state.startedAt,
      lastEventAt: state.lastEventAt,
      stepCount: state.stepCount,
      currentTool: state.currentTool,
      toolDetail: state.toolDetail,
    };
  }

  getSessionId(topicKey: string): string | undefined {
    const id = this.topicState.get(topicKey)?.sessionId;
    return id || undefined;
  }

  getActiveCount(): number {
    return Array.from(this.topicState.values()).filter(s => s.active).length;
  }

  /**
   * Снимок активных топиков для /topics-отчёта.
   */
  listActive(): Array<{ topicKey: string; startedAt: number | null; lastEventAt: number | null; stepCount: number; currentTool: string | null; toolDetail: string | null }> {
    const out: Array<{ topicKey: string; startedAt: number | null; lastEventAt: number | null; stepCount: number; currentTool: string | null; toolDetail: string | null }> = [];
    for (const [key, s] of this.topicState) {
      if (!s.active) continue;
      out.push({
        topicKey: key,
        startedAt: s.startedAt,
        lastEventAt: s.lastEventAt,
        stepCount: s.stepCount,
        currentTool: s.currentTool,
        toolDetail: s.toolDetail,
      });
    }
    return out;
  }

  /**
   * Убить все активные задачи разом. Возвращает число убитых.
   * В sidecar-режиме фактически шлёт runner'у cancel для каждой job.
   */
  killAll(): number {
    let count = 0;
    const keys = Array.from(this.topicState.keys());
    for (const key of keys) {
      if (this.killTopic(key)) count++;
    }
    return count;
  }

  killTopic(topicKey: string): boolean {
    const state = this.topicState.get(topicKey);
    if (!state) return false;
    // Cancel runner jobs only if there are active ones — но state ВСЕГДА
    // удаляем. Иначе после смерти claude (с 400 / TTL / crash) state.active
    // = false, прежний guard `if (!state.active) return false` оставлял
    // кэш sessionId в topicState, и /reset не работал — getSessionId
    // продолжал отдавать мёртвую UUID, следующее сообщение её --resume-ило.
    // 2026-04-30: e592b91b-сессия залипла в HSE Petersburg именно так.
    const wasActive = state.active === true;
    if (wasActive) {
      this.cancelTopicJobs(topicKey).catch(() => {});
      state.active = false;
    }
    this.topicState.delete(topicKey);
    this.topicQueues.delete(topicKey);
    this.onCleanup?.(topicKey);
    return wasActive;
  }

  shutdown(): void {
    // Cancel all active topics
    for (const [key] of this.topicState) {
      this.killTopic(key);
    }
  }

  // ─── Internal ───────────────────────────────────────────────

  private async runOne(
    topicKey: string,
    projectPath: string,
    message: string,
    sessionId?: string,
    onData?: (chunk: string, accumulated: string) => void,
    model?: string,
    appendSystemPrompt?: string,
    onProgress?: (ev: ProgressEvent) => void,
    onMessageBlock?: (text: string) => void,
    effort?: string
  ): Promise<string> {
    const effectiveModel = model || this.settings.processes.defaultModel;

    // Build environment (same logic as ProcessManager.executeCommand)
    const isApiKey = this.accounts?.isApiKeyAccount() ?? false;
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "ANTHROPIC_API_KEY" && !isApiKey) continue;
      if (v !== undefined) cleanEnv[k] = v;
    }

    // Multi-account: OAuth или API-ключ активного слота
    if (this.accounts) {
      Object.assign(cleanEnv, this.accounts.getSpawnEnv());
    }

    // Topic context for MCP servers
    const tkParts = topicKey.split(":");
    if (tkParts.length >= 2) {
      cleanEnv.TOPIC_CHAT_ID = tkParts[0];
      cleanEnv.TOPIC_THREAD_ID = tkParts[1] === "general" ? "" : tkParts[1];
    }
    cleanEnv.REMINDERS_JSON_PATH = resolve(RC_ROOT, "config", "reminders.json");

    // Truncate appendSystemPrompt to safe length
    let safePrompt = appendSystemPrompt;
    if (safePrompt && safePrompt.length > 6000) {
      safePrompt = safePrompt.slice(0, 6000) + "\n...(обрезано)";
    }

    // Determine session ID (same validation as ProcessManager)
    const resumeId = isResumableSessionId(sessionId) ? sessionId : undefined;

    // Track topic state
    let state = this.topicState.get(topicKey);
    if (!state) {
      state = {
        topicKey,
        projectPath,
        sessionId: resumeId || "",
        active: false,
        startedAt: null,
        lastEventAt: null,
        stepCount: 0,
        currentTool: null,
        toolDetail: null,
        lastActivity: Date.now(),
      };
      this.topicState.set(topicKey, state);
    }
    state.lastActivity = Date.now();

    // Per-topic изоляция браузера (опционально, settings.browserPool.enabled).
    // Если включено — просим у broker'а изолированный playwright-MCP для этого
    // топика и пишем per-topic mcp-config. Любая ошибка/выключенный флаг →
    // null → откатываемся на статичный конфиг (текущее поведение). Так фича
    // не может уронить обычную работу бота.
    const STATIC_MCP_CONFIG = SPAWN_MCP_CONFIG;
    let mcpConfigPath = STATIC_MCP_CONFIG;
    try {
      const perTopic = await resolveTopicMcpConfig(topicKey, this.settings);
      if (perTopic) mcpConfigPath = perTopic;
    } catch {
      // оставляем статичный путь
    }

    // Non-claude provider (config/providers.json, /provider): opencode job.
    // Claude flags (--mcp-config, --effort) and model aliases do not apply;
    // env without router secrets, plus this provider key only.
    const resolved = this.providerResolver?.(topicKey);
    const provider = resolved && resolved.provider.executor !== "claude" ? resolved.provider : undefined;
    if (provider && provider.apiKeyEnv && !resolved!.key) {
      throw new Error(`Нет ключа провайдера "${provider.id}": ${provider.apiKeyEnv} не найден ни в keyFile (${provider.keyFile ?? "не задан"}), ни в окружении`);
    }

    // 1. POST /jobs to runner
    const jobRequest = provider ? {
      topicKey,
      projectPath,
      message,
      sessionId: executorOfSession(resumeId) === provider.executor ? resumeId : undefined,
      executor: provider.executor,
      executorPath: this.settings.processes.opencodePath,
      provider: {
        id: provider.id,
        name: provider.name,
        baseURL: provider.baseURL!,
        model: provider.model!,
        apiKeyEnv: provider.apiKeyEnv,
        npm: provider.npm,
      },
      appendSystemPrompt: safePrompt,
      // runner converts this claude-format file into opencode "mcp"
      mcpConfigPath,
      env: buildProviderEnv(cleanEnv, provider, resolved!.key),
      claudePath: "",
      idleTimeoutMinutes: this.settings.processes.idleTimeoutMinutes ?? 5,
    } : {
      topicKey,
      projectPath,
      message,
      sessionId: resumeId,
      // alias → то, что понимает claude CLI (пиннед-алиасы → точный slug)
      model: cliModelArg(effectiveModel),
      appendSystemPrompt: safePrompt,
      env: cleanEnv,
      flags: [
        ...this.settings.processes.defaultFlags,
        // Inject --mcp-config so spawned Claude sees Playwright + chrome-devtools
        // + reminder-mcp regardless of project. Without this, only projects with
        // a per-project entry in ~/.claude/.claude.json see those MCPs (verified
        // 2026-05-05: project-a saw playwright; project-b did
        // not). Dedicated config at ~/.claude/spawn-mcp-config.json.
        // mcpConfigPath = статичный конфиг ИЛИ per-topic (browserPool, см. выше).
        "--mcp-config", mcpConfigPath,
        // Per-topic thinking effort (/effort). Runner прокидывает flags в CLI
        // как есть, поэтому изменений на стороне runner не требуется.
        ...(effort ? ["--effort", effort] : []),
      ],
      claudePath: this.settings.processes.claudePath,
      idleTimeoutMinutes: this.settings.processes.idleTimeoutMinutes ?? 5,
    };

    let jobId: string;
    try {
      const resp = await fetch(`${this.runnerUrl}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jobRequest),
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Runner returned ${resp.status}: ${body}`);
      }

      const data = await resp.json() as { jobId: string; pid?: number };
      jobId = data.jobId;
    } catch (err) {
      throw new Error(`Failed to submit job to runner: ${err instanceof Error ? err.message : err}`);
    }

    // Update state
    state.active = true;
    state.startedAt = Date.now();
    state.lastEventAt = Date.now();
    state.stepCount = 0;
    state.currentTool = null;
    state.toolDetail = null;

    // 2. Connect to SSE stream
    return new Promise<string>((resolvePromise, reject) => {
      let assistantText = "";
      let resultText = "";
      let mcpRelayText = "";
      let detectedSessionId = "";
      let aborted = false;
      // Set true when claude-cli reports "No conversation found" for the
      // session we asked it to --resume. Caller (router/triggerTopic)
      // detects this via error.message and clears mapping.sessionId then
      // retries without --resume.
      let sessionGone = false;

      const controller = new AbortController();

      const connectSSE = (lastEventId?: string) => {
        const headers: Record<string, string> = {};
        if (lastEventId) {
          headers["Last-Event-ID"] = lastEventId;
        }

        fetch(`${this.runnerUrl}/jobs/${jobId}/events`, {
          headers,
          signal: controller.signal,
        }).then(async (resp) => {
          if (!resp.ok || !resp.body) {
            reject(new Error(`SSE connection failed: ${resp.status}`));
            return;
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let currentEventId = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buf += decoder.decode(value, { stream: true });

            // Parse SSE frames
            const frames = buf.split("\n\n");
            buf = frames.pop() || ""; // last might be incomplete

            for (const frame of frames) {
              if (!frame.trim()) continue;

              const lines = frame.split("\n");
              let eventType = "";
              let data = "";
              let id = "";

              for (const line of lines) {
                if (line.startsWith("event: ")) eventType = line.slice(7);
                else if (line.startsWith("data: ")) data = line.slice(6);
                else if (line.startsWith("id: ")) id = line.slice(4);
                else if (line.startsWith(":")) continue; // comment/ping
              }

              if (id) currentEventId = id;

              if (eventType === "stream-json" && data) {
                try {
                  const event = JSON.parse(data);
                  const chunkText = this.handleStreamEvent(
                    event, state!, onProgress,
                    (sid) => { detectedSessionId = sid; }
                  );
                  if (chunkText) {
                    assistantText += chunkText;
                    if (onData) {
                      try { onData(chunkText, assistantText); } catch {}
                    }
                    // One assistant event = one logical reply block.
                    // Emit onMessageBlock so router can send each block
                    // as a separate Telegram message. Before this fix
                    // only resultText (the LAST text block before
                    // end_turn) reached TG. Sport incident 2026-05-22:
                    // real answer was at stdout line 115, but lost
                    // because line 119 ("both images deployed") was
                    // the resultText.
                    if (onMessageBlock) {
                      try { onMessageBlock(chunkText); } catch {}
                    }
                  }
                  // Capture result text
                  if (event.type === "result" && typeof event.result === "string") {
                    resultText = event.result;
                  }
                  // Detect "session gone" error from claude-cli. Happens when
                  // claude-cli's local session storage no longer has the
                  // session we asked it to --resume (TTL expired, storage
                  // wiped, etc). Without auto-clear, every retry crashes
                  // with same exit=1. Strip sessionId from in-memory state
                  // so the next message starts a fresh session.
                  if (event.type === "result"
                      && event.subtype === "error_during_execution"
                      && Array.isArray(event.errors)) {
                    const noConv = event.errors.some((e: unknown) =>
                      typeof e === "string" && e.includes("No conversation found"),
                    );
                    if (noConv) {
                      sessionGone = true;
                      if (state) {
                        console.warn(
                          `[runner-client] session-gone for ${topicKey}: clearing in-memory sessionId so next message starts fresh`,
                        );
                        state.sessionId = "";
                      }
                      detectedSessionId = "";
                    }
                  }
                  // Capture MCP relay text (defence-in-depth)
                  if (event.type === "assistant" && event.message?.content) {
                    for (const block of event.message.content) {
                      if (block?.type === "tool_use" &&
                          (block.name === "mcp__plugin_telegram_telegram__reply" ||
                           block.name === "mcp__plugin_telegram_telegram__edit_message")) {
                        const txt = block.input?.text;
                        if (typeof txt === "string" && txt.trim()) {
                          mcpRelayText = (mcpRelayText ? mcpRelayText + "\n\n" : "") + txt.trim();
                        }
                      }
                    }
                  }
                } catch {}
              }

              if (eventType === "completed" && data) {
                try {
                  const completion = JSON.parse(data);
                  if (completion.sessionId) {
                    detectedSessionId = completion.sessionId;
                  }

                  state!.active = false;
                  if (detectedSessionId) {
                    state!.sessionId = detectedSessionId;
                  }

                  const finalText = (resultText || assistantText || mcpRelayText).trim();
                  const exitCode = completion.exitCode;
                  const jobState = completion.state;

                  if ((exitCode === 0 || exitCode === undefined) && finalText) {
                    resolvePromise(finalText);
                  } else if (finalText) {
                    resolvePromise(finalText);
                  } else if (jobState === "timeout") {
                    reject(new Error(`Claude Code idle timeout (${jobRequest.idleTimeoutMinutes} min)`));
                  } else if (exitCode === 0 || exitCode === undefined) {
                    // Silent success: claude finished cleanly but produced no text
                    // (likely only tool_use blocks, no final assistant message).
                    // Don't propagate as error — reply with a soft "done" instead.
                    resolvePromise("[задача выполнена, без текстового ответа — проверь файлы / git log]");
                  } else if (sessionGone) {
                    // Tag the error so router can match by message and
                    // clear mapping.sessionId in topics.json. Without this,
                    // the dead sessionId persists across router restarts
                    // and every retry crashes with the same error.
                    reject(new Error(`Claude session gone: --resume target not found in claude-cli storage (sessionId expired or wiped)`));
                  } else {
                    reject(new Error(`Claude exited with code ${exitCode}`));
                  }
                  return;
                } catch {}
              }
            }
          }

          // Stream ended without completion event — might be a disconnect
          if (!aborted) {
            // Try to get final status from runner
            try {
              const statusResp = await fetch(`${this.runnerUrl}/jobs/${jobId}`);
              if (statusResp.ok) {
                const status = await statusResp.json() as any;
                if (status.state === "completed" || status.state === "failed") {
                  state!.active = false;
                  if (status.sessionId) state!.sessionId = status.sessionId;
                  const finalText = (resultText || assistantText).trim();
                  if (finalText) {
                    resolvePromise(finalText);
                  } else if (status.exitCode === 0 || status.exitCode == null) {
                    // Silent success on disconnect-recovery path
                    resolvePromise("[задача выполнена, без текстового ответа — проверь файлы / git log]");
                  } else {
                    reject(new Error(`Claude exited with code ${status.exitCode}`));
                  }
                  return;
                }
              }
            } catch {}

            // Reconnect with last event ID
            setTimeout(() => connectSSE(currentEventId), 500);
          }
        }).catch((err) => {
          if (aborted) return;
          // Connection error — retry
          setTimeout(() => connectSSE(lastEventId), 1000);
        });
      };

      connectSSE();

      // Safety timeout: match ProcessManager's behavior
      // RunnerClient itself doesn't enforce idle timeout (runner does),
      // but we need a reasonable max wait to not hang forever.
      // 30 minutes seems reasonable for very long agentic tasks.
      const safetyTimeout = setTimeout(() => {
        aborted = true;
        controller.abort();
        state!.active = false;
        const finalText = (resultText || assistantText).trim();
        if (finalText) {
          resolvePromise(finalText);
        } else {
          reject(new Error("RunnerClient safety timeout (30 min)"));
        }
      }, 30 * 60 * 1000);

      // Clean up timeout on resolve/reject
      const origResolve = resolvePromise;
      const origReject = reject;
      // Promise-resolve typed signature is `value: string | PromiseLike<string>` —
      // we forward both branches verbatim, the safety wrapper only adds cleanup.
      resolvePromise = (val: string | PromiseLike<string>) => {
        clearTimeout(safetyTimeout);
        aborted = true;
        controller.abort();
        origResolve(val);
      };
      reject = (err: Error) => {
        clearTimeout(safetyTimeout);
        aborted = true;
        controller.abort();
        origReject(err);
      };
    });
  }

  /**
   * Process a single stream-json event. Returns assistant text chunk
   * (empty string if none). Mirrors ProcessManager.handleEvent logic.
   */
  private handleStreamEvent(
    event: any,
    state: TopicState,
    onProgress?: (ev: ProgressEvent) => void,
    onSessionId?: (id: string) => void,
  ): string {
    if (!event || typeof event !== "object") return "";

    state.lastEventAt = Date.now();
    state.stepCount += 1;

    let chunkText = "";
    let progressToolName: string | undefined;
    let progressToolDetail: string | undefined;

    // Session ID
    if (typeof event.session_id === "string" && executorOfSession(event.session_id)) {
      onSessionId?.(event.session_id);
    }

    // Assistant text + tool_use
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          chunkText += block.text;
        } else if (block?.type === "tool_use" && typeof block.name === "string") {
          state.currentTool = block.name;
          progressToolName = block.name;

          const input = block.input;
          let detail = "";
          if (input && typeof input === "object") {
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
          }
          if (detail.length > 60) detail = detail.slice(0, 57) + "...";
          state.toolDetail = detail || null;
          progressToolDetail = detail || undefined;
        }
      }
    }

    // Progress callback
    if (onProgress) {
      try {
        onProgress({
          type: typeof event.type === "string" ? event.type : "unknown",
          toolName: progressToolName,
          toolDetail: progressToolDetail,
          stepCount: state.stepCount,
          startedAt: state.startedAt!,
          lastEventAt: state.lastEventAt!,
        });
      } catch {}
    }

    return chunkText;
  }

  /**
   * Cancel all active runner jobs for a topic.
   */
  private async cancelTopicJobs(topicKey: string): Promise<void> {
    try {
      const resp = await fetch(`${this.runnerUrl}/jobs?active=true&topicKey=${encodeURIComponent(topicKey)}`);
      if (!resp.ok) return;
      const data = await resp.json() as { jobs: Array<{ jobId: string }> };
      for (const job of data.jobs) {
        await fetch(`${this.runnerUrl}/jobs/${job.jobId}`, { method: "DELETE" }).catch(() => {});
      }
    } catch {}
  }
}

/** claude UUID or opencode ses_*; the runner re-checks per executor. */
function isResumableSessionId(id: string | undefined): id is string {
  return executorOfSession(id) !== undefined;
}
