/**
 * Real-time Knowledge Extractor (Nerve Phase 4).
 *
 * Analyzes every message via Gemini Flash in the background.
 * Decides whether the message contains knowledge worth persisting
 * (facts, decisions, preferences, contacts, deadlines) and updates
 * the appropriate memory file.
 *
 * Also performs periodic context relevance checks: scans topic-memory.md
 * for stale/irrelevant sections and trims them.
 *
 * Cost: ~$0.01-0.03/day (Gemini Flash, ~100-300 messages, ~200 tokens each).
 * Latency: fire-and-forget, never blocks message flow.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import https from "https";
import { MEMORY_BASE_DIR } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractionResult {
  /** "skip" = nothing worth saving. "update" = append to existing file. */
  action: "skip" | "update";
  /** Which memory file to update (relative to project or global memory). */
  target?: "topic-memory" | "people" | "projects" | "services" | "shared";
  /** If target is people/projects/etc, which file (e.g. "john.md"). */
  filename?: string;
  /** Content to append (1-3 lines, factual, no fluff). */
  content?: string;
  /** If the message reveals a deadline, ISO date string. */
  deadline?: string;
}

interface ContextCheckResult {
  /** Sections to remove (by heading text). */
  staleSections: string[];
  /** Total sections checked. */
  totalChecked: number;
}

export interface ExtractorConfig {
  geminiApiKey: string;
  /** Minimum interval between extractions for the same topic (ms). Default 60s. */
  cooldownMs?: number;
  /** Enable context relevance checks. Default true. */
  contextCheckEnabled?: boolean;
  /** How often to run context checks (ms). Default 24h. */
  contextCheckIntervalMs?: number;
  /** Max topic-memory.md size in lines before triggering context check. Default 200. */
  maxTopicMemoryLines?: number;
}

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

