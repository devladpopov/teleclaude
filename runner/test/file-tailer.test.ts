import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileTailer, type TailerEvent } from "../src/file-tailer.ts";
import { createOpencodeParser } from "../src/executors/opencode.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function setup(parse?: (line: string) => any) {
  const dir = mkdtempSync(join(tmpdir(), "tc-tailer-"));
  dirs.push(dir);
  const file = join(dir, "stdout.jsonl");
  const tailer = new FileTailer(dir, parse);
  const events: TailerEvent[] = [];
  tailer.subscribe((e) => events.push(e));
  return { file, tailer, events, poll: () => (tailer as any).poll() };
}

describe("FileTailer", () => {
  test("emits complete lines with growing ids, keeps the partial line for later", () => {
    const { file, events, poll } = setup();
    writeFileSync(file, '{"type":"system","subtype":"init"}\n{"type":"assis');
    poll();
    expect(events.map((e) => e.eventId)).toEqual([0]);
    appendFileSync(file, 'tant","message":{"content":[{"type":"text","text":"hi"}]}}\n\n');
    poll();
    expect(events.map((e) => e.parsed?.type)).toEqual(["system", "assistant"]);
    expect(events[1].parsed?.assistantText).toBe("hi");
    expect(events[1].eventId).toBe(1);
  });

  test("a Cyrillic character split between two reads is not broken", () => {
    // The CLI output arrives through a pipe in arbitrary chunks; a poll can
    // see only the first byte of a two-byte UTF-8 character.
    const { file, events, poll } = setup();
    const line = Buffer.from(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Привет" }] } }) + "\n");
    const cut = line.indexOf(Buffer.from("р")) + 1; // inside "р"
    writeFileSync(file, line.subarray(0, cut));
    poll();
    appendFileSync(file, line.subarray(cut));
    poll();
    expect(events).toHaveLength(1);
    expect(events[0].parsed?.assistantText).toBe("Привет");
  });

  test("replay after a reconnect returns only newer events", () => {
    const { file, tailer, poll } = setup();
    writeFileSync(file, '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    poll();
    const replayed: string[] = [];
    tailer.replay(0, (e) => replayed.push(e.parsed!.type));
    expect(replayed).toEqual(["b", "c"]);
  });

  test("uses the executor parser it was given", () => {
    const { file, events, poll } = setup(createOpencodeParser());
    writeFileSync(file, JSON.stringify({ type: "step_start", sessionID: "ses_f01618370ffezwYXLHTkQb5v8S", part: {} }) + "\n");
    poll();
    expect(events[0].parsed?.raw).toMatchObject({ type: "system", subtype: "init" });
  });

  test("markComplete reads what the worker wrote since the last poll", () => {
    // The job can end between two polls (the worker appends runner_exit and
    // writes exit-code.txt right before it exits); those lines must still
    // reach SSE subscribers before the "completed" event.
    const { file, tailer, events, poll } = setup();
    writeFileSync(file, '{"type":"system","subtype":"init"}\n');
    poll();
    appendFileSync(file, '{"type":"result","result":"done"}\n{"type":"runner_exit","code":1}\n');
    tailer.markComplete();
    expect(events.map((e) => e.parsed?.type)).toEqual(["system", "result", "runner_exit"]);
    expect(tailer.isJobComplete()).toBe(true);
  });

  test("markComplete flushes a last line without a newline", () => {
    const { file, tailer, events } = setup();
    writeFileSync(file, '{"type":"result","result":"done"}');
    tailer.markComplete();
    expect(events.map((e) => e.parsed?.resultText)).toEqual(["done"]);
  });
});
