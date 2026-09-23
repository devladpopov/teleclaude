import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, renameSync } from "fs";
import { join, resolve, relative, dirname, basename } from "path";
import type { Settings } from "./config";
import { MEMORY_BASE_DIR } from "./config";

/**
 * Memory Manager — periodically reviews and organizes memory files.
 *
 * Responsibilities:
 * - Detect duplicate content across memory files
 * - Remove empty sections and excessive whitespace
 * - Cross-file deduplication within a project's memory/ directory
 * - TTL-based expiration: move expired memories to archive/
 * - Log revision statistics
 */

type DocStatus = "draft" | "current" | "stale" | "superseded" | "archive";
type DocGenre = "project" | "person" | "service" | "reference" | "decision" | "log";

interface MemoryFrontmatter {
  created?: string;
  ttl?: string | null;
  priority?: string;
  status?: DocStatus;
  genre?: DocGenre;
  verified?: string;       // YYYY-MM-DD last checked against reality
  superseded_by?: string;  // path to successor document
  [key: string]: unknown;
}

/** Tombstone entry for deleted/archived files */
interface TombstoneEntry {
  file: string;
  date: string;
  reason: string;
  successor?: string;
}
export class MemoryManager {
  private settings: Settings;
  private revisionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /**
   * Start periodic memory revision.
   */
  start(): void {
    if (!this.settings.memory.enabled) {
      console.log("[MemoryManager] Disabled in settings");
      return;
    }

    const intervalMs = this.settings.memory.revisionIntervalMinutes * 60 * 1000;
    console.log(`[MemoryManager] Starting revision every ${this.settings.memory.revisionIntervalMinutes} min`);

    // Run first revision after a short delay (don't block startup)
    setTimeout(() => this.runRevision(), 30_000);

    this.revisionTimer = setInterval(() => {
      this.runRevision();
    }, intervalMs);
  }

  stop(): void {
    if (this.revisionTimer) {
      clearInterval(this.revisionTimer);
      this.revisionTimer = null;
    }
  }

  /**
   * Run a full memory revision across all project directories.
   */
  async runRevision(): Promise<void> {
    console.log("[MemoryManager] Starting memory revision...");

    const projectsRoot = this.settings.projectsRoot;
    if (!existsSync(projectsRoot)) return;

    const entries = readdirSync(projectsRoot, { withFileTypes: true });
    let revisedCount = 0;
    let totalProjects = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = join(projectsRoot, entry.name);
      const topicMem = join(projectPath, "topic-memory.md");

      if (!existsSync(topicMem)) continue;
      totalProjects++;

      // Revise topic-memory.md
      const revised = this.reviseFile(topicMem);
      if (revised) revisedCount++;

      // Cross-file deduplication within memory/ directory
      if (this.settings.memory.deduplication) {
        this.crossFileDedup(projectPath);
      }
    }

    console.log(`[MemoryManager] Revision complete. ${revisedCount}/${totalProjects} files updated.`);

