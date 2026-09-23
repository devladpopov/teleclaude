import type { Settings } from "./config";
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * WhisperClient — отправляет аудио на локальный
 * openai-whisper-asr-webservice (docker, localhost:9000/asr).
 *
 * Дизайн (после инцидента 2026-04-08):
 *
 * 1) Транскрипция возвращает СТРУКТУРИРОВАННЫЙ результат
 *    (WhisperResult), а не string|null. Раньше null покрывал и
 *    "сервис мёртв", и "пустой транскрипт", и "curl упал" — роутер
 *    не мог отличить причины и ответить пользователю чем-то
 *    осмысленным. Теперь у каждой причины свой `reason` + `detail`.
 *
 * 2) ensureUp() гарантирует, что сервис работает ПЕРЕД тем как
 *    лить файл. Health-check бьёт по `${url}` (корень + /docs)
 *    с маленьким HTTP-таймаутом. Если сервис не отвечает —
 *    зовём scripts/ensure-whisper.ps1, который делает docker start
 *    нашего контейнера и ждёт его готовности до startupTimeoutSeconds.
 *
 * 3) curl.exe вместо Bun.fetch+FormData по причине из CHANGELOG
 *    2026-04-06: Bun.file+FormData падал на больших MP3 (>5 МБ)
 *    без читаемой ошибки. curl.exe (Windows 10+) стримит файл
 *    с диска и работает.
 *
 * 4) Никаких "тихих" путей: каждый failure-mode логируется и
 *    маппится в ChatNotifier-friendly сообщение через formatError().
 */

export type WhisperFailureReason =
  | "disabled"        // whisper.enabled === false
  | "service_down"    // health не зеленеет даже после ensure-whisper
  | "ensure_failed"   // ensure-whisper.ps1 завершился с ошибкой
  | "curl_failed"     // curl exit != 0 (сеть/HTTP)
  | "non_json"        // ответ не JSON (сервис умер посреди запроса)
  | "empty"           // JSON ок, но текст пустой
  | "timeout";        // curl timeout вышел

export type WhisperResult =
  | { ok: true; text: string; elapsedSec: number }
  | {
      ok: false;
      reason: WhisperFailureReason;
      detail: string;
      elapsedSec: number;
    };

