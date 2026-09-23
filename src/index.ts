import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings, getBotToken } from "./config";
import { Router } from "./router";

console.log("===========================================");
console.log("  Claude Topic Router v0.1.0");
console.log("  Telegram topics → Claude Code processes");
console.log("===========================================");

// --- Single-instance lock via .router.pid -----------------------------------
// Атомарный захват через O_EXCL: open("wx") падает с EEXIST если файл
// уже есть, никаких TOCTOU-гонок между existsSync и writeFileSync.
// Прежний код мог пропустить второй инстанс если два bun'а стартовали
// почти одновременно (например watchdog + ручной запуск).
const lockPath = resolve(process.cwd(), ".router.pid");

function acquireLock(): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL | O_WRONLY
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      console.log(`[Router] Wrote single-instance lock: ${lockPath} (PID ${process.pid})`);
      return;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let oldPid = 0;
      try {
        oldPid = Number(readFileSync(lockPath, "utf8").trim());
      } catch {
        /* unreadable — treat as stale */
      }
      if (Number.isFinite(oldPid) && oldPid > 0 && oldPid !== process.pid) {
        let alive = false;
        try {
          process.kill(oldPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) {
          console.error(
            `[Router] Another router instance is already running (PID ${oldPid}). ` +
              `Exiting to avoid Telegram 409 Conflict.`
          );
          process.exit(1);
        }
      }
      // stale lock — remove and retry
      try { unlinkSync(lockPath); } catch { /* ignore */ }
      console.log(`[Router] Removed stale .router.pid (PID ${oldPid || "?"}), retrying.`);
    }
  }
  // Should never reach here — if we do, force-write and continue
  writeFileSync(lockPath, String(process.pid));
  console.warn(`[Router] Lock acquisition fell through to force-write`);
}

acquireLock();

const releaseLock = () => {
  try {
    if (existsSync(lockPath)) {
      const cur = Number(readFileSync(lockPath, "utf8").trim());
      if (cur === process.pid) unlinkSync(lockPath);
    }
  } catch {
    /* ignore */
  }
};
process.on("exit", releaseLock);
process.on("SIGINT", () => {
  releaseLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});
// ----------------------------------------------------------------------------

const settings = loadSettings();
const botToken = getBotToken();

console.log(`[Config] Projects root: ${settings.projectsRoot}`);
console.log(`[Config] Max concurrent: ${settings.processes.maxConcurrent}`);
console.log(`[Config] TTL: ${settings.processes.ttlMinutes} min`);
console.log(`[Config] Whisper: ${settings.whisper.enabled ? "ON" : "OFF"}`);

const router = new Router(botToken, settings);
// Если start() отклонится (например getMe не прошёл за 6 попыток), процесс
// НЕ должен оставаться жить: в webhook-режиме Bun.serve уже слушает и
// держит event-loop открытым, поэтому без этого catch промис просто
// становится unhandled rejection, а процесс продолжает принимать апдейты
// в /webhook без botInfo и валит каждый с "Bot not initialized" (инцидент
// 2026-06-30, PID 7912). Явный exit(1) → nssm/watchdog перезапускают чисто.
try {
  await router.start();
} catch (err) {
  console.error(
    `[Router] FATAL: start() failed, exiting for supervisor restart: ` +
      `${(err as Error)?.stack ?? err}`,
  );
  process.exit(1);
}
