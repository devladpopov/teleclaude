import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const AM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNTS_PATH = resolve(AM_ROOT, "config/accounts.json");

/**
 * Аккаунт Claude Code, под которым роутер будет запускать процессы.
 *
 * Три типа:
 *  - default:   ничего не подставляем в env, CLI берёт ~/.claude/.credentials.json
 *               (это поведение роутера до фичи multi-account).
 *  - token:     читаем long-lived OAuth токен из `tokenFile` и подставляем в
 *               env-переменную CLAUDE_CODE_OAUTH_TOKEN при каждом spawn.
 *               Подходит для токенов, полученных через `claude setup-token`.
 *  - configDir: подставляем CLAUDE_CONFIG_DIR, указывающий на отдельный каталог
 *               с .credentials.json. Нужен, когда у аккаунта есть refresh-токен
 *               и мы хотим, чтобы CLI автоматически обновлял его.
 */
interface AccountDefault {
  type: "default";
  description?: string;
}
interface AccountToken {
  type: "token";
  tokenFile: string;
  description?: string;
}
interface AccountConfigDir {
  type: "configDir";
  configDir: string;
  description?: string;
}
interface AccountApiKey {
  type: "apikey";
  keyFile: string;
  description?: string;
}
type Account = AccountDefault | AccountToken | AccountConfigDir | AccountApiKey;

interface AccountsFile {
  active: string;
  accounts: Record<string, Account>;
}

export interface AccountInfo {
  name: string;
  type: string;
  description?: string;
  active: boolean;
  ready: boolean;          // токен/каталог доступны и не пусты
  problem?: string;        // если ready=false — что именно не так
}

/**
 * Single source of truth для того, чей OAuth жжёт роутер.
 *
 * Все мутации сразу сохраняются в `config/accounts.json`, так что
 * /account-переключение переживает рестарт роутера.
 */
export class AccountManager {
  private data: AccountsFile;

  constructor() {
    this.data = this.load();
  }

  private load(): AccountsFile {
    if (!existsSync(ACCOUNTS_PATH)) {
      console.warn(
        `[AccountManager] ${ACCOUNTS_PATH} not found, using default single-account config`,
      );
      return {
        active: "main",
        accounts: { main: { type: "default", description: "default ~/.claude" } },
      };
    }
    try {
      const raw = readFileSync(ACCOUNTS_PATH, "utf-8");
      const parsed = JSON.parse(raw) as AccountsFile;
      if (!parsed.accounts || !parsed.accounts[parsed.active]) {
        console.warn(
          `[AccountManager] active account "${parsed.active}" not in accounts map — falling back to first key`,
        );
        const firstKey = Object.keys(parsed.accounts || {})[0];
        if (firstKey) parsed.active = firstKey;
      }
      return parsed;
    } catch (e) {
      console.error(`[AccountManager] failed to read ${ACCOUNTS_PATH}:`, e);
      return {
        active: "main",
        accounts: { main: { type: "default" } },
      };
    }
  }