function geminiCall(apiKey: string, prompt: string, maxTokens = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.05, maxOutputTokens: maxTokens },
    });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Gemini ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        try {
          const data = JSON.parse(text);
          resolve(data.candidates?.[0]?.content?.parts?.[0]?.text || "");
        } catch {
          reject(new Error("Gemini parse error"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// RealtimeExtractor
// ---------------------------------------------------------------------------

export class RealtimeExtractor {
  private config: ExtractorConfig;
  /** Per-topic cooldown: topicKey -> last extraction timestamp. */
  private lastExtraction = new Map<string, number>();
  /** Per-topic last context check timestamp. */
  private lastContextCheck = new Map<string, number>();
  /** Stats for logging. */
  private stats = { extracted: 0, skipped: 0, errors: 0, contextChecks: 0 };

  constructor(config: ExtractorConfig) {
    this.config = config;
  }

  /**
   * Analyze a message and update memory if needed.
   * Fire-and-forget: never throws, never blocks.
   */
  async extract(params: {
    topicKey: string;
    topicName: string;
    projectPath: string;
    sender: "user" | "bot";
    text: string;
  }): Promise<void> {
    try {
      // Cooldown check
      const cooldown = this.config.cooldownMs ?? 60_000;
      const lastTs = this.lastExtraction.get(params.topicKey) ?? 0;
      if (Date.now() - lastTs < cooldown) {
        this.stats.skipped++;
        return;
      }

      // Skip very short messages (commands, reactions)
      if (params.text.length < 20) {
        this.stats.skipped++;
        return;
      }

      // Skip bot messages that are just status updates
      if (params.sender === "bot" && params.text.length < 80) {
        this.stats.skipped++;
        return;
      }

      this.lastExtraction.set(params.topicKey, Date.now());

      // Read current topic-memory for context
      const topicMemPath = join(params.projectPath, "topic-memory.md");
      const currentMemory = existsSync(topicMemPath)
        ? readFileSync(topicMemPath, "utf-8").slice(0, 2000)
        : "(empty)";

      const result = await this.callExtraction(
        params.topicName,
        params.sender,
        params.text,
        currentMemory,
      );

      if (result.action === "skip") {
        this.stats.skipped++;
        return;
      }

      if (result.action === "update" && result.content) {
        this.applyUpdate(params.projectPath, result);
        this.stats.extracted++;
        console.log(`[Extractor] Updated ${result.target || "topic-memory"} for ${params.topicName}`);
      }

      // Context check: if topic-memory is getting large
      await this.maybeContextCheck(params.topicKey, params.topicName, params.projectPath);

    } catch (err) {
      this.stats.errors++;
      // Never throw — fire and forget
      console.error(`[Extractor] Error for ${params.topicName}: ${(err as Error).message}`);
    }
  }

  private async callExtraction(
    topicName: string,
    sender: string,
    text: string,
    currentMemory: string,
  ): Promise<ExtractionResult> {
    const prompt = `You are a knowledge extraction system. Analyze this message from a Telegram conversation in topic "${topicName}".

CURRENT MEMORY (first 2000 chars):
${currentMemory}

MESSAGE (from ${sender}):
${text.slice(0, 1500)}

TASK: Decide if this message contains knowledge worth persisting long-term. Worth saving:
- Decisions made ("we will use X", "switched to Y")
- Facts learned ("server IP is X", "deadline is Y")
- People mentioned with roles ("X is our accountant")
- Technical discoveries ("library Z doesn't support W")
- Status changes ("project X is now complete")
- User preferences or corrections

NOT worth saving:
- Routine status updates ("audit #200 done")
- Greetings, acknowledgments
- Questions without answers
- Temporary debugging info
- Content already in CURRENT MEMORY

Output ONLY a JSON object (no markdown fences):
{"action":"skip"} if nothing worth saving, or:
{"action":"update","target":"topic-memory","content":"## Section\\n- fact to add"}

target can be: "topic-memory" (default, for topic-specific info), "people" (with filename like "john.md"), "projects", "services", "shared" (cross-topic knowledge).
For people/projects/services/shared, add "filename":"name.md".
content: 1-3 lines max. Factual. Russian language. Include a date prefix like (26.06) for temporal facts.`;

    const raw = await geminiCall(this.config.geminiApiKey, prompt, 256);
    const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

    try {
      return JSON.parse(cleaned) as ExtractionResult;
    } catch {
      return { action: "skip" };
    }
  }

  private applyUpdate(projectPath: string, result: ExtractionResult): void {
    if (!result.content) return;

    let targetPath: string;

    if (result.target === "topic-memory" || !result.target) {
      targetPath = join(projectPath, "topic-memory.md");
    } else if (result.target === "people" || result.target === "projects" ||
               result.target === "services" || result.target === "shared") {
      const filename = result.filename || "extracted.md";
      targetPath = join(MEMORY_BASE_DIR, result.target, filename);
    } else {
      targetPath = join(projectPath, "topic-memory.md");
    }

    // Safety: don't create files in unexpected places
    if (!targetPath.startsWith(projectPath) && !targetPath.startsWith(MEMORY_BASE_DIR)) {
      return;
    }

    const dir = dirname(targetPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let existing = "";
    if (existsSync(targetPath)) {
      existing = readFileSync(targetPath, "utf-8");
    }

    // Dedup: don't append if content already exists
    const contentTrimmed = result.content.trim();
    if (existing.includes(contentTrimmed)) {
      return;
    }

    // Append with separator
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(targetPath, existing + separator + contentTrimmed + "\n", "utf-8");
  }

  // ---------------------------------------------------------------------------
  // Context Relevance Check
  // ---------------------------------------------------------------------------

  /**
   * If topic-memory.md exceeds maxLines, ask Gemini to identify stale sections.
   * Runs at most once per contextCheckIntervalMs per topic.
   */
  private async maybeContextCheck(
    topicKey: string,
    topicName: string,
    projectPath: string,
  ): Promise<void> {
    if (this.config.contextCheckEnabled === false) return;

    const interval = this.config.contextCheckIntervalMs ?? 24 * 60 * 60 * 1000;
    const lastCheck = this.lastContextCheck.get(topicKey) ?? 0;
    if (Date.now() - lastCheck < interval) return;

    const topicMemPath = join(projectPath, "topic-memory.md");
    if (!existsSync(topicMemPath)) return;

    const content = readFileSync(topicMemPath, "utf-8");
    const lineCount = content.split("\n").length;
    const maxLines = this.config.maxTopicMemoryLines ?? 200;

    if (lineCount < maxLines) return;

    this.lastContextCheck.set(topicKey, Date.now());

    try {
      const result = await this.checkContextRelevance(topicName, content);
      if (result.staleSections.length > 0) {
        this.pruneStaleSections(topicMemPath, content, result.staleSections);
        this.stats.contextChecks++;
        console.log(
          `[Extractor] Context check ${topicName}: removed ${result.staleSections.length}/${result.totalChecked} stale sections`,
        );
      }
    } catch (err) {
      console.error(`[Extractor] Context check error: ${(err as Error).message}`);
    }
  }

  private async checkContextRelevance(
    topicName: string,
    content: string,
  ): Promise<ContextCheckResult> {
    const prompt = `You are a memory curator for topic "${topicName}". Review this topic-memory.md file and identify sections that are STALE or IRRELEVANT.

A section is stale if:
- It describes completed work that is no longer actionable (e.g. "deployed X on 15.05")
- It contains outdated status info superseded by newer entries
- It duplicates info that exists elsewhere in the file
- It contains temporary debugging notes

A section is NOT stale if:
- It documents architecture decisions (WHY something was done)
- It contains active configuration (IPs, URLs, credentials references)
- It describes ongoing work or future plans
- It contains reference info (people, contacts, project structure)

CONTENT:
${content.slice(0, 6000)}

Output ONLY a JSON object (no markdown fences):
{"staleSections":["exact heading text 1","exact heading text 2"],"totalChecked":N}

staleSections: array of exact ## or ### heading texts to remove (with their content until next heading). Empty array if nothing is stale.`;

    const raw = await geminiCall(this.config.geminiApiKey, prompt, 512);
    const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

    try {
      return JSON.parse(cleaned) as ContextCheckResult;
    } catch {
      return { staleSections: [], totalChecked: 0 };
    }
  }

  private pruneStaleSections(
    filePath: string,
    content: string,
    staleSections: string[],
  ): void {
    // Archive before pruning
    const archivePath = filePath.replace(/\.md$/, ".archive.md");
    const archiveContent = existsSync(archivePath)
      ? readFileSync(archivePath, "utf-8")
      : "";

    let pruned = content;
    const archived: string[] = [];

    for (const heading of staleSections) {
      // Find the section: heading line + everything until next same-or-higher level heading
      const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `(^|\n)(#{2,3}\\s+${escapedHeading}\\s*\n)([\\s\\S]*?)(?=\n#{2,3}\\s|$)`,
        "m",
      );
      const match = pruned.match(pattern);
      if (match) {
        archived.push(match[2] + match[3]);
        pruned = pruned.replace(match[0], match[1]);
      }
    }

    if (archived.length > 0) {
      // Save archived sections
      const timestamp = new Date().toISOString().slice(0, 10);
      const archiveBlock = `\n---\nArchived ${timestamp} by context-check:\n${archived.join("\n")}\n`;
      writeFileSync(archivePath, archiveContent + archiveBlock, "utf-8");

      // Write pruned content
      pruned = pruned.replace(/\n{3,}/g, "\n\n").trim() + "\n";
      writeFileSync(filePath, pruned, "utf-8");
    }
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(): { extracted: number; skipped: number; errors: number; contextChecks: number } {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = { extracted: 0, skipped: 0, errors: 0, contextChecks: 0 };
  }
}