const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export class WhisperClient {
  private url: string;
  private language: string;
  private enabled: boolean;
  private autoStart: boolean;
  private containerName: string;
  private startupTimeoutSec: number;
  private healthTimeoutMs: number;
  private timeoutMs: number;

  constructor(settings: Settings) {
    this.url = settings.whisper.url;
    this.language = settings.whisper.language;
    this.enabled = settings.whisper.enabled;
    this.autoStart = settings.whisper.autoStart !== false; // default true
    this.containerName = settings.whisper.containerName || "";
    this.startupTimeoutSec = settings.whisper.startupTimeoutSeconds ?? 90;
    this.healthTimeoutMs = settings.whisper.healthTimeoutMs ?? 1500;
    this.timeoutMs = 30 * 60 * 1000; // 30 минут на длинные записи
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Проверка живости + (при необходимости) попытка поднять контейнер.
   * Возвращает true если сервис в итоге жив; false если поднять не удалось.
   *
   * Безопасно вызывать многократно — health-check быстрый, а реальный
   * docker start запускается только когда сервис реально лежит.
   */
  async ensureUp(): Promise<{ ok: true } | { ok: false; reason: WhisperFailureReason; detail: string }> {
    if (!this.enabled) {
      return { ok: false, reason: "disabled", detail: "whisper.enabled=false в config/settings.json" };
    }

    // 1) Быстрый health: уже жив?
    if (await this.isHealthy()) return { ok: true };

    if (!this.autoStart) {
      return {
        ok: false,
        reason: "service_down",
        detail: `Сервис ${this.healthUrl()} не отвечает, autoStart выключен`,
      };
    }

    // 2) Пытаемся поднять через PowerShell-скрипт
    console.warn(`[Whisper] service down at ${this.healthUrl()}, calling ensure-whisper.ps1...`);
    const ensureRes = await this.runEnsureScript();
    if (!ensureRes.ok) {
      return {
        ok: false,
        reason: "ensure_failed",
        detail: ensureRes.detail,
      };
    }

    // 3) Финальная проверка
    if (await this.isHealthy()) {
      console.log(`[Whisper] service revived after ensure-whisper`);
      return { ok: true };
    }

    return {
      ok: false,
      reason: "service_down",
      detail: `ensure-whisper отработал, но сервис всё ещё не отвечает на ${this.healthUrl()}`,
    };
  }

  async transcribe(filePath: string): Promise<WhisperResult> {
    const startedAt = Date.now();
    const elapsed = () => (Date.now() - startedAt) / 1000;

    if (!this.enabled) {
      return {
        ok: false,
        reason: "disabled",
        detail: "whisper.enabled=false в config/settings.json",
        elapsedSec: 0,
      };
    }

    // 1) Сначала убедимся что сервис жив (или поднимем).
    const up = await this.ensureUp();
    if (!up.ok) {
      console.error(`[Whisper] ensureUp failed: ${up.reason} — ${up.detail}`);
      return { ...up, elapsedSec: elapsed() };
    }

    const url = `${this.url}?output=json&task=transcribe&language=${this.language}`;
    console.log(`[Whisper] POST ${url} <- ${filePath}`);

    let stdout: string;
    try {
      stdout = await this.runCurl(url, filePath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[Whisper] curl failed after ${elapsed().toFixed(1)}s: ${detail}`);
      const reason: WhisperFailureReason = /timeout/i.test(detail) ? "timeout" : "curl_failed";
      return { ok: false, reason, detail, elapsedSec: elapsed() };
    }

    let parsed: { segments?: Array<{ text?: string }>; text?: string };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      const preview = stdout.slice(0, 300);
      console.error(`[Whisper] non-JSON response after ${elapsed().toFixed(1)}s: ${preview}`);
      return {
        ok: false,
        reason: "non_json",
        detail: `Сервис вернул не JSON: ${preview}`,
        elapsedSec: elapsed(),
      };
    }

    // openai-whisper-asr-webservice JSON: { text, segments: [{text}] }
    let text: string | null = null;
    if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
      text = parsed.segments
        .map((s) => (s.text ?? "").trim())
        .filter(Boolean)
        .join(" ");
    } else if (typeof parsed.text === "string") {
      text = parsed.text.trim();
    }

    if (!text) {
      console.warn(`[Whisper] empty transcript after ${elapsed().toFixed(1)}s. raw=${stdout.slice(0, 200)}`);
      return {
        ok: false,
        reason: "empty",
        detail: "Whisper вернул пустой текст. Возможно, в записи нет речи или язык распознан неверно.",
        elapsedSec: elapsed(),
      };
    }

    console.log(`[Whisper] OK in ${elapsed().toFixed(1)}s, ${text.length} chars`);
    return { ok: true, text, elapsedSec: elapsed() };
  }

  /**
   * URL для health-check.
   * Сервис openai-whisper-asr-webservice отдаёт Swagger на /docs,
   * это самый быстрый способ убедиться что HTTP-слой жив.
   */
  private healthUrl(): string {
    try {
      const u = new URL(this.url);
      u.pathname = "/docs";
      u.search = "";
      return u.toString();
    } catch {
      return this.url;
    }
  }

  private async isHealthy(): Promise<boolean> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.healthTimeoutMs);
    try {
      const res = await fetch(this.healthUrl(), { method: "GET", signal: ctrl.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Запускает scripts/ensure-whisper.ps1 — он сам разбирается, какой
   * контейнер поднимать и сколько ждать.
   */
  private runEnsureScript(): Promise<{ ok: true } | { ok: false; detail: string }> {
    return new Promise((resolveP) => {
      const scriptPath = resolve(PROJECT_ROOT, "scripts", "ensure-whisper.ps1");
      const args = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Url",
        this.healthUrl(),
        "-TimeoutSec",
        String(this.startupTimeoutSec),
      ];
      if (this.containerName) {
        args.push("-Container", this.containerName);
      }

      const proc = spawn("powershell.exe", args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
      proc.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });

      // Сам скрипт ограничивает себя startupTimeoutSec; здесь даём
      // запас на запуск powershell + лёгкую буферизацию.
      const hardTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        resolveP({ ok: false, detail: `ensure-whisper.ps1 timeout (>${this.startupTimeoutSec + 30}s)` });
      }, (this.startupTimeoutSec + 30) * 1000);

      proc.on("error", (err) => {
        clearTimeout(hardTimer);
        resolveP({ ok: false, detail: `spawn powershell failed: ${err.message}` });
      });

      proc.on("close", (code) => {
        clearTimeout(hardTimer);
        if (code === 0) {
          if (stdout.trim()) console.log(`[Whisper] ensure-whisper: ${stdout.trim().split("\n").pop()}`);
          resolveP({ ok: true });
        } else {
          const tail = (stderr || stdout).trim().split("\n").slice(-5).join(" | ");
          resolveP({
            ok: false,
            detail: `ensure-whisper.ps1 exit ${code}: ${tail || "(no output)"}`,
          });
        }
      });
    });
  }

  /**
   * Запускает curl.exe для multipart-upload файла на whisper.
   * Возвращает stdout (JSON). Бросает на любой не-нулевой exit / timeout.
   */
  private runCurl(url: string, filePath: string): Promise<string> {
    return new Promise((resolveP, rejectP) => {
      const args = [
        "-sS",
        "--max-time",
        String(Math.floor(this.timeoutMs / 1000)),
        "-X",
        "POST",
        "-H",
        "Accept: application/json",
        "-F",
        `audio_file=@${filePath}`,
        url,
      ];

      const proc = spawn("curl.exe", args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        rejectP(new Error(`curl timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs + 5000);

      proc.on("error", (err) => {
        clearTimeout(timer);
        rejectP(new Error(`curl spawn error: ${err.message}`));
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          rejectP(new Error(`curl exited with code ${code}. stderr=${stderr.slice(0, 300)}`));
          return;
        }
        resolveP(stdout);
      });
    });
  }
}

