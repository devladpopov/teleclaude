import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PATH = resolve(PT_ROOT, "config", "pending-tasks.json");

/**
 * Запись об одной активной "Думаю..."-задаче. Роутер пишет её на старте
 * sendMessage и удаляет по завершению (успех или ошибка). При рестарте
 * роутер сканирует файл и редактирует все "осиротевшие" сообщения,
 * чтобы пользователь не сидел перед бесконечным "Думаю..." после краша.
 *
 * Не хранит сам текст задачи — только то, что нужно для редактирования
 * конкретного сообщения в Telegram.
 */
export interface PendingTask {
  topicKey: string;
  chatId: number;
  threadId: number | undefined;
  messageId: number;
  startedAt: number;
  preview: string; // первые 80 символов входного сообщения — для логов/отладки
}

export class PendingTasksStore {
  private tasks = new Map<string, PendingTask>();
  private path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* dir exists */
    }
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const arr: PendingTask[] = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (const t of arr) {
            if (t && typeof t.topicKey === "string") {
              this.tasks.set(t.topicKey, t);
            }
          }
        }
      } catch (err) {
        console.error(`[PendingTasks] Failed to load ${path}: ${err}`);
      }
    }
  }

  add(task: PendingTask): void {
    this.tasks.set(task.topicKey, task);
    this.flush();
  }

  remove(topicKey: string): void {
    if (this.tasks.delete(topicKey)) {
      this.flush();
    }
  }

  /** Снимок всех осиротевших задач — используется на старте для очистки. */
  snapshot(): PendingTask[] {
    return Array.from(this.tasks.values());
  }

  clear(): void {
    if (this.tasks.size > 0) {
      this.tasks.clear();
      this.flush();
    }
  }

  private flush(): void {
    try {
      const arr = Array.from(this.tasks.values());
      writeFileSync(this.path, JSON.stringify(arr, null, 2), "utf-8");
    } catch (err) {
      console.error(`[PendingTasks] Failed to write ${this.path}: ${err}`);
    }
  }
}
