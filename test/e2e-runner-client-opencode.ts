/**
 * Router side of the opencode executor: RunnerClient -> runner -> opencode.
 * Needs a running runner of this checkout (runner/data/.runner.port) and an
 * OpenAI-compatible endpoint (a mock is fine, see runner/test/e2e-opencode.ts).
 *
 *   OPENCODE_BIN=opencode E2E_BASE_URL=http://127.0.0.1:8799/v1 \
 *   E2E_PROJECT=/path/to/project bun test/e2e-runner-client-opencode.ts
 */
import { RunnerClient } from "../src/runner-client";
import { storeSession, sessionFor, type ProviderConfig } from "../src/providers";
import type { Settings, TopicMapping } from "../src/config";

const PROJECT = process.env.E2E_PROJECT!;
const provider: ProviderConfig = {
  id: "e2e", executor: "opencode", name: "E2E",
  baseURL: process.env.E2E_BASE_URL!, model: process.env.E2E_MODEL || "mock-agent",
  apiKeyEnv: "E2E_PROVIDER_KEY",
};
const settings = {
  processes: {
    ttlMinutes: 60, maxConcurrent: 2, claudePath: "claude", defaultFlags: [], defaultModel: "opus",
    opencodePath: process.env.OPENCODE_BIN || "opencode", idleTimeoutMinutes: 3,
  },
  runner: { enabled: true },
} as unknown as Settings;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};

const topicKey = "-100e2e:1";
const mapping: TopicMapping = { name: "e2e", project: PROJECT, memory: [], created: "2026-10-03", sessionId: "0f8c2a1e-1b2c-4d5e-8f90-123456789abc" };
const rc = new RunnerClient(settings);
let key: string | undefined = "e2e-key";
rc.setProviderResolver(() => ({ provider, key }));

const blocks: string[] = [];
const r1 = await rc.sendMessage(topicKey, PROJECT, "Прочитай CHECKPOINT.md", sessionFor(mapping, "opencode"), undefined, "opus", "E2E-SYSTEM-MARKER", undefined, (b) => blocks.push(b));
check("reply text", r1.includes("NEXT"), r1);
check("blocks streamed", blocks.length >= 2, String(blocks.length));
const sid = rc.getSessionId(topicKey);
check("opencode session id", /^ses_/.test(sid || ""), sid);
storeSession(mapping, sid);
check("claude session kept", mapping.sessionId === "0f8c2a1e-1b2c-4d5e-8f90-123456789abc" && mapping.sessions?.opencode === sid);

const r2 = await rc.sendMessage(topicKey, PROJECT, "Ещё раз", sessionFor(mapping, "opencode"), undefined, "opus", "E2E-SYSTEM-MARKER");
check("resume same session", rc.getSessionId(topicKey) === sid && r2.length > 0, rc.getSessionId(topicKey));

rc.killTopic(topicKey);
let gone = "";
try {
  await rc.sendMessage(topicKey, PROJECT, "x", "ses_doesnotexist1234", undefined, "opus", "S");
} catch (e) { gone = (e as Error).message; }
check("dead session -> 'session gone' error", gone.includes("session gone"), gone);

rc.killTopic(topicKey);
key = undefined;
let noKey = "";
try {
  await rc.sendMessage(topicKey, PROJECT, "x", undefined, undefined, "opus", "S");
} catch (e) { noKey = (e as Error).message; }
check("missing key -> clear error, no job", noKey.includes("Нет ключа"), noKey);

console.log(failed === 0 ? "E2E RESULT: PASS" : `E2E RESULT: FAIL ${failed}`);
process.exit(failed === 0 ? 0 : 1);
