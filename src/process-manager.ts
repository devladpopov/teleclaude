import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import type { Settings } from "./config";

/**
 * Резюмировать сессию через `claude --resume <id>` можно только если у
 * нас настоящий id от claude (UUID-подобная строка). Локальные id из
 * старой архитектуры (`topic-<ts>-<rand>`) нерезюмируемы — мы их
 * игнорируем и стартуем новую сессию, чтобы не было кросс-контаминации
 * с тем, что выдаёт `--continue`.
 */
function isResumableSessionId(id: string | undefined): id is string {
  if (!id) return false;
  // claude session id выглядит как 8-4-4-4-12 hex (UUID v4)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

interface ManagedProcess {
  topicKey: string;
  projectPath: string;
  process: ChildProcess | null;
  sessionId: string;
  lastActivity: number;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  pendingResolves: Array<{
    resolve: (output: string) => void;
    reject: (error: Error) => void;
  }>;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private settings: Settings;
  private onCleanup?: (topicKey: string) => void;

  constructor(settings: Settings) {
    this.settings = settings;
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
   */
  async sendMessage(topicKey: string, projectPath: string, message: string, sessionId?: string, onData?: (chunk: string, accumulated: string) => void): Promise<string> {
    // Check concurrent limit
    const activeCount = Array.from(this.processes.values()).filter(p => p.process !== null).length;
    if (activeCount >= this.settings.processes.maxConcurrent) {
      // Kill oldest idle process
      this.killOldestIdle();
    }

    const managed = this.getOrCreate(topicKey, projectPath, sessionId);
    managed.lastActivity = Date.now();
    this.resetTTL(managed);

    return this.executeCommand(managed, message, onData);
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

  private async executeCommand(managed: ManagedProcess, message: string, onData?: (chunk: string, accumulated: string) => void): Promise<string> {
    // Write message to temp file to avoid Windows command line length limits
    const tmpDir = resolve(managed.projectPath, ".tmp");
    mkdirSync(tmpDir, { recursive: true });
    const msgFile = join(tmpDir, `msg-${Date.now()}.txt`);
    writeFileSync(msgFile, message, "utf-8");

    // stream-json + --verbose даёт нам:
    //  - реальный session_id от claude (через init/result event)
    //  - живой стрим текста из assistant message events
    //  - стабильный хвост result event для финального ответа
    const args: string[] = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
    ];

    // Резюмируем сессию ТОЛЬКО если у нас настоящий session_id от claude
    // (UUID 8-4-4-4-12). Старые «topic-*» локальные id — это мусор от
    // прошлой архитектуры, их игнорируем. Если id невалиден — стартуем
    // новую сессию (без --resume и без --continue), чтобы избежать
    // кросс-контаминации, как было с `--continue`.
    if (isResumableSessionId(managed.sessionId)) {
      args.push("--resume", managed.sessionId);
    }

    // Add default flags (e.g., --dangerously-skip-permissions)
    args.push(...this.settings.processes.defaultFlags);

    const claudePath = this.settings.processes.claudePath;

    return new Promise<string>((resolvePromise, reject) => {
      let stderr = "";
      let assistantText = ""; // накопленный текст ассистента (для UI)
      let resultText = "";    // финальный текст из result event
      let lineBuf = "";       // буфер незавершённой строки stream-json
      let detectedSessionId = "";

      console.log(`[ProcessManager] Spawning: ${claudePath} ${args.join(" ")} (message in ${msgFile}, ${message.length} chars)`);

      // Remove ANTHROPIC_API_KEY so Claude Code uses Max subscription instead of paid API
      const cleanEnv = { ...process.env };
      delete cleanEnv.ANTHROPIC_API_KEY;

      const proc = spawn(claudePath, args, {
        cwd: managed.projectPath,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      // Feed message via stdin
      proc.stdin?.write(message);
      proc.stdin?.end();

      managed.process = proc;

      const handleEvent = (event: any) => {
        if (!event || typeof event !== "object") return;

        // session_id может прийти в init и в result
        if (typeof event.session_id === "string" && /^[0-9a-f-]{16,}$/i.test(event.session_id)) {
          detectedSessionId = event.session_id;
        }

        // Streaming assistant text
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              assistantText += block.text;
              if (onData) {
                try { onData(block.text, assistantText); } catch {}
              }
            }
          }
          return;
        }

        // Final result event
        if (event.type === "result") {
          if (typeof event.result === "string") {
            resultText = event.result;
          }
          return;
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

        // Обработать остаток буфера, если последняя строка без \n
        if (lineBuf.trim()) {
          try { handleEvent(JSON.parse(lineBuf.trim())); } catch {}
          lineBuf = "";
        }

        if (detectedSessionId) {
          managed.sessionId = detectedSessionId;
        }

        const finalText = (resultText || assistantText).trim();

        if (code === 0 || finalText) {
          resolvePromise(finalText);
        } else {
          reject(new Error(`Claude exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
        }
      });

      proc.on("error", (err) => {
        managed.process = null;
        reject(err);
      });

      // Timeout: 5 minutes max per message
      setTimeout(() => {
        if (managed.process === proc) {
          proc.kill("SIGTERM");
          reject(new Error("Claude Code process timed out (5 min)"));
        }
      }, 5 * 60 * 1000);
    });
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
    this.onCleanup?.(topicKey);
  }

  private killOldestIdle(): void {
    let oldest: ManagedProcess | null = null;
    for (const managed of this.processes.values()) {
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

  shutdown(): void {
    for (const [key] of this.processes) {
      this.cleanup(key);
    }
  }
}
