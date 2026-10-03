/**
 * Claude gets --mcp-config only when the file exists: `claude -p` exits
 * with "Invalid MCP configuration: MCP config file not found" otherwise,
 * so on a fresh install every message failed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { claudeReply, createHarness, type Harness } from "./helpers/router-harness";

describe("runner mode", () => {
  test("no spawn-mcp-config.json: no --mcp-config flag", async () => {
    const h = await createHarness({ mcpConfig: false });
    try {
      h.scripts.push(claudeReply("ok"));
      await h.send("Привет");
      expect(h.jobs.at(-1).flags).not.toContain("--mcp-config");
    } finally {
      h.close();
    }
  });

  test("with the file: --mcp-config <file>", async () => {
    const h = await createHarness();
    try {
      h.scripts.push(claudeReply("ok"));
      await h.send("Привет");
      const flags: string[] = h.jobs.at(-1).flags;
      expect(flags[flags.indexOf("--mcp-config") + 1]).toBe(join(h.root, "home", "spawn-mcp-config.json"));
    } finally {
      h.close();
    }
  });
});

describe("direct spawn (runner.enabled = false)", () => {
  const REPO = resolve(import.meta.dir, "..");
  let tmp: string;
  let fakeCli: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tc-direct-"));
    fakeCli = join(tmp, process.platform === "win32" ? "fake-claude.exe" : "fake-claude");
    const build = Bun.spawnSync([process.execPath, "build", "--compile", join(REPO, "runner", "test", "fixtures", "fake-cli.ts"), "--outfile", fakeCli]);
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    process.env.FAKE_STDOUT_FILE = join(REPO, "runner", "test", "fixtures", "claude", "run-ok.jsonl");
  }, 60_000);
  afterAll(() => {
    delete process.env.FAKE_STDOUT_FILE;
    delete process.env.FAKE_RECORD;
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  async function run(mcpConfig: boolean) {
    const record = join(tmp, `record-${mcpConfig}.json`);
    process.env.FAKE_RECORD = record;
    const h: Harness = await createHarness({ runner: false, mcpConfig, processes: { claudePath: fakeCli } });
    try {
      await h.send("Привет");
      expect(existsSync(record)).toBe(true);
      return { argv: JSON.parse(readFileSync(record, "utf-8")).argv as string[], replies: h.replies(), root: h.root };
    } finally {
      h.close();
    }
  }

  test("no spawn-mcp-config.json: no --mcp-config flag, the reply arrives", async () => {
    const r = await run(false);
    expect(r.argv).not.toContain("--mcp-config");
    expect(r.replies).toContain("[opus-5.5] Статус IN_PROGRESS, продолжаю.");
  });

  test("with the file: --mcp-config <file>", async () => {
    const r = await run(true);
    expect(r.argv[r.argv.indexOf("--mcp-config") + 1]).toBe(join(r.root, "home", "spawn-mcp-config.json"));
  });
});
