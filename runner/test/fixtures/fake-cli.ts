/**
 * Stand-in for the claude / opencode CLI in runner tests. Compiled with
 * `bun build --compile` so the worker can spawn it on any OS (shell:false).
 *
 *   FAKE_RECORD       file to write {argv, stdin, cwd, env} into
 *   FAKE_STDOUT_FILE  file copied to stdout as is (stream-json / opencode json)
 *   FAKE_STDERR       text written to stderr
 *   FAKE_EXIT         exit code (default 0)
 */
import { readFileSync, writeFileSync } from "fs";

const env = process.env;
const stdin = await Bun.stdin.text();
if (env.FAKE_RECORD) {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("FAKE_")));
  writeFileSync(env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), env: childEnv }));
}
if (env.FAKE_STDOUT_FILE) await Bun.write(Bun.stdout, readFileSync(env.FAKE_STDOUT_FILE));
if (env.FAKE_STDERR) await Bun.write(Bun.stderr, env.FAKE_STDERR);
process.exit(Number(env.FAKE_EXIT ?? 0));
