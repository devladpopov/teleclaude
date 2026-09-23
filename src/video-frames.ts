import { spawn } from "child_process";
import { existsSync, readdirSync, mkdirSync } from "fs";
import { resolve } from "path";

/**
 * Video frame extractor — рендерит N кадров через ffmpeg для последующего
 * визуального разбора мультимодальным Claude (Read умеет читать картинки).
 *
 * Почему так:
 *   1) У Claude нет нативной поддержки video/*, но есть сильный vision
 *      через встроенный Read на .jpg/.png. Достаточно нарезать видео на
 *      характерные кадры — и модель увидит тексты, UI, жесты, сцены.
 *   2) Аудиодорожку отдельно транскрибирует WhisperClient — внутри
 *      openai-whisper-asr-webservice уже есть ffmpeg, так что сам
 *      mp4-файл уезжает туда целиком.
 *   3) Кадры извлекаются равномерно по всей длительности:
 *      rate = N / duration → -vf "fps=rate", затем -frames:v N
 *      (отрезает лишний хвост и даёт стабильное количество файлов).
 *   4) ffmpeg может отсутствовать на машине — в этом случае
 *      возвращаем reason=no_ffmpeg и роутер просто отдаёт Claude видео
 *      без кадров, с явной пометкой. Любая другая ошибка ffmpeg —
 *      ffmpeg_failed с хвостом stderr.
 */

export type FrameFailureReason =
  | "no_ffmpeg" // ffmpeg не в PATH
  | "ffmpeg_failed" // exit != 0
  | "no_frames" // exit 0, но файлы не созданы
  | "timeout"; // не уложился в лимит

export type FrameExtractionResult =
  | { ok: true; frames: string[]; count: number; elapsedSec: number }
  | {
      ok: false;
      reason: FrameFailureReason;
      detail: string;
      elapsedSec: number;
    };

export interface ExtractOptions {
  /** Желаемое число кадров. По умолчанию — адаптивно от длительности. */
  count?: number;
  /** Длительность видео в секундах (из msg.video.duration). */
  duration?: number;
  /** Ширина кадра в пикселях (высота — пропорционально). */
  width?: number;
  /** Hard timeout на весь ffmpeg-прогон, мс. */
  timeoutMs?: number;
}

/**
 * Адаптивно выбирает количество кадров.
 * Короткие ролики (≤10с) — 4 кадра, длинные — 1 кадр/5с, но не больше 12.
 * 12 — компромисс: хватает для сюжета, не раздувает контекст Claude.
 */
function pickFrameCount(durationSec: number): number {
  if (!durationSec || durationSec <= 0) return 6;
  if (durationSec <= 10) return 4;
  return Math.max(4, Math.min(12, Math.ceil(durationSec / 5)));
}

export async function extractFrames(
  videoPath: string,
  outDir: string,
  opts: ExtractOptions = {},
): Promise<FrameExtractionResult> {
  const startedAt = Date.now();
  const elapsed = () => (Date.now() - startedAt) / 1000;

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const duration = opts.duration && opts.duration > 0 ? opts.duration : 0;
  const count = opts.count ?? pickFrameCount(duration);
  const width = opts.width ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // Если длительности не знаем — берём rate=1fps и режем первые `count` кадров.
  const rate = duration > 0 ? count / duration : 1;

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    videoPath,
    "-vf",
    `fps=${rate.toFixed(4)},scale=${width}:-2`,
    "-q:v",
    "2",
    "-frames:v",
    String(count),
    resolve(outDir, "frame-%03d.jpg"),
  ];

  try {
    await runFfmpeg(args, timeoutMs);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|is not recognized/i.test(detail)) {
      return {
        ok: false,
        reason: "no_ffmpeg",
        detail,
        elapsedSec: elapsed(),
      };
    }
    if (/timeout/i.test(detail)) {
      return { ok: false, reason: "timeout", detail, elapsedSec: elapsed() };
    }
    return {
      ok: false,
      reason: "ffmpeg_failed",
      detail,
      elapsedSec: elapsed(),
    };
  }

  const produced = readdirSync(outDir)
    .filter((f) => /^frame-\d+\.jpg$/.test(f))
    .sort()
    .map((f) => resolve(outDir, f));

  if (produced.length === 0) {
    return {
      ok: false,
      reason: "no_frames",
      detail: "ffmpeg отработал с exit 0, но .jpg не созданы",
      elapsedSec: elapsed(),
    };
  }

  return {
    ok: true,
    frames: produced,
    count: produced.length,
    elapsedSec: elapsed(),
  };
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    // Node.js + child_process.spawn на Windows сам разрулит ffmpeg -> ffmpeg.exe
    // если бинарь в PATH. Если нет — поймаем ENOENT через proc.on("error").
    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });

    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      rejectP(new Error(`ffmpeg timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveP();
      } else {
        rejectP(
          new Error(`ffmpeg exit ${code}: ${stderr.slice(-300) || "(no stderr)"}`),
        );
      }
    });
  });
}

/**
 * Человекочитаемая пояснялка для пользователя, когда кадры не удалось
 * вытащить. Формируется роутером и НЕ блокирует остальной пайплайн —
 * видео всё равно уедет в Claude, просто без покадровой раскладки.
 */
export function formatFrameFailure(
  res: Extract<FrameExtractionResult, { ok: false }>,
): string {
  const head: Record<FrameFailureReason, string> = {
    no_ffmpeg:
      "ffmpeg не найден в PATH — покадровая раскладка пропущена. " +
      "Установка: `winget install Gyan.FFmpeg` (Windows), затем перезапустить роутер.",
    ffmpeg_failed: "ffmpeg вернул ошибку — покадровая раскладка пропущена.",
    no_frames: "ffmpeg отработал, но кадры не созданы (возможно, пустой файл).",
    timeout: "ffmpeg не уложился в таймаут — покадровая раскладка пропущена.",
  };
  return `${head[res.reason]} Причина: ${res.detail}`;
}
