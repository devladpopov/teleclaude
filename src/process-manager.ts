import { spawn, execSync, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { cliModelArg, mcpConfigFlags, type Settings } from "./config";
import type { AccountManager } from "./account-manager";

const PM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Проверяем, есть ли у процесса с PID дочерние процессы (Windows).
 * Если есть — значит claude.exe выполняет bash/node/git команду,
 * и убивать по idle не надо.
 * Возвращает массив имён дочерних процессов или [] если нет.
 */
function getChildProcessNames(pid: number): string[] {
  try {
    const out = execSync(
      `wmic process where "ParentProcessId=${pid}" get Name /format:csv 2>nul`,
      { timeout: 3000, encoding: "utf-8", windowsHide: true }
    );
    // CSV: Node,Name\r\n<hostname>,cmd.exe\r\n...
    const names: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Node,") || trimmed === "") continue;
      const parts = trimmed.split(",");
      if (parts.length >= 2 && parts[1]) names.push(parts[1]);
    }
    return names;
  } catch {
    return []; // если wmic упал — считаем что детей нет
  }
}

/**
 * Резюмировать сессию через `claude --resume <id>` можно только если у
 * нас настоящий id от claude (UUID-подобная строка). Локальные id из
 * старой архитектуры (`topic-<ts>-<rand>`) нерезюмируемы — мы их
 * игнорируем и стартуем новую сессию, чтобы не было кросс-контаминации
 * с тем, что выдаёт `--continue`.
 */
