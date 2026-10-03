import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildProviderEnv, clearSession, executorOfSession, loadProviders, providerTag,
  readProviderKey, resolveTopicProvider, sessionFor, storeSession, validateProvider,
  type ProviderConfig,
} from "../src/providers";
import type { TopicMapping } from "../src/config";

const dir = mkdtempSync(join(tmpdir(), "tc-providers-"));
const UUID = "0f8c2a1e-1b2c-4d5e-8f90-123456789abc";
const SES = "ses_f01618370ffezwYXLHTkQb5v8S";

const deepseek: ProviderConfig = {
  id: "deepseek", executor: "opencode", name: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat",
  apiKeyEnv: "DEEPSEEK_API_KEY", keyFile: join(dir, "deepseek.env"),
};

function mapping(extra: Partial<TopicMapping> = {}): TopicMapping {
  return { name: "t", project: "/p", memory: [], created: "2026-10-03", ...extra };
}

describe("providers.json", () => {
  test("missing file: only claude, default claude", () => {
    const f = loadProviders(join(dir, "nope.json"));
    expect(f.providers.map((p) => p.id)).toEqual(["claude"]);
    expect(resolveTopicProvider(mapping(), f).id).toBe("claude");
  });

  test("invalid entries are skipped, claude always present", () => {
    const path = join(dir, "providers.json");
    writeFileSync(path, JSON.stringify({
      default: "deepseek",
      providers: [deepseek, { id: "bad", executor: "opencode", baseURL: "ftp://x" }],
    }));
    const f = loadProviders(path);
    expect(f.providers.map((p) => p.id).sort()).toEqual(["claude", "deepseek"]);
    expect(resolveTopicProvider(mapping(), f).id).toBe("deepseek");
    expect(resolveTopicProvider(mapping({ provider: "claude" }), f).id).toBe("claude");
    // unknown override falls back to the file default
    expect(resolveTopicProvider(mapping({ provider: "gone" }), f).id).toBe("deepseek");
  });

  test("validation messages", () => {
    expect(validateProvider(deepseek)).toEqual([]);
    expect(validateProvider({ id: "x", executor: "opencode" } as ProviderConfig).length).toBe(3);
  });
});

describe("keys", () => {
  test("keyFile wins, quotes stripped, other vars ignored", () => {
    writeFileSync(deepseek.keyFile!, "# comment\nOTHER=1\nDEEPSEEK_API_KEY=\"sk-from-file\"\n");
    expect(readProviderKey(deepseek)).toBe("sk-from-file");
  });

  test("falls back to process env, undefined when nowhere", () => {
    const p = { ...deepseek, keyFile: join(dir, "missing.env"), apiKeyEnv: "TC_TEST_KEY_X" };
    expect(readProviderKey(p)).toBeUndefined();
    process.env.TC_TEST_KEY_X = "sk-env";
    expect(readProviderKey(p)).toBe("sk-env");
    delete process.env.TC_TEST_KEY_X;
  });

  test("job env: router secrets removed, only this provider key added", () => {
    const env = buildProviderEnv({
      PATH: "/bin", TOPIC_CHAT_ID: "-100", TELEGRAM_BOT_TOKEN: "t", ROUTER_WEBHOOK_SECRET: "s",
      CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", QWEN_API_KEY: "q",
      ROUTER_INTERNAL_SECRET: "i",
    }, deepseek, "sk-1");
    // ROUTER_INTERNAL_SECRET stays: router-mcp needs it for trigger_topic
    expect(env).toEqual({ PATH: "/bin", TOPIC_CHAT_ID: "-100", ROUTER_INTERNAL_SECRET: "i", DEEPSEEK_API_KEY: "sk-1" });
  });
});

describe("sessions per (topic, executor)", () => {
  test("id format tells the executor", () => {
    expect(executorOfSession(UUID)).toBe("claude");
    expect(executorOfSession(SES)).toBe("opencode");
    expect(executorOfSession("topic-1-abc")).toBeUndefined();
  });

  test("switching back and forth keeps both sessions", () => {
    const m = mapping({ sessionId: UUID });
    expect(storeSession(m, SES)).toBe(true);
    expect(m.sessionId).toBe(UUID);
    expect(sessionFor(m, "claude")).toBe(UUID);
    expect(sessionFor(m, "opencode")).toBe(SES);
    expect(storeSession(m, SES)).toBe(false);
    expect(clearSession(m, "opencode")).toBe(true);
    expect(m.sessions).toBeUndefined();
    expect(sessionFor(m, "claude")).toBe(UUID);
  });

  test("a foreign id in the wrong slot is never returned", () => {
    const m = mapping({ sessionId: SES as string });
    expect(sessionFor(m, "claude")).toBeUndefined();
  });
});