/**
 * Человекочитаемое сообщение для отправки в чат.
 * Включает путь к файлу — пользователь всегда может скачать и
 * прогнать вручную.
 */
export function formatWhisperFailure(
  res: Extract<WhisperResult, { ok: false }>,
  filePath: string,
): string {
  const head: Record<WhisperFailureReason, string> = {
    disabled: "Транскрипция отключена в настройках бота.",
    service_down: "Whisper-сервис не отвечает и не поднялся автоматически.",
    ensure_failed: "Не удалось запустить Whisper-контейнер.",
    curl_failed: "Сетевая ошибка при отправке аудио в Whisper.",
    non_json: "Whisper вернул сломанный ответ (не JSON). Скорее всего, упал во время обработки.",
    empty: "Whisper отработал, но не нашёл речи в записи.",
    timeout: "Whisper не уложился в таймаут — запись слишком длинная или сервис залип.",
  };
  const elapsed = res.elapsedSec > 0 ? ` (через ${res.elapsedSec.toFixed(1)}с)` : "";
  return [
    `${head[res.reason]}${elapsed}`,
    `Причина: ${res.detail}`,
    `Файл сохранён: ${filePath}`,
    `Можно повторить отправку или прогнать вручную:`,
    `curl.exe -sS --max-time 1800 -F "audio_file=@${filePath}" "http://localhost:9000/asr?output=json&task=transcribe&language=ru"`,
  ].join("\n");
}
