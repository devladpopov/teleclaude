/**
 * End-to-end check of the opencode executor through a running runner.
 *
 * Needs: a runner (bun run src/index.ts), the opencode binary and an
 * OpenAI-compatible endpoint. Any endpoint works; for an offline check use
 * a mock that answers the model "mock-agent" with a read(CHECKPOINT.md)
 * tool call and "mock-429" with HTTP 429.
 *
 *   RUNNER_URL=http://127.0.0.1:7878 OPENCODE_BIN=opencode \
 *   E2E_BASE_URL=http://127.0.0.1:8799/v1 E2E_MODEL=mock-agent \
 *   E2E_PROJECT=/path/to/project bun test/e2e-opencode.ts
 *
 * The project needs a CHECKPOINT.md. Exit code 0 = all checks passed.
 */
const RUNNER = process.env.RUNNER_URL || "http://127.0.0.1:7878";
const BIN = process.env.OPENCODE_BIN || "opencode";
const BASE_URL = process.env.E2E_BASE_URL!;
const MODEL = process.env.E2E_MODEL || "mock-agent";
const MODEL_429 = process.env.E2E_MODEL_429; // optional
const PROJECT = process.env.E2E_PROJECT!;
const KEY = process.env.E2E_API_KEY || "e2e-key-not-secret";
if (!BASE_URL || !PROJECT) {
  console.error("E2E_BASE_URL and E2E_PROJECT are required");
  process.exit(2);
}

// Only what opencode needs to run plus the provider key: nothing else from
// the runner environment reaches the job.
const PASS_ENV = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];
const jobEnv: Record<string, string> = { E2E_PROVIDER_KEY: KEY };
for (const k of PASS_ENV) if (process.env[k]) jobEnv[k] = process.env[k]!;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
}

async function runJob(message: string, extra: Record<string, unknown>) {
  const res = await fetch(`${RUNNER}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topicKey: "e2e:opencode",
      projectPath: PROJECT,
      message,
      executor: "opencode",
      executorPath: BIN,
      appendSystemPrompt: "E2E-SYSTEM-MARKER: answer briefly.",
      env: jobEnv,
      idleTimeoutMinutes: 3,
      ...extra,
    }),
  });
  const { jobId } = (await res.json()) as { jobId: string };
  const events: any[] = [];
  let completed: any = null;
  const sse = await fetch(`${RUNNER}/jobs/${jobId}/events`);
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 180_000;
  while (!completed && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      if (type === "stream-json") events.push(JSON.parse(data));
      if (type === "completed") completed = JSON.parse(data);
    }
  }
  try { reader.cancel(); } catch {}
  return { jobId, events, completed, result: events.filter((e) => e.type === "result").at(-1) };
}

const provider = (model: string) => ({ id: "e2e", baseURL: BASE_URL, model, apiKeyEnv: "E2E_PROVIDER_KEY" });

// 1. New session: tool call + final answer in claude-compatible events
const r1 = await runJob("Прочитай CHECKPOINT.md и скажи, что в NEXT", { provider: provider(MODEL) });
check("job 1 completed", r1.completed?.state === "completed", JSON.stringify(r1.completed));
check("job 1 init event", r1.events[0]?.type === "system" && r1.events[0]?.subtype === "init");
check("job 1 tool_use", r1.events.some((e) => e.message?.content?.some((b: any) => b.type === "tool_use")));
check("job 1 result text", typeof r1.result?.result === "string" && r1.result.result.length > 0, r1.result?.result);
const sid = r1.completed?.sessionId;
check("job 1 opencode session id", /^ses_/.test(sid || ""), sid);

// 2. Resume the same session
const r2 = await runJob("Повтори одним словом", { provider: provider(MODEL), sessionId: sid });
check("job 2 resumed same session", r2.completed?.sessionId === sid, r2.completed?.sessionId);
check("job 2 result", r2.result?.subtype === "success", r2.result?.result);

// 3. Dead session id: router must get "No conversation found"
const r3 = await runJob("x", { provider: provider(MODEL), sessionId: "ses_doesnotexist1234" });
check("job 3 session gone", r3.result?.errors?.some((e: string) => e.includes("No conversation found")) === true && r3.result?.result === undefined, r3.result?.errors?.[0]);

// 4. Rate limit (optional)
if (MODEL_429) {
  const r4 = await runJob("x", { provider: provider(MODEL_429) });
  check("job 4 rate limit result", /\b429\b|rate.?limit/i.test(r4.result?.result || ""), r4.result?.result);
  check("job 4 failed state", r4.completed?.state === "failed", r4.completed?.state);
}

console.log(failed === 0 ? "E2E RESULT: PASS" : `E2E RESULT: FAIL ${failed}`);
process.exit(failed === 0 ? 0 : 1);