export function isResumableSessionId(id: string | undefined): id is string {
  if (!id) return false;
  // claude session id выглядит как 8-4-4-4-12 hex (UUID v4)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Описание текущей активности процесса для /alive и heartbeat.
 * Поля обновляются на каждом stream-json событии от claude.
 */
export interface ProcessStatus {
  active: boolean;
  startedAt: number | null;     // ms epoch старта текущего spawn
  lastEventAt: number | null;   // ms epoch последнего stream-json события
  stepCount: number;            // сколько событий прилетело за этот spawn
  currentTool: string | null;   // последний tool_use, например "Bash" или "mcp__figma__create_frame"
  toolDetail: string | null;    // короткое описание (первый аргумент tool_use)
}

interface ManagedProcess {
  topicKey: string;
  projectPath: string;
  process: ChildProcess | null;
  sessionId: string;
  lastActivity: number;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  // Watchdog & status (обновляются в handleEvent на каждом событии)
  startedAt: number | null;
  lastEventAt: number | null;
  stepCount: number;
  currentTool: string | null;
  toolDetail: string | null;
  pendingResolves: Array<{
    resolve: (output: string) => void;
    reject: (error: Error) => void;
  }>;
}

/**
 * Событие прогресса для роутера. Шлётся на каждое stream-json событие.
 * Роутер использует это для heartbeat editMessage и /alive.
 */
export interface ProgressEvent {
  type: string;                 // тип stream-json события
  toolName?: string;            // если это tool_use
  toolDetail?: string;          // короткое описание input
  stepCount: number;
  startedAt: number;
  lastEventAt: number;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private settings: Settings;
  private accounts: AccountManager | null;
  private onCleanup?: (topicKey: string) => void;
  // Per-topic serialized queue: ensures messages within one topic run
  // strictly in order, so concurrent --resume on the same session never
  // happens. Different topics still run in parallel.
  // Inspired by claudeclaw's enqueue(threadId) pattern.
  private topicQueues = new Map<string, Promise<unknown>>();

  constructor(settings: Settings, accounts?: AccountManager) {
    this.settings = settings;
    this.accounts = accounts ?? null;
  }

  /**
   * Register a callback to run when a process is cleaned up (TTL expired, etc.)
   */
  setCleanupCallback(callback: (topicKey: string) => void): void {
    this.onCleanup = callback;
  }

  /**
   * Send a message to a Claude Code process for a given topic.
   * Spawns a new process per message using `claude -p` with --resume for continuity.
   *
   * appendSystemPrompt — текст, который будет передан claude через
   *   `--append-system-prompt` НА КАЖДЫЙ вызов. Сюда роутер кладёт
   *   слепок памяти (SOUL.md + topic-memory.md + main-memory.md +
   *   границы проекта). Это нужно потому, что `--append-system-prompt`
   *   не сохраняется при `--resume`, и иначе личность/память живут
   *   только в первой реплике сессии.
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
    // Per-topic serialized queue.
    const prev = this.topicQueues.get(topicKey) ?? Promise.resolve();
    const task = prev.then(
      () => this.runOne(topicKey, projectPath, message, sessionId, onData, model, appendSystemPrompt, onProgress, onMessageBlock, effort),
      () => this.runOne(topicKey, projectPath, message, sessionId, onData, model, appendSystemPrompt, onProgress, onMessageBlock, effort)
    );
    this.topicQueues.set(topicKey, task.catch(() => {}));
    return task;
  }

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
    // Check concurrent limit
    const activeCount = Array.from(this.processes.values()).filter(p => p.process !== null).length;
    if (activeCount >= this.settings.processes.maxConcurrent) {
      // Kill oldest idle process
      this.killOldestIdle();
    }

    const managed = this.getOrCreate(topicKey, projectPath, sessionId);
    managed.lastActivity = Date.now();
    this.resetTTL(managed);

    return this.executeCommand(managed, message, onData, model, appendSystemPrompt, onProgress, onMessageBlock, effort);
  }

  private getOrCreate(topicKey: string, projectPath: string, sessionId?: string): ManagedProcess {
    let managed = this.processes.get(topicKey);
    if (!managed) {
      // Принимаем sessionId извне, только если это РЕАЛЬНЫЙ claude id.
      // Иначе оставляем пустым — claude стартует новую сессию и пришлёт
      // нам свой настоящий id через stream-json.
      managed = {
        topicKey,
        projectPath,
        process: null,
        sessionId: isResumableSessionId(sessionId) ? sessionId : "",
        lastActivity: Date.now(),
        ttlTimer: null,
        startedAt: null,
        lastEventAt: null,
        stepCount: 0,
        currentTool: null,
        toolDetail: null,
        pendingResolves: [],
      };
      this.processes.set(topicKey, managed);
    } else if (!isResumableSessionId(managed.sessionId) && isResumableSessionId(sessionId)) {
      // Подтянуть валидный id, если он появился позже (например, был
      // сохранён в topics.json после прошлого запуска).
      managed.sessionId = sessionId;
    }
    return managed;
  }

  private async executeCommand(
    managed: ManagedProcess,
    message: string,
    onData?: (chunk: string, accumulated: string) => void,
    model?: string,
    appendSystemPrompt?: string,
    onProgress?: (ev: ProgressEvent) => void,
    onMessageBlock?: (text: string) => void,
    effort?: string
  ): Promise<string> {
    // Write message to temp file to avoid Windows command line length limits
    const tmpDir = resolve(managed.projectPath, ".tmp");
    mkdirSync(tmpDir, { recursive: true });
    const msgFile = join(tmpDir, `msg-${Date.now()}.txt`);
    writeFileSync(msgFile, message, "utf-8");

    // stream-json + --verbose даёт нам:
    //  - реальный session_id от claude (через init/result event)
    //  - живой стрим текста из assistant message events
    //  - стабильный хвост result event для финального ответа
    // Determine model: per-topic override > default from settings
    const effectiveModel = model || this.settings.processes.defaultModel;

    const args: string[] = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      // alias → то, что понимает claude CLI (пиннед-алиасы → точный slug)
      "--model", cliModelArg(effectiveModel),
    ];

    // Per-topic thinking effort (/effort в топике). Нет override — флаг
    // не передаём, CLI работает на своём дефолте (high).
    if (effort) args.push("--effort", effort);

    // Подключаем глобальный MCP-конфиг пользователя: ~/.claude/.claude.json
    // содержит зарегистрированные через `claude mcp add` серверы —
    // playwright (http://127.0.0.1:8931/mcp), chrome-devtools, reminder-mcp,
    // плюс все cloud-MCP. В print-mode (-p) claude по умолчанию НЕ
    // загружает глобальные серверы — нужен явный --mcp-config.
    // 2026-05-04: без этого флага spawned Claude в Telegram-топиках
    // не видел Playwright MCP, не мог делать визуальные проверки сайтов
    // (см. memory: feedback_critique_and_exceed → "verify de facto").
    // --mcp-config: dedicated file with playwright + chrome-devtools +
    // reminder-mcp. Without this, spawned Claude in projects without entry
    // in ~/.claude/.claude.json (e.g. project-b) sees ONLY
    // built-in tools — no browser_*, no MCP. Verified 2026-05-05: confirmed
    // empirically that project-a (which has per-project mcpServers entry
    // because Claude was opened there manually before) sees Playwright,
    // while project-b does not. Per-project user-scope
    // registration (`claude mcp add --scope user`) didn't propagate either.
    // Dedicated config file is the only reliable channel.
    //
    // The file is at ~/.claude/spawn-mcp-config.json. Edit it to add or
    // remove MCPs available to every spawned Claude. Skipped while the file
    // does not exist: claude refuses to start with a missing --mcp-config.
    args.push(...mcpConfigFlags());

    // Резюмируем сессию ТОЛЬКО если у нас настоящий session_id от claude
    // (UUID 8-4-4-4-12). Старые «topic-*» локальные id — это мусор от
    // прошлой архитектуры, их игнорируем. Если id невалиден — стартуем
    // новую сессию (без --resume и без --continue), чтобы избежать
    // кросс-контаминации, как было с `--continue`.
    if (isResumableSessionId(managed.sessionId)) {
      args.push("--resume", managed.sessionId);
    }

    // --append-system-prompt НА КАЖДЫЙ вызов — потому что claude его не
    // сохраняет между --resume. Сюда роутер кладёт SOUL/память/границы.
    // Передаём через переменную окружения, чтобы не упереться в лимит
    // длины командной строки Windows (~8K).
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };

    // Для apikey-аккаунтов НЕ удаляем ANTHROPIC_API_KEY — он будет подставлен
    // через getSpawnEnv(). Для остальных типов удаляем, чтобы CLI шёл через OAuth.
    if (!this.accounts?.isApiKeyAccount()) {
      delete cleanEnv.ANTHROPIC_API_KEY;
    }

    // Multi-account: подмешиваем OAuth-контекст (или API-ключ) активного слота.
    if (this.accounts) {
      Object.assign(cleanEnv, this.accounts.getSpawnEnv());
    }

    // Топик-контекст для дочерних MCP-серверов (например, reminder-mcp).
    // Парсим topicKey формата `<chatId>:<threadId>` или `<chatId>:general`.
    // MCP-tool `schedule_reminder` читает эти env-vars как defaults и
    // ставит напоминание прямо в этот топик без явного указания chatId.
    const tkParts = managed.topicKey.split(":");
    if (tkParts.length >= 2) {
      cleanEnv.TOPIC_CHAT_ID = tkParts[0];
      cleanEnv.TOPIC_THREAD_ID = tkParts[1] === "general" ? "" : tkParts[1];
    }
    // Путь к reminders.json — MCP-серверу нужно знать, куда писать.
    cleanEnv.REMINDERS_JSON_PATH = resolve(PM_ROOT, "config", "reminders.json");

    if (appendSystemPrompt && appendSystemPrompt.trim()) {
      // Передавать через arg рискованно (CMDLINE limit). Используем
      // подход через временный файл, который читаем потом из stdin
      // -- claude такого не умеет, поэтому всё-таки пробуем через arg,
      // но с обрезанием до безопасной длины 6000 символов.
      const safe = appendSystemPrompt.length > 6000
        ? appendSystemPrompt.slice(0, 6000) + "\n...(обрезано)"
        : appendSystemPrompt;
      args.push("--append-system-prompt", safe);
    }

    // Add default flags (e.g., --dangerously-skip-permissions)
    args.push(...this.settings.processes.defaultFlags);

    const claudePath = this.settings.processes.claudePath;

    // Reset per-spawn status (для /alive и heartbeat)
    managed.startedAt = Date.now();
    managed.lastEventAt = managed.startedAt;
    managed.stepCount = 0;
    managed.currentTool = null;
    managed.toolDetail = null;

    const idleMinutes = this.settings.processes.idleTimeoutMinutes ?? 5;
    const idleMs = idleMinutes * 60 * 1000;

    return new Promise<string>((resolvePromise, reject) => {
      let stderr = "";
      let assistantText = "";
      let mcpRelayText = ""; // накопленный текст ассистента (для UI)
      let resultText = "";    // финальный текст из result event
      let lineBuf = "";       // буфер незавершённой строки stream-json
      let detectedSessionId = "";
      let watchdog: ReturnType<typeof setInterval> | null = null;

      console.log(`[ProcessManager] Spawning: ${claudePath} ${args.length} args (message in ${msgFile}, ${message.length} chars), idle=${idleMinutes}min`);

      // ВАЖНО: shell:false. claudePath — полный путь к .exe, PATH-резолвер
      // не нужен. При shell:true Node склеивает args через cmd.exe, и
      // многострочный Cyrillic-текст в --append-system-prompt (с кавычками,
      // переводами строк, &, |) ломается. shell:false передаёт args напрямую
      // в CreateProcess, без cmd.exe-парсера.
      const proc = spawn(claudePath, args, {
        cwd: managed.projectPath,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      // Feed message via stdin
      proc.stdin?.write(message);
      proc.stdin?.end();

      managed.process = proc;

      const handleEvent = (event: any) => {
        if (!event || typeof event !== "object") return;

        // Каждое событие = признак жизни процесса. Сбрасываем idle-watchdog
        // и обновляем статус для /alive + heartbeat.
        managed.lastEventAt = Date.now();
        managed.stepCount += 1;

        let progressToolName: string | undefined;
        let progressToolDetail: string | undefined;

        // session_id может прийти в init и в result
        if (typeof event.session_id === "string" && /^[0-9a-f-]{16,}$/i.test(event.session_id)) {
          detectedSessionId = event.session_id;
        }

        // Streaming assistant text + tool_use tracking.
        // One assistant event = one logical reply block between tool
        // calls. Collect per-event text and emit onMessageBlock so the
        // router can send each block as a separate Telegram message.
        // Before this fix the router only sent resultText (the LAST
        // text block before end_turn), so intermediate replies got
        // lost. Sport incident 2026-05-22: real answer was at stdout
        // line 115, but resultText was line 119 ("Both images
        // deployed"), and only that landed in TG.
        if (event.type === "assistant" && event.message?.content) {
          let eventText = "";
          for (const block of event.message.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              assistantText += block.text;
              eventText += block.text;
              if (onData) {
                try { onData(block.text, assistantText); } catch {}
              }
            } else if (block?.type === "tool_use" && typeof block.name === "string") {
              managed.currentTool = block.name;
              progressToolName = block.name;
              // Короткая выжимка input — первое строковое поле или command
              const input = block.input;
              let detail = "";
              if (input && typeof input === "object") {
                if (typeof input.command === "string") detail = input.command;
                else if (typeof input.file_path === "string") detail = input.file_path;
                else if (typeof input.path === "string") detail = input.path;
                else if (typeof input.url === "string") detail = input.url;
                else if (typeof input.query === "string") detail = input.query;
                else {
                  // первый строковый field
                  for (const k of Object.keys(input)) {
                    if (typeof (input as any)[k] === "string") {
                      detail = (input as any)[k];
                      break;
                    }
                  }
                }
              }
              if (detail.length > 60) detail = detail.slice(0, 57) + "...";
              managed.toolDetail = detail || null;
              progressToolDetail = detail || undefined;

              // Legacy telegram-plugin MCP intercept: plugin telegram reply tool hijacks output.
              // Capture its text so the router can resend via grammy with correct
              // message_thread_id. Plugin itself should be uninstalled but this
              // is defence-in-depth in case it comes back.
              if (block.name === "mcp__plugin_telegram_telegram__reply" ||
                  block.name === "mcp__plugin_telegram_telegram__edit_message") {
                const txt = (input && typeof (input as any).text === "string")
                  ? (input as any).text as string
                  : "";
                if (txt.trim()) {
                  mcpRelayText = (mcpRelayText ? mcpRelayText + "\n\n" : "") + txt.trim();
                  console.warn(`[ProcessManager] WARN: claude used ${block.name} ` +
                    `instead of stdout. Capturing text as finalText. ` +
                    `Uninstall telegram@claude-plugins-official to prevent duplicates.`);
                }
              }
            }
          }
          // One assistant event with non-empty text => one TG message.
          if (eventText && onMessageBlock) {
            try { onMessageBlock(eventText); } catch {}
          }
        }

        // Final result event
        if (event.type === "result") {
          if (typeof event.result === "string") {
            resultText = event.result;
          }
        }

        if (onProgress) {
          try {
            onProgress({
              type: typeof event.type === "string" ? event.type : "unknown",
              toolName: progressToolName,
              toolDetail: progressToolDetail,
              stepCount: managed.stepCount,
              startedAt: managed.startedAt!,
              lastEventAt: managed.lastEventAt!,
            });
          } catch {}
        }
      };

      proc.stdout?.on("data", (data: Buffer) => {
        lineBuf += data.toString("utf-8");
        let idx: number;
        while ((idx = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, idx).trim();
          lineBuf = lineBuf.slice(idx + 1);
          if (!line) continue;
          try {
            handleEvent(JSON.parse(line));
          } catch {
            // не JSON — игнорируем (на всякий случай)
          }
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });

      proc.on("close", (code) => {
        managed.process = null;
        if (watchdog) { clearInterval(watchdog); watchdog = null; }

        // Обработать остаток буфера, если последняя строка без \n
        if (lineBuf.trim()) {
          try { handleEvent(JSON.parse(lineBuf.trim())); } catch {}
          lineBuf = "";
        }

        if (detectedSessionId) {
          managed.sessionId = detectedSessionId;
        }

        const finalText = (resultText || assistantText || mcpRelayText).trim();

        if (finalText) {
          resolvePromise(finalText);
        } else if (code === 0) {
          // Silent success: claude finished cleanly but produced no final text.
          // Reply with a soft "done" so router doesn't post an empty message.
          resolvePromise("[задача выполнена, без текстового ответа — проверь файлы / git log]");
        } else {
          reject(new Error(`Claude exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
        }
      });

      proc.on("error", (err) => {
        managed.process = null;
        if (watchdog) { clearInterval(watchdog); watchdog = null; }
        reject(err);
      });

      // Idle watchdog: убиваем процесс ТОЛЬКО если он действительно завис,
      // т.е. за idleMs не пришло НИ ОДНОГО stream-json события. Длинные
      // агентные задачи (Figma, многошаговые правки) теперь живут сколько
      // нужно, пока claude реально шлёт события.
      //
      // Доп. защита: перед kill проверяем дочерние процессы (node, git, etc).
      // Если claude.exe выполняет команду — сбрасываем таймер, не убиваем.
      watchdog = setInterval(() => {
        if (managed.process !== proc) {
          if (watchdog) { clearInterval(watchdog); watchdog = null; }
          return;
        }
        const since = Date.now() - (managed.lastEventAt ?? managed.startedAt ?? Date.now());
        if (since > idleMs) {
          // Перед тем как убивать — проверяем: может claude.exe
          // прямо сейчас выполняет длинную команду (node, git, python, etc.)
          const pid = proc.pid;
          if (pid) {
            const children = getChildProcessNames(pid);
            // Фильтруем служебные процессы, которые не означают "работу"
            const ignored = new Set(["conhost.exe"]);
            const activeChildren = children.filter(n => !ignored.has(n.toLowerCase()));
            if (activeChildren.length > 0) {
              console.log(
                `[ProcessManager] Idle ${Math.round(since / 1000)}s for ${managed.topicKey}, ` +
                `but has active children: [${activeChildren.join(", ")}]. ` +
                `Extending idle timer (not killing).`
              );
              // Сбрасываем таймер — дочерний процесс ещё работает
              managed.lastEventAt = Date.now();
              return;
            }
          }
          console.log(`[ProcessManager] Idle timeout (${idleMinutes}min, no events, no children) for ${managed.topicKey}, killing`);
          if (watchdog) { clearInterval(watchdog); watchdog = null; }
          proc.kill("SIGTERM");
          reject(new Error(`Claude Code idle timeout (${idleMinutes} min, ${managed.stepCount} событий до зависания)`));
        }
      }, 15 * 1000);
    });
  }

  /**
   * Снимок состояния процесса топика. Используется командой /alive
   * и heartbeat-логикой роутера.
   */
  getStatus(topicKey: string): ProcessStatus {
    const managed = this.processes.get(topicKey);
    if (!managed) {
      return { active: false, startedAt: null, lastEventAt: null, stepCount: 0, currentTool: null, toolDetail: null };
    }
    return {
      active: managed.process !== null,
      startedAt: managed.startedAt,
      lastEventAt: managed.lastEventAt,
      stepCount: managed.stepCount,
      currentTool: managed.currentTool,
      toolDetail: managed.toolDetail,
    };
  }

  private resetTTL(managed: ManagedProcess): void {
    if (managed.ttlTimer) {
      clearTimeout(managed.ttlTimer);
    }
    managed.ttlTimer = setTimeout(() => {
      console.log(`[ProcessManager] TTL expired for topic ${managed.topicKey}, cleaning up`);
      this.cleanup(managed.topicKey);
    }, this.settings.processes.ttlMinutes * 60 * 1000);
  }

  private cleanup(topicKey: string): void {
    const managed = this.processes.get(topicKey);
    if (!managed) return;

    if (managed.process) {
      managed.process.kill("SIGTERM");
    }
    if (managed.ttlTimer) {
      clearTimeout(managed.ttlTimer);
    }
    this.processes.delete(topicKey);
    // Очередь топика тоже выкидываем, чтобы не держать ссылку на старый promise
    this.topicQueues.delete(topicKey);
    this.onCleanup?.(topicKey);
  }

  private killOldestIdle(): void {
    let oldest: ManagedProcess | null = null;
    for (const managed of this.processes.values()) {
      // Убиваем ТОЛЬКО реально idle-процессы (process === null).
      // Прежний код мог прикончить активно работающий топик при достижении
      // maxConcurrent — и другие топики теряли задачу вместе с ним.
      if (managed.process !== null) continue;
      if (!oldest || managed.lastActivity < oldest.lastActivity) {
        oldest = managed;
      }
    }
    if (oldest) {
      console.log(`[ProcessManager] Killing oldest idle process: ${oldest.topicKey}`);
      this.cleanup(oldest.topicKey);
    }
  }

  /**
   * Kill a specific topic's process and clean up. Returns true if was active.
   */
  killTopic(topicKey: string): boolean {
    const managed = this.processes.get(topicKey);
    if (!managed) return false;
    this.cleanup(topicKey);
    return true;
  }

  getSessionId(topicKey: string): string | undefined {
    const id = this.processes.get(topicKey)?.sessionId;
    return id || undefined;
  }

  getActiveCount(): number {
    return this.processes.size;
  }

  /**
   * Снимок по всем активным топикам. Используется командой /topics
   * и /killall для отчётности.
   */
  listActive(): Array<{ topicKey: string; startedAt: number | null; lastEventAt: number | null; stepCount: number; currentTool: string | null; toolDetail: string | null }> {
    const out: Array<{ topicKey: string; startedAt: number | null; lastEventAt: number | null; stepCount: number; currentTool: string | null; toolDetail: string | null }> = [];
    for (const [key, m] of this.processes) {
      out.push({
        topicKey: key,
        startedAt: m.startedAt,
        lastEventAt: m.lastEventAt,
        stepCount: m.stepCount,
        currentTool: m.currentTool,
        toolDetail: m.toolDetail,
      });
    }
    return out;
  }

  /**
   * Убить все активные Claude-процессы разом. Возвращает число убитых.
   * Используется командой /killall — роутер продолжает работать,
   * но все in-flight задачи отменяются. От shutdown() отличается тем,
   * что не завершает сам менеджер и может вызываться повторно.
   */
  killAll(): number {
    const keys = Array.from(this.processes.keys());
    for (const key of keys) this.cleanup(key);
    return keys.length;
  }

  shutdown(): void {
    for (const [key] of this.processes) {
      this.cleanup(key);
    }
  }
}
