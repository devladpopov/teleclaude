import { openSync, readSync, fstatSync, closeSync, existsSync } from "fs";
import { join } from "path";
import { parseStreamJsonEvent } from "./stream-parser.ts";
import type { ParsedEvent } from "./stream-parser.ts";

export interface TailerEvent {
  lineContent: string;
  parsed: ParsedEvent | null;
  eventId: number;
}

/**
 * Tails stdout.jsonl by byte offset (not char offset).
 * Uses raw Buffer reads to handle Cyrillic UTF-8 correctly.
 *
 * Completion is signaled externally via markComplete(), not by
 * timeout heuristics.
 */
export class FileTailer {
  private jobDir: string;
  private byteOffset = 0;
  private eventCount = 0;
  private subscribers: Array<(event: TailerEvent) => void> = [];
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private complete = false;
  // Bytes of the incomplete last line. Kept as bytes, not text: a read can
  // end inside a multi-byte UTF-8 character.
  private lineBuf: Buffer = Buffer.alloc(0);

  // Ring buffer of past events for SSE replay
  private eventHistory: TailerEvent[] = [];
  private static MAX_HISTORY = 5000;

  // Per-job parser: executors other than claude keep state between lines
  private parse: (line: string) => ParsedEvent | null;

  constructor(jobDir: string, parse: (line: string) => ParsedEvent | null = parseStreamJsonEvent) {
    this.jobDir = jobDir;
    this.parse = parse;
  }

  start(): void {
    if (this.pollHandle) return;
    this.pollHandle = setInterval(() => this.poll(), 200);
  }

  stop(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /** Mark this tailer as complete (process exited). */
  markComplete(): void {
    // Read what was written since the last poll: the worker appends its
    // last lines right before it exits, possibly between two polls.
    this.poll();
    // Flush remaining partial line
    const rest = this.lineBuf.toString("utf-8").trim();
    this.lineBuf = Buffer.alloc(0);
    if (rest) this.processLine(rest);
    this.complete = true;
  }

  isJobComplete(): boolean {
    return this.complete;
  }

  subscribe(callback: (event: TailerEvent) => void): () => void {
    this.subscribers.push(callback);
    return () => {
      const idx = this.subscribers.indexOf(callback);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  /** Replay events starting after afterEventId. Used for SSE reconnect. */
  replay(afterEventId: number, callback: (event: TailerEvent) => void): void {
    for (const ev of this.eventHistory) {
      if (ev.eventId > afterEventId) {
        callback(ev);
      }
    }
  }

  getEventCount(): number {
    return this.eventCount;
  }

  private poll(): void {
    const filePath = join(this.jobDir, "stdout.jsonl");
    if (!existsSync(filePath)) return;

    let fd: number | undefined;
    try {
      fd = openSync(filePath, "r");
      const stat = fstatSync(fd);
      const fileSize = stat.size;

      if (fileSize <= this.byteOffset) {
        closeSync(fd);
        return;
      }

      const bytesToRead = fileSize - this.byteOffset;
      const buf = Buffer.alloc(bytesToRead);
      readSync(fd, buf, 0, bytesToRead, this.byteOffset);
      closeSync(fd);
      fd = undefined;

      this.byteOffset = fileSize;

      // Decode complete lines only; 0x0A never occurs inside a UTF-8
      // multi-byte sequence, so cutting at the last newline is safe.
      const bytes = this.lineBuf.length ? Buffer.concat([this.lineBuf, buf]) : buf;
      const end = bytes.lastIndexOf(0x0a);
      this.lineBuf = Buffer.from(bytes.subarray(end + 1));
      if (end < 0) return;
      const lines = bytes.subarray(0, end).toString("utf-8").split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.processLine(trimmed);
      }
    } catch {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  private processLine(line: string): void {
    const parsed = this.parse(line);
    const event: TailerEvent = {
      lineContent: line,
      parsed,
      eventId: this.eventCount++,
    };

    // Store in history ring buffer
    this.eventHistory.push(event);
    if (this.eventHistory.length > FileTailer.MAX_HISTORY) {
      this.eventHistory.shift();
    }

    this.emit(event);
  }

  private emit(event: TailerEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // Ignore subscriber errors
      }
    }
  }
}
