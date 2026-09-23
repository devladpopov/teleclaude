import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import type { Settings } from "./config";

/**
 * Monitors and compacts Claude Code session context.
 *
 * Tracks both message count and total characters per topic.
 * When thresholds are reached, injects compaction instructions
 * to prompt Claude to update topic-memory.md and reduce context size.
 */
export class ContextCompactor {
  private settings: Settings;
  private messageCounters = new Map<string, number>();
  private charCounters = new Map<string, number>();

  // Compact after N messages OR M characters — whichever comes first
  private readonly MESSAGE_THRESHOLD = 15;
  private readonly CHAR_THRESHOLD = 30_000;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /**
   * Track message count and size per topic. Returns compaction instructions if needed.
   */
  trackMessage(topicKey: string, messageLength?: number): string | null {
    if (!this.settings.compaction.enabled) return null;

    const msgCount = (this.messageCounters.get(topicKey) || 0) + 1;
    this.messageCounters.set(topicKey, msgCount);

    const charCount = (this.charCounters.get(topicKey) || 0) + (messageLength || 0);
    this.charCounters.set(topicKey, charCount);

    const messageThresholdHit = msgCount >= this.MESSAGE_THRESHOLD && msgCount % this.MESSAGE_THRESHOLD === 0;
    const charThresholdHit = charCount >= this.CHAR_THRESHOLD;

    if (messageThresholdHit || charThresholdHit) {
      // Reset char counter after compaction trigger
      if (charThresholdHit) {
        this.charCounters.set(topicKey, 0);
      }
      const reason = charThresholdHit
        ? `${Math.round(charCount / 1000)}K символов`
        : `${msgCount} сообщений`;
      console.log(`[ContextCompactor] Compaction triggered for ${topicKey}: ${reason}`);
      return this.getCompactionPrompt();
    }

    return null;
  }

  /**
   * Returns a prompt that instructs Claude to compact its context.
   */
  getCompactionPrompt(): string {
    return `[СИСТЕМНАЯ ИНСТРУКЦИЯ: Контекст диалога стал большим. Перед ответом на сообщение пользователя:
1. Обнови topic-memory.md: добавь ключевые решения, факты и результаты из последних сообщений
2. Удали из topic-memory.md устаревшую, дублирующуюся или уже неактуальную информацию
3. Если в ходе диалога были важные технические решения — зафиксируй их кратко
4. Если в ходе диалога была завершена крупная задача (деплой, миграция, фича) — перезапиши CHECKPOINT.md в корне проекта со STATUS, TASK, LAST_ACTION, NEXT, DO_NOT_REDO, VERIFY_BEFORE_ACT (подробный формат — в SOUL.md)
5. Затем ответь на сообщение пользователя как обычно. НЕ повторяй уже выполненные tool calls — только реагируй на текущий запрос]

`;
  }

  /**
   * Append important context to topic-memory.md from outside Claude.
   */
  appendToMemory(projectPath: string, content: string): void {
    const memPath = join(projectPath, "topic-memory.md");
    if (existsSync(memPath)) {
      appendFileSync(memPath, `\n\n## Обновление ${new Date().toISOString().split("T")[0]}\n${content}`, "utf-8");
    }
  }

  /**
   * Reset counters for a topic (e.g., when session expires).
   */
  resetCounter(topicKey: string): void {
    this.messageCounters.delete(topicKey);
    this.charCounters.delete(topicKey);
  }

  /**
   * Get message count for a topic.
   */
  getMessageCount(topicKey: string): number {
    return this.messageCounters.get(topicKey) || 0;
  }

  /**
   * Get character count for a topic.
   */
  getCharCount(topicKey: string): number {
    return this.charCounters.get(topicKey) || 0;
  }
}