describe("reply prefix", () => {
  test("tag from provider and model", () => {
    expect(providerTag(deepseek)).toBe("deepseek:deepseek-chat");
    expect(providerTag({ ...deepseek, id: "cloudru", model: "Qwen/Qwen3-235B-A22B-Instruct-2507" })).toBe("cloudru:Qwen3-235B-A22B-Instruct-2507");
    expect(providerTag({ ...deepseek, tag: "yandexgpt" })).toBe("yandexgpt");
  });
});

describe("providers.json: example and reload", () => {
  test("config/providers.example.json is valid as shipped", () => {
    const f = loadProviders(join(import.meta.dir, "..", "config", "providers.example.json"));
    expect(f.default).toBe("claude");
    expect(f.providers.map((p) => p.id)).toEqual(["claude", "deepseek", "qwen", "cloudru", "yandexgpt", "gigachat"]);
    expect(f.providers.filter((p) => p.executor === "opencode").every((p) => validateProvider(p).length === 0)).toBe(true);
  });

  test("broken JSON: only claude", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    expect(loadProviders(path).providers.map((p) => p.id)).toEqual(["claude"]);
  });

  test("unknown default falls back to claude", () => {
    const path = join(dir, "bad-default.json");
    writeFileSync(path, JSON.stringify({ default: "gone", providers: [deepseek] }));
    expect(resolveTopicProvider(mapping(), loadProviders(path)).id).toBe("claude");
  });

  test("file is re-read after a change, no restart", () => {
    const path = join(dir, "reload.json");
    writeFileSync(path, JSON.stringify({ providers: [] }));
    utimesSync(path, 1_000, 1_000);
    expect(loadProviders(path).providers.map((p) => p.id)).toEqual(["claude"]);
    writeFileSync(path, JSON.stringify({ providers: [deepseek] }));
    utimesSync(path, 2_000, 2_000);
    expect(loadProviders(path).providers.map((p) => p.id)).toEqual(["claude", "deepseek"]);
  });

  test("validation: bad id, bad executor, claude needs no URL", () => {
    expect(validateProvider({ id: "a b", executor: "claude" } as ProviderConfig)).toHaveLength(1);
    expect(validateProvider({ id: "x", executor: "codex" } as any)).toHaveLength(1);
    expect(validateProvider({ id: "claude2", executor: "claude" })).toEqual([]);
    expect(validateProvider({ ...deepseek, apiKeyEnv: "deepseek-key" })).toHaveLength(1);
  });
});

describe("keys: file formats", () => {
  test("export prefix and single quotes", () => {
    const file = join(dir, "export.env");
    writeFileSync(file, "export DEEPSEEK_API_KEY='sk-export'\r\n");
    expect(readProviderKey({ ...deepseek, keyFile: file })).toBe("sk-export");
  });

  test("empty value in the file falls back to the process env", () => {
    const file = join(dir, "empty.env");
    writeFileSync(file, "TC_TEST_KEY_Y=\n");
    process.env.TC_TEST_KEY_Y = "sk-env-y";
    expect(readProviderKey({ ...deepseek, keyFile: file, apiKeyEnv: "TC_TEST_KEY_Y" })).toBe("sk-env-y");
    delete process.env.TC_TEST_KEY_Y;
  });

  test("provider without apiKeyEnv has no key", () => {
    expect(readProviderKey({ id: "local", executor: "opencode" })).toBeUndefined();
  });

  test("job env without a key: secrets still removed, nothing added", () => {
    expect(buildProviderEnv({ PATH: "/bin", github_token: "g", MY_PASSWORD: "p" }, deepseek, undefined)).toEqual({ PATH: "/bin" });
  });
});

describe("sessions: edge cases", () => {
  test("garbage id is not stored, clearing an empty slot is a no-op", () => {
    const m = mapping();
    expect(storeSession(m, "not-a-session")).toBe(false);
    expect(storeSession(m, undefined)).toBe(false);
    expect(clearSession(m, "claude")).toBe(false);
    expect(clearSession(m, "opencode")).toBe(false);
    expect(m).toEqual(mapping());
  });

  test("claude slot: store, same id again is no change, clear", () => {
    const m = mapping();
    expect(storeSession(m, UUID)).toBe(true);
    expect(storeSession(m, UUID)).toBe(false);
    expect(clearSession(m, "claude")).toBe(true);
    expect(m.sessionId).toBeUndefined();
  });

  test("tag without a model is the provider id", () => {
    expect(providerTag({ id: "local", executor: "opencode" })).toBe("local");
  });
});