    // TTL check on global memory files
    const ttlResult = this.checkTTLExpiration();
    if (ttlResult.archived > 0) {
      console.log(`[MemoryManager] TTL: archived ${ttlResult.archived} expired files, ${ttlResult.stale} marked stale.`);
    }
  }

  /**
   * Revise a single memory file:
   * - Remove duplicate lines
   * - Remove empty sections
   * - Trim excessive whitespace
   */
  private reviseFile(filePath: string): boolean {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const maxLines = this.settings.memory.maxFileLines;

    // Check if file needs revision
    if (lines.length <= maxLines && !this.hasDuplicates(lines)) {
      return false;
    }

    let revised = content;

    // Remove duplicate lines (keeping first occurrence)
    if (this.settings.memory.deduplication) {
      revised = this.deduplicateContent(revised);
    }

    // Remove empty sections (## Header followed by nothing)
    revised = this.removeEmptySections(revised);

    // Trim excessive blank lines
    revised = revised.replace(/\n{3,}/g, "\n\n");

    // Trim trailing whitespace on each line
    revised = revised.split("\n").map(l => l.trimEnd()).join("\n");

    if (revised !== content) {
      writeFileSync(filePath, revised, "utf-8");
      const newLines = revised.split("\n").length;
      console.log(`[MemoryManager] Revised: ${filePath} (${lines.length} -> ${newLines} lines)`);
      return true;
    }

    return false;
  }

  /**
   * Cross-file deduplication: find content duplicated between topic-memory.md
   * and files in memory/ subdirectories. If topic-memory repeats info that's
   * already in a shared memory file, remove it from topic-memory.
   */
  private crossFileDedup(projectPath: string): void {
    const topicMemPath = join(projectPath, "topic-memory.md");
    if (!existsSync(topicMemPath)) return;

    const topicContent = readFileSync(topicMemPath, "utf-8");
    const topicLines = topicContent.split("\n");

    // Collect all content lines from memory/ files
    const sharedContent = new Set<string>();
    const memoryDir = join(projectPath, "memory");
    if (existsSync(memoryDir)) {
      this.collectLines(memoryDir, sharedContent);
    }

    if (sharedContent.size === 0) return;

    // Remove lines from topic-memory that exist in shared memory
    const result: string[] = [];
    let removedCount = 0;
    for (const line of topicLines) {
      const trimmed = line.trim();
      // Keep headers, empty lines, short lines
      if (trimmed.startsWith("#") || trimmed === "" || trimmed === "---" || trimmed.length < 20) {
        result.push(line);
        continue;
      }
      if (sharedContent.has(trimmed)) {
        removedCount++;
        continue;
      }
      result.push(line);
    }

    if (removedCount > 0) {
      let revised = result.join("\n");
      revised = this.removeEmptySections(revised);
      revised = revised.replace(/\n{3,}/g, "\n\n");
      writeFileSync(topicMemPath, revised, "utf-8");
      console.log(`[MemoryManager] Cross-dedup: removed ${removedCount} duplicate lines from ${topicMemPath}`);
    }
  }

  /**
   * Recursively collect non-trivial content lines from .md files in a directory.
   */
  private collectLines(dir: string, target: Set<string>): void {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.collectLines(path, target);
      } else if (entry.name.endsWith(".md")) {
        const content = readFileSync(path, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length >= 20 && !trimmed.startsWith("#")) {
            target.add(trimmed);
          }
        }
      }
    }
  }

  /**
   * Check if content has duplicate non-trivial lines.
   */
  private hasDuplicates(lines: string[]): boolean {
    const seen = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 10) continue;
      if (trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("-") && trimmed.length < 20) continue;
      if (seen.has(trimmed)) return true;
      seen.add(trimmed);
    }
    return false;
  }

  /**
   * Remove duplicate content blocks while preserving structure.
   */
  private deduplicateContent(content: string): string {
    const lines = content.split("\n");
    const result: string[] = [];
    const seenContent = new Set<string>();

    for (const line of lines) {
      const trimmed = line.trim();

      // Always keep headers, empty lines, frontmatter
      if (trimmed.startsWith("#") || trimmed === "" || trimmed === "---") {
        result.push(line);
        continue;
      }

      // Skip exact duplicate non-trivial lines
      if (trimmed.length >= 10 && seenContent.has(trimmed)) {
        continue;
      }

      seenContent.add(trimmed);
      result.push(line);
    }

    return result.join("\n");
  }

  /**
   * Remove sections that have a header but no content.
   */
  private removeEmptySections(content: string): string {
    const lines = content.split("\n");
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check if this is a header followed by another header or end of file
      if (trimmed.startsWith("##") && !trimmed.startsWith("###")) {
        const nextContentLine = this.findNextContentLine(lines, i + 1);
        if (nextContentLine === null || lines[nextContentLine].trim().startsWith("##")) {
          // Empty section — skip header
          continue;
        }
      }

      result.push(line);
    }

    return result.join("\n");
  }

  /**
   * Find next non-empty line index.
   */
  private findNextContentLine(lines: string[], startIndex: number): number | null {
    for (let i = startIndex; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === "") continue;
      return i;
    }
    return null;
  }

  // ─── TTL EXPIRATION ────────────────────────────────────────────

  /**
   * Parse YAML frontmatter from a markdown file.
   */
  private parseFrontmatter(content: string): { fields: MemoryFrontmatter; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { fields: {}, body: content };

    const fields: MemoryFrontmatter = {};
    for (const line of match[1].split("\n")) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) {
        const val = kv[2].trim();
        if (val === "null" || val === "") fields[kv[1]] = null;
        else if (val === "true") fields[kv[1]] = true;
        else if (val === "false") fields[kv[1]] = false;
        else fields[kv[1]] = val;
      }
    }
    return { fields, body: match[2] };
  }

  /**
   * Parse TTL string like "30d", "90d" into milliseconds.
   */
  private parseTTL(ttl: string): number | null {
    const m = ttl.match(/^(\d+)d$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 24 * 60 * 60 * 1000;
  }

  /**
   * Check all memory files in MEMORY_BASE_DIR for status lifecycle transitions.
   *
   * Lifecycle: draft -> current -> stale -> archive
   *
   * Rules:
   * - TTL expired + status "current" -> mark "stale" (not archive directly)
   * - TTL expired + status "stale" for > 30 days -> move to archive/
   * - status "superseded" for > 7 days -> move to archive/
   * - No status field -> treat as "current" (backward compat)
   * - Log all transitions to tombstone.md
   */
  checkTTLExpiration(): { archived: number; stale: number; checked: number } {
    const memRoot = MEMORY_BASE_DIR;
    if (!existsSync(memRoot)) return { archived: 0, stale: 0, checked: 0 };

    const archiveDir = join(memRoot, "archive");
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

    const files = this.walkMdFiles(memRoot);
    let archived = 0;
    let stale = 0;
    let checked = 0;
    const now = Date.now();
    const STALE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in stale before archive
    const SUPERSEDED_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days after superseded

    for (const filePath of files) {
      const rel = relative(memRoot, filePath);
      if (rel.startsWith("archive")) continue;

      checked++;
      const content = readFileSync(filePath, "utf-8");
      const { fields, body } = this.parseFrontmatter(content);
      const docStatus = (fields.status as DocStatus) || "current";

      // Handle superseded documents: archive after grace period
      if (docStatus === "superseded") {
        const verifiedDate = fields.verified ? new Date(fields.verified as string).getTime() : 0;
        if (verifiedDate && now - verifiedDate > SUPERSEDED_GRACE_MS) {
          this.archiveFile(filePath, memRoot, archiveDir, `superseded, successor: ${fields.superseded_by || "unknown"}`);
          archived++;
        }
        continue;
      }

      // Already archived status: move physically
      if (docStatus === "archive") {
        this.archiveFile(filePath, memRoot, archiveDir, "status set to archive");
        archived++;
        continue;
      }

      // TTL check for current/draft documents
      if (!fields.ttl || typeof fields.ttl !== "string") continue;
      if (!fields.created) continue;

      const ttlMs = this.parseTTL(fields.ttl);
      if (ttlMs === null) continue;

      const createdMs = new Date(fields.created as string).getTime();
      if (isNaN(createdMs)) continue;

      const age = now - createdMs;
      if (age <= ttlMs) continue;

      // TTL expired
      const daysOld = Math.round(age / (24 * 60 * 60 * 1000));

      if (docStatus === "current" || docStatus === "draft") {
        // First transition: current/draft -> stale (not archive directly)
        this.setStatus(filePath, content, fields, "stale");
        stale++;
        console.log(`[MemoryManager] TTL expired: ${rel} (${daysOld}d old) -> marked stale`);
      } else if (docStatus === "stale") {
        // Already stale: check if stale long enough to archive
        const verifiedDate = fields.verified ? new Date(fields.verified as string).getTime() : createdMs + ttlMs;
        if (now - verifiedDate > STALE_GRACE_MS) {
          this.archiveFile(filePath, memRoot, archiveDir, `stale for ${Math.round((now - verifiedDate) / (24*60*60*1000))}d, TTL=${fields.ttl}`);
          archived++;
        }
      }
    }

    return { archived, stale, checked };
  }

  /**
   * Update the status field in a file's frontmatter.
   */
  private setStatus(filePath: string, content: string, fields: MemoryFrontmatter, newStatus: DocStatus): void {
    const today = new Date().toISOString().slice(0, 10);
    let updated: string;

    if (content.startsWith("---\n")) {
      // Has frontmatter: update status and verified date
      if (fields.status) {
        updated = content.replace(/^(status:\s*).*$/m, `$1${newStatus}`);
      } else {
        updated = content.replace(/^---\n/, `---\nstatus: ${newStatus}\n`);
      }
      if (fields.verified) {
        updated = updated.replace(/^(verified:\s*).*$/m, `$1${today}`);
      } else {
        updated = updated.replace(/^---\n/, `---\nverified: ${today}\n`);
      }
    } else {
      // No frontmatter: add it
      updated = `---\nstatus: ${newStatus}\nverified: ${today}\n---\n${content}`;
    }

    writeFileSync(filePath, updated, "utf-8");
  }

  /**
   * Move a file to archive/ and log a tombstone entry.
   */
  private archiveFile(filePath: string, memRoot: string, archiveDir: string, reason: string): void {
    const rel = relative(memRoot, filePath);
    const archivePath = join(archiveDir, basename(filePath));
    const finalPath = existsSync(archivePath)
      ? join(archiveDir, `${basename(filePath, ".md")}-${Date.now()}.md`)
      : archivePath;

    const content = readFileSync(filePath, "utf-8");

    try {
      renameSync(filePath, finalPath);
    } catch {
      try {
        writeFileSync(finalPath, content, "utf-8");
        const { unlinkSync } = require("fs");
        unlinkSync(filePath);
      } catch (err) {
        console.error(`[MemoryManager] Failed to archive ${rel}: ${err}`);
        return;
      }
    }

    // Log tombstone
    this.logTombstone(memRoot, { file: rel, date: new Date().toISOString().slice(0, 10), reason });
    console.log(`[MemoryManager] Archived: ${rel} (${reason})`);
  }

  /**
   * Append a tombstone entry to tombstone.md in memory root.
   */
  private logTombstone(memRoot: string, entry: TombstoneEntry): void {
    const tombstonePath = join(memRoot, "tombstone.md");
    const line = `- \`${entry.file}\` — archived ${entry.date}, ${entry.reason}${entry.successor ? `, successor: ${entry.successor}` : ""}\n`;

    if (existsSync(tombstonePath)) {
      const content = readFileSync(tombstonePath, "utf-8");
      writeFileSync(tombstonePath, content + line, "utf-8");
    } else {
      writeFileSync(tombstonePath, `# Tombstone Log\n\nArchived and deleted memory files.\n\n${line}`, "utf-8");
    }
  }

  /**
   * Get all active (non-expired, non-archived) memories from global memory dir.
   * Filters by status: returns only draft, current, stale files.
   * Optionally filter by genre.
   */
  getActiveMemories(genreFilter?: DocGenre): Array<{
    path: string;
    priority: string;
    created: string;
    status: DocStatus;
    genre: string;
    verified: string;
  }> {
    const memRoot = MEMORY_BASE_DIR;
    if (!existsSync(memRoot)) return [];

    const files = this.walkMdFiles(memRoot);
    const result: Array<{
      path: string;
      priority: string;
      created: string;
      status: DocStatus;
      genre: string;
      verified: string;
    }> = [];

    const ACTIVE_STATUSES: DocStatus[] = ["draft", "current", "stale"];

    for (const filePath of files) {
      const rel = relative(memRoot, filePath);
      if (rel.startsWith("archive")) continue;

      const content = readFileSync(filePath, "utf-8");
      const { fields } = this.parseFrontmatter(content);

      const docStatus = (fields.status as DocStatus) || "current";
      if (!ACTIVE_STATUSES.includes(docStatus)) continue;

      const genre = (fields.genre as string) || "reference";
      if (genreFilter && genre !== genreFilter) continue;

      result.push({
        path: rel,
        priority: (fields.priority as string) || "medium",
        created: (fields.created as string) || "unknown",
        status: docStatus,
        genre,
        verified: (fields.verified as string) || "never",
      });
    }

    return result;
  }

  /**
   * Walk directory recursively collecting .md files.
   */
  private walkMdFiles(dir: string): string[] {
    const files: string[] = [];
    if (!existsSync(dir)) return files;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.walkMdFiles(full));
      } else if (entry.name.endsWith(".md")) {
        files.push(full);
      }
    }
    return files;
  }

  // ─── STATS ────────────────────────────────────────────────────

  /**
   * Get memory stats for a project.
   */
  getStats(projectPath: string): { totalFiles: number; totalLines: number; totalSize: number } {
    let totalFiles = 0;
    let totalLines = 0;
    let totalSize = 0;

    const checkDir = (dir: string) => {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(path);
        } else if (entry.name.endsWith(".md")) {
          totalFiles++;
          const stat = statSync(path);
          totalSize += stat.size;
          totalLines += readFileSync(path, "utf-8").split("\n").length;
        }
      }
    };

    checkDir(projectPath);
    return { totalFiles, totalLines, totalSize };
  }
}