  private save(): void {
    try {
      writeFileSync(ACCOUNTS_PATH, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (e) {
      console.error(`[AccountManager] failed to save ${ACCOUNTS_PATH}:`, e);
    }
  }

  /** Перечитать accounts.json с диска (например, если файл правили вручную). */
  reload(): void {
    this.data = this.load();
  }

  getActiveName(): string {
    return this.data.active;
  }

  has(name: string): boolean {
    return !!this.data.accounts[name];
  }

  listNames(): string[] {
    return Object.keys(this.data.accounts);
  }

  /** Список всех аккаунтов с диагностикой готовности. */
  list(): AccountInfo[] {
    return Object.entries(this.data.accounts).map(([name, acc]) => {
      const readiness = this.checkReadiness(acc);
      return {
        name,
        type: acc.type,
        description: (acc as any).description,
        active: name === this.data.active,
        ready: readiness.ready,
        problem: readiness.problem,
      };
    });
  }

  private checkReadiness(acc: Account): { ready: boolean; problem?: string } {
    if (acc.type === "default") {
      const home = process.env.USERPROFILE || process.env.HOME || "";
      const credsPath = resolve(home, ".claude", ".credentials.json");
      if (!existsSync(credsPath)) {
        return { ready: false, problem: `нет ${credsPath}` };
      }
      return { ready: true };
    }
    if (acc.type === "token") {
      if (!existsSync(acc.tokenFile)) {
        return { ready: false, problem: `нет ${acc.tokenFile}` };
      }
      try {
        const content = readFileSync(acc.tokenFile, "utf-8").trim();
        if (!content) return { ready: false, problem: "файл токена пустой" };
        return { ready: true };
      } catch (e: any) {
        return { ready: false, problem: `чтение токена: ${e?.message ?? e}` };
      }
    }
    if (acc.type === "configDir") {
      if (!existsSync(acc.configDir)) {
        return { ready: false, problem: `нет ${acc.configDir}` };
      }
      return { ready: true };
    }
    if (acc.type === "apikey") {
      if (!existsSync(acc.keyFile)) {
        return { ready: false, problem: `нет ${acc.keyFile}` };
      }
      try {
        const content = readFileSync(acc.keyFile, "utf-8").trim();
        if (!content) return { ready: false, problem: "файл API-ключа пустой" };
        return { ready: true };
      } catch (e: any) {
        return { ready: false, problem: `чтение ключа: ${e?.message ?? e}` };
      }
    }
    return { ready: false, problem: "неизвестный тип аккаунта" };
  }

  /** Переключить активный аккаунт. Возвращает false, если имя неизвестно. */
  setActive(name: string): boolean {
    if (!this.data.accounts[name]) return false;
    this.data.active = name;
    this.save();
    console.log(`[AccountManager] active account switched to "${name}"`);
    return true;
  }

  /**
   * Фрагмент env-переменных для активного аккаунта.
   * Вызывающий (ProcessManager) делает Object.assign(cleanEnv, getSpawnEnv()).
   *
   * Для type=default возвращается пустой объект — CLI использует ~/.claude.
   */
  getSpawnEnv(): NodeJS.ProcessEnv {
    const name = this.data.active;
    const acc = this.data.accounts[name];
    if (!acc) {
      console.warn(
        `[AccountManager] active "${name}" missing — spawn will fall back to ~/.claude`,
      );
      return {};
    }
    if (acc.type === "default") return {};

    if (acc.type === "token") {
      try {
        const token = readFileSync(acc.tokenFile, "utf-8").trim();
        if (!token) {
          console.warn(
            `[AccountManager] token file empty for "${name}" — fallback to ~/.claude`,
          );
          return {};
        }
        return { CLAUDE_CODE_OAUTH_TOKEN: token };
      } catch (e) {
        console.error(
          `[AccountManager] failed to read token file for "${name}":`,
          e,
        );
        return {};
      }
    }

    if (acc.type === "configDir") {
      return { CLAUDE_CONFIG_DIR: acc.configDir };
    }

    if (acc.type === "apikey") {
      try {
        const apiKey = readFileSync(acc.keyFile, "utf-8").trim();
        if (!apiKey) {
          console.warn(
            `[AccountManager] API key file empty for "${name}" — fallback to ~/.claude`,
          );
          return {};
        }
        return { ANTHROPIC_API_KEY: apiKey };
      } catch (e) {
        console.error(
          `[AccountManager] failed to read API key file for "${name}":`,
          e,
        );
        return {};
      }
    }

    return {};
  }

  /**
   * Использует ли активный аккаунт API-ключ (а не OAuth)?
   *
   * Основной сценарий: OAuth (Max-подписка) — типы "default" / "token" /
   * "configDir". Тип "apikey" намеренно не настроен, чтобы исключить
   * случайный биллинг по API. На практике сейчас всегда false; метод
   * расширяемый — runner-client.ts / process-manager.ts вокруг него
   * фильтруют ANTHROPIC_API_KEY из env (подавать только api-key аккаунту).
   */
  isApiKeyAccount(): boolean {
    const acc = this.data.accounts[this.data.active];
    return acc?.type === "apikey";
  }
}
