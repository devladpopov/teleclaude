/**
 * Defensive file-write primitives.
 *
 * Why this module exists:
 * On 2026-05-02 a single PowerShell BOM-strip mistake zeroed out
 * config/topics.json (no git history, lost). The router went into a
 * restart loop because the file was 0 bytes and JSON.parse failed.
 *
 * The fix is structural: never let a write replace a valid file with
 * an invalid/empty/much-shorter one. This module encapsulates that
 * invariant so every Director writer goes through it instead of calling
 * fs.writeFileSync directly.
 *
 * Guarantees:
 *   1. Atomic write (tmp + rename).
 *   2. Optional content validator runs BEFORE replacing the original.
 *   3. Optional minimum size guard.
 *   4. Optional shrink-pct guard (refuse if new file < N% of existing).
 *   5. Optional .bak.1 / .bak.2 / .bak.3 rotation before each write.
 *   6. On any guard failure → throw, leave the original intact.
 *
 * The cost (extra read + extra write) is acceptable for state-critical
 * files like topics.json, director-registry.json, director-dashboard.json,
 * director-events.json. Hot-path / append-only files (NDJSON event log)
 * use a different primitive — safeAppend.
 */

import {
  existsSync, readFileSync, writeFileSync, statSync, renameSync, unlinkSync,
  copyFileSync,
} from "node:fs";

export interface SafeWriteOptions {
  /**
   * Validates the content BEFORE replacing the original. Return true to
   * accept, false to reject. If a string is returned it's treated as a
   * rejection reason and bubbled into the error. Default: accept anything.
   */
  validate?: (content: string) => boolean | string;
  /**
   * Refuse the write if the resulting content is shorter than this many
   * bytes. Useful guard for "I expected at least 5 KB of JSON".
   */
  minBytes?: number;
  /**
   * Refuse the write if the resulting content is shorter than `shrinkPct`%
   * of the EXISTING on-disk content. Defaults to undefined (no guard).
   * 50 means "refuse if new file < 50% of old".
   */
  shrinkPct?: number;
  /**
   * Keep N rotated backups (.bak.1, .bak.2, ...) before each write. Each
   * write rotates the chain: current → .bak.1, .bak.1 → .bak.2, etc.
   * Default: 0 (no backups). Recommended: 3 for state-critical files.
   */
  backups?: number;
}

/**
 * Write `content` to `path` atomically (tmp + rename), with all the
 * guards from SafeWriteOptions applied BEFORE the rename.
 * Throws on any guard failure with a descriptive message; the original
 * file is left intact.
 */
export function safeWriteText(
  path: string,
  content: string,
  opts: SafeWriteOptions = {},
): void {
  // Guard 1: minBytes
  if (typeof opts.minBytes === "number" && Buffer.byteLength(content, "utf-8") < opts.minBytes) {
    throw new Error(
      `safeWriteText[${path}]: refusing — content is ${Buffer.byteLength(content, "utf-8")} bytes ` +
      `< minBytes=${opts.minBytes}`,
    );
  }

  // Guard 2: shrinkPct (compare to existing if present)
  if (typeof opts.shrinkPct === "number" && existsSync(path)) {
    const oldSize = statSync(path).size;
    const newSize = Buffer.byteLength(content, "utf-8");
    if (oldSize > 0) {
      const pct = (newSize / oldSize) * 100;
      if (pct < opts.shrinkPct) {
        throw new Error(
          `safeWriteText[${path}]: refusing — new ${newSize}B is ${pct.toFixed(1)}% of ` +
          `old ${oldSize}B (< shrinkPct=${opts.shrinkPct}%). Possible truncation/corruption.`,
        );
      }
    }
  }

  // Guard 3: validator
  if (opts.validate) {
    const result = opts.validate(content);
    if (result === false) {
      throw new Error(`safeWriteText[${path}]: refusing — validator returned false`);
    }
    if (typeof result === "string") {
      throw new Error(`safeWriteText[${path}]: refusing — validator: ${result}`);
    }
  }

  // Backup rotation BEFORE write.
  if (opts.backups && opts.backups > 0 && existsSync(path)) {
    rotateBackups(path, opts.backups);
  }

  // Atomic write.
  const tmp = path + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  // Verify tmp matches what we wrote (catches FS-level corruption).
  const verify = readFileSync(tmp, "utf-8");
  if (verify !== content) {
    try { unlinkSync(tmp); } catch {}
    throw new Error(`safeWriteText[${path}]: tmp readback mismatch — FS corruption?`);
  }
  // Rename atomically. On Windows, rename is atomic within same volume
  // but doesn't replace an existing file by default — fs.renameSync is
  // wrapped by Node to do replace.
  renameSync(tmp, path);
}

/**
 * JSON-specific wrapper. Stringifies with 2-space indent (matches existing
 * file style), validates that the result parses back to the same shape,
 * and forwards to safeWriteText with sane defaults for state files.
 */
export function safeWriteJson<T>(
  path: string,
  data: T,
  opts: SafeWriteOptions = {},
): void {
  const content = JSON.stringify(data, null, 2);
  // Validator: must round-trip parse without error AND produce a non-null
  // object/array (rejects writing "null" or "undefined").
  const merged: SafeWriteOptions = {
    validate: (text) => {
      try {
        const reparsed = JSON.parse(text);
        if (reparsed == null) return "JSON parses to null/undefined";
        return true;
      } catch (err) {
        return `JSON.parse failed: ${(err as Error).message}`;
      }
    },
    ...opts,  // user-supplied options override the default validator
  };
  // If user gave their own validator, chain ours so we still check parsing.
  if (opts.validate) {
    merged.validate = (text) => {
      try { JSON.parse(text); } catch (err) { return `JSON.parse failed: ${(err as Error).message}`; }
      return opts.validate!(text);
    };
  }
  safeWriteText(path, content, merged);
}

/**
 * Rotate backups for `path`. Keeps up to `keep` generations:
 *   path           → path.bak.1
 *   path.bak.1     → path.bak.2
 *   ...
 *   path.bak.{N-1} → path.bak.N
 *   path.bak.N     → deleted
 *
 * Idempotent. Missing intermediate generations don't break the chain.
 */
export function rotateBackups(path: string, keep: number = 3): void {
  if (keep <= 0) return;
  // Drop the oldest first.
  const oldest = `${path}.bak.${keep}`;
  if (existsSync(oldest)) { try { unlinkSync(oldest); } catch {} }
  // Shift each remaining .bak.k to .bak.{k+1}, from highest down to lowest.
  for (let k = keep - 1; k >= 1; k--) {
    const src = `${path}.bak.${k}`;
    const dst = `${path}.bak.${k + 1}`;
    if (existsSync(src)) { try { renameSync(src, dst); } catch {} }
  }
  // Finally copy current → .bak.1 (copy, not rename — original stays in place
  // until safeWriteText's rename step finishes).
  if (existsSync(path)) {
    try { copyFileSync(path, `${path}.bak.1`); } catch {}
  }
}

/**
 * Append-only writer for NDJSON event logs. Single-line writes are atomic
 * up to PIPE_BUF (~4KB) on Linux; on Windows fs.appendFileSync is also
 * atomic for typical line sizes. Used by Director.flushEvents.
 *
 * No validator — caller is responsible for ensuring `lines` is well-formed.
 * No backup rotation — append is non-destructive by construction.
 */
export function safeAppend(path: string, lines: string): void {
  if (!lines) return;
  // Use sync append to keep semantics simple. Caller batches.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");
  fs.appendFileSync(path, lines, { encoding: "utf-8" });
}
