import type { Bot } from "grammy";

/**
 * TypingCoordinator — централизованная отправка sendChatAction "typing"
 * с защитой от Telegram-лимита.
 *
 * Telegram allows 1 sendChatAction per chat per ~5 seconds. Раньше
 * каждый активный топик ставил свой `setInterval(..., 4000)` и слал
 * typing в свой thread параллельно. В супергруппе с несколькими
 * активными топиками это совокупно превышало лимит, и API отдавал
 * `429 Too Many Requests: retry after 3` (видно в логах и иногда
 * пробрасывалось пользователю).
 *
 * Решение: один таймер на чат, round-robin по активным
 * `(chatId, threadId)`. Каждый chat получает не более 1 typing per
 * `TICK_MS`. При 2+ активных топиках в одном чате каждый thread
 * получает typing с частотой `TICK_MS × N` — typing будет
 * "пульсировать", но никогда не упрётся в 429.
 *
 * 429 (и любые другие сетевые ошибки) глотаются молча — typing
 * это украшение, не критичный путь.
 */
export class TypingCoordinator {
  private bot: Bot;

  // chatId (string key) -> set активных threadId (undefined для general).
  // threadId хранится в Set; для разделения thread=undefined и thread=0
  // используем явный sentinel (Telegram не использует 0 как threadId).
  private active = new Map<string, Map<number, true>>();

  // chatId -> текущий setInterval handle.
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  // chatId -> round-robin index (для выбора следующего threadId на тике).
  private rotators = new Map<string, number>();

  // Telegram limit: ~1 sendChatAction per chat per 5s. Используем 5500ms
  // с запасом — сетевая задержка может сместить тики в опасную зону.
  private readonly TICK_MS = 5500;

  // Sentinel для thread=undefined (general chat без forum-топиков).
  private static readonly GENERAL_THREAD = 0;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /**
   * Зарегистрировать активный (chat, thread). Сразу отправит один
   * typing (чтобы пользователь не ждал первого тика 5+ секунд) и
   * запустит per-chat таймер если ещё не запущен.
   */
  start(chatId: string | number, threadId?: number): void {
    const chatKey = String(chatId);
    const tKey = threadId ?? TypingCoordinator.GENERAL_THREAD;

    let threads = this.active.get(chatKey);
    if (!threads) {
      threads = new Map();
      this.active.set(chatKey, threads);
    }
    const wasNew = !threads.has(tKey);
    threads.set(tKey, true);

    // Первое typing — сразу, чтобы UX не залипал на 5с молчания.
    // Но только при первой регистрации этого thread (повторный start
    // не должен спамить).
    if (wasNew) {
      this.sendOne(chatId, threadId).catch(() => {});
    }

    // Поднять таймер если ещё нет.
    if (!this.timers.has(chatKey)) {
      const timer = setInterval(() => this.tick(chatKey, chatId), this.TICK_MS);
      this.timers.set(chatKey, timer);
    }
  }

  /**
   * Снять регистрацию с (chat, thread). Если активных threads в этом
   * чате не осталось — гасим per-chat таймер.
   */
  stop(chatId: string | number, threadId?: number): void {
    const chatKey = String(chatId);
    const tKey = threadId ?? TypingCoordinator.GENERAL_THREAD;

    const threads = this.active.get(chatKey);
    if (!threads) return;

    threads.delete(tKey);
    if (threads.size === 0) {
      this.active.delete(chatKey);
      const timer = this.timers.get(chatKey);
      if (timer) clearInterval(timer);
      this.timers.delete(chatKey);
      this.rotators.delete(chatKey);
    }
  }

  /**
   * Полностью остановить все таймеры (на shutdown роутера).
   */
  shutdown(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.active.clear();
    this.rotators.clear();
  }

  // ────────────────────────────────────────────────────────────

  /**
   * Один тик per-chat таймера: round-robin выбираем threadId,
   * шлём typing в него. Если в чате один активный thread — он же
   * и получит каждый тик.
   */
  private async tick(chatKey: string, chatId: string | number): Promise<void> {
    const threads = this.active.get(chatKey);
    if (!threads || threads.size === 0) return;

    const keys = Array.from(threads.keys());
    const idx = (this.rotators.get(chatKey) ?? 0) % keys.length;
    this.rotators.set(chatKey, idx + 1);
    const tKey = keys[idx];

    const threadId =
      tKey === TypingCoordinator.GENERAL_THREAD ? undefined : tKey;
    await this.sendOne(chatId, threadId).catch(() => {});
  }

  /**
   * Прямой вызов sendChatAction. Все ошибки (429, network etc.)
   * глотаются — typing это украшение.
   */
  private async sendOne(
    chatId: string | number,
    threadId?: number,
  ): Promise<void> {
    try {
      await this.bot.api.sendChatAction(chatId, "typing", {
        message_thread_id: threadId,
      });
    } catch {
      // intentionally swallow — see class doc
    }
  }
}
