/**
 * Dashboard sync helper: upload/download files to a static host over SSH.
 *
 * Uses the same pattern as our static-site publish scripts:
 *   cat <local> | ssh -i <key> <remote> "cat > <remoteDir>/<name> && chmod 644 ..."
 *
 * Why `cat | ssh "cat >"` instead of `scp`?
 * Shared shell hosts often have flaky scp semantics across MSYS/Cygwin,
 * but plain stdin redirection over ssh always works. Our publish pipeline
 * has been running this for months without issues — we copy that recipe.
 *
 * Why Git Bash and not native PowerShell ssh?
 * Windows OpenSSH on the user's machine is fine for the actual ssh call,
 * but the `cat "<path>" | ssh ...` pipeline is far more reliable inside
 * Git Bash, where `cat` understands both Windows and MSYS-style paths.
 * The publish pipeline shells out to Git Bash explicitly for this reason.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Strict whitelist for remote filenames. Allows letters, digits, dots,
 * underscores, hyphens — i.e. plain ASCII filenames. Rejects anything
 * with shell metacharacters (`;`, `&`, `|`, `$`, backticks, parens, slashes,
 * spaces, quotes). This keeps cat/ssh interpolation safe even if a future
 * caller passes user-controlled input.
 */
const SAFE_REMOTE_FILENAME = /^[A-Za-z0-9._-]+$/;

export interface DashboardSyncConfig {
  /** Absolute path to bash.exe (Git Bash). */
  bashPath: string;
  /** SSH key path in MSYS form, e.g. /c/Users/me/.ssh/id_ed25519. */
  sshKey: string;
  /** SSH target, e.g. user@host.example.com. */
  remote: string;
  /** Remote directory (with or without trailing slash). */
  remoteDir: string;
  /** Optional: bail out early if true. Used to disable in dev. */
  disabled?: boolean;
}

/**
 * Convert a Windows path like `C:\foo\bar.json` to MSYS-style `/c/foo/bar.json`
 * so Git Bash's `cat` can find it without ambiguity. Forward slashes also
 * accepted unchanged.
 */
export function winToMsys(p: string): string {
  const drive = p.match(/^([a-zA-Z]):[\\\/](.*)$/);
  if (drive) return "/" + drive[1].toLowerCase() + "/" + drive[2].replace(/\\/g, "/");
  return p.replace(/\\/g, "/");
}

/**
 * Upload one file to the dashboard host. Returns when the ssh process exits cleanly.
 * Throws on non-zero exit; callers should catch and log without crashing
 * the router (the host may be temporarily unreachable; we'll retry next tick).
 */
export async function uploadToDashboardHost(
  localPath: string,
  remoteFilename: string,
  cfg: DashboardSyncConfig,
): Promise<void> {
  if (cfg.disabled) return;
  if (!existsSync(cfg.bashPath)) {
    throw new Error(`Git Bash not found at ${cfg.bashPath} — install Git for Windows or override bashPath`);
  }
  if (!existsSync(localPath)) {
    throw new Error(`Local file not found: ${localPath}`);
  }
  // Whitelist guard against shell injection (Gemini review #2, 2026-05-02).
  // Both upload and download interpolate remoteFilename into a string passed
  // to ssh. Even though Director itself uses hardcoded filenames, treat this
  // as a security boundary — any future caller passing user-controlled input
  // would otherwise execute arbitrary commands on the host.
  if (!SAFE_REMOTE_FILENAME.test(remoteFilename)) {
    throw new Error(`Unsafe remote filename: ${JSON.stringify(remoteFilename)}`);
  }
  // Normalize. We pass paths in MSYS form to bash; the dir slash is sanitized.
  const localMsys = winToMsys(localPath);
  const dir = cfg.remoteDir.replace(/\/$/, "");
  const remotePath = `${dir}/${remoteFilename}`;
  // Important: keep StrictHostKeyChecking=accept-new — first-time fingerprint
  // is auto-accepted, but a CHANGED host key still fails (defense against MITM).
  const cmd =
    `cat "${localMsys}" | ` +
    `ssh -i "${cfg.sshKey}" -o StrictHostKeyChecking=accept-new ` +
    `"${cfg.remote}" "cat > ${remotePath} && chmod 644 ${remotePath}"`;
  await execFileAsync(cfg.bashPath, ["-lc", cmd], {
    timeout: 30_000,
    windowsHide: true,
  });
}

/**
 * Download one file FROM the dashboard host into a local path. Used by Director to
 * pull director-overrides.json (set by the hub UI's PHP endpoint).
 *
 * Returns the contents as a string. Throws on transport error; caller
 * should treat that as "no overrides available, fall back to defaults".
 */
export async function downloadFromDashboardHost(
  remoteFilename: string,
  cfg: DashboardSyncConfig,
): Promise<string> {
  if (cfg.disabled) throw new Error("dashboard sync disabled");
  if (!existsSync(cfg.bashPath)) {
    throw new Error(`Git Bash not found at ${cfg.bashPath}`);
  }
  if (!SAFE_REMOTE_FILENAME.test(remoteFilename)) {
    throw new Error(`Unsafe remote filename: ${JSON.stringify(remoteFilename)}`);
  }
  const dir = cfg.remoteDir.replace(/\/$/, "");
  const remotePath = `${dir}/${remoteFilename}`;
  // ssh ... 'cat <remote>' — cleanest way to stream remote file to stdout.
  const cmd =
    `ssh -i "${cfg.sshKey}" -o StrictHostKeyChecking=accept-new ` +
    `"${cfg.remote}" "cat ${remotePath}"`;
  const { stdout } = await execFileAsync(cfg.bashPath, ["-lc", cmd], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}
