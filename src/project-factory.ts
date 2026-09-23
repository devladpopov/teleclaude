import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, statSync } from "fs";
import { resolve, join, dirname } from "path";
import { type Settings, type TopicMapping, getTemplatesDir } from "./config";

export class ProjectFactory {
  private settings: Settings;
  private templatesDir: string;

  constructor(settings: Settings) {
    this.settings = settings;
    this.templatesDir = getTemplatesDir();
  }

  /**
   * Create a new project directory for a Telegram topic. The returned
   * mapping has `wasExisting: true` if the directory was already on disk
   * (mapping just lost from topics.json — see saveTopics race that bit
   * us 2026-05-03 with the "Флудилка" topic). Callers can use this to
   * pick a different Telegram-side message ("re-attached" vs "created").
   */
  createProject(topicName: string, groupId: string, topicId: string, firstMessage: string): TopicMapping {
    const slug = this.slugify(topicName);
    const projectPath = resolve(this.settings.projectsRoot, slug);

    // Don't overwrite existing projects
    if (existsSync(projectPath)) {
      console.log(`[ProjectFactory] Project already exists: ${projectPath}`);
      return this.existingProjectMapping(projectPath, topicName);
    }

    console.log(`[ProjectFactory] Creating project: ${projectPath}`);

    // Create project directory
    mkdirSync(projectPath, { recursive: true });

    // Copy SOUL.md
    const soulSrc = resolve(this.templatesDir, "SOUL.md");
    if (existsSync(soulSrc)) {
      copyFileSync(soulSrc, join(projectPath, "SOUL.md"));
    }

    // Create symlink or copy main-memory.md (shared across projects)
    const mainMemorySrc = resolve(this.templatesDir, "main-memory.md");
    const mainMemoryDst = join(projectPath, "main-memory.md");
    if (existsSync(mainMemorySrc)) {
      try {
        symlinkSync(mainMemorySrc, mainMemoryDst);
      } catch {
        // Symlinks may fail on Windows without admin — fallback to copy
        copyFileSync(mainMemorySrc, mainMemoryDst);
      }
    }

    // Create CLAUDE.md from template
    const claudeTemplate = readFileSync(resolve(this.templatesDir, "CLAUDE.md"), "utf-8");
    const claudeMd = claudeTemplate
      .replace("{{PROJECT_NAME}}", topicName)
      .replace("{{TOPIC_NAME}}", topicName)
      .replace("{{CREATED_DATE}}", new Date().toISOString().split("T")[0]);
    writeFileSync(join(projectPath, "CLAUDE.md"), claudeMd, "utf-8");

    // Create topic-specific memory
    const topicMemory = `# ${topicName}\n\nПамять проекта. Создан из Telegram-топика.\n\n## Контекст создания\nПервое сообщение: ${firstMessage}\nДата: ${new Date().toISOString()}\nГруппа: ${groupId}\nТопик: ${topicId}\n`;
    writeFileSync(join(projectPath, "topic-memory.md"), topicMemory, "utf-8");

    // VISION.md — стабильная шапка цели топика. Пользователь редактирует
    // через `/vision <text>` в Telegram, а каждый spawn'ed Claude получает
    // её первым блоком в system prompt. Так пользователь не повторяет
    // "что я хочу" в каждой задаче. Держим маленький дефолт — не
    // фантазируем за пользователя, пусть он сам пропишет цель.
    const visionTemplate =
      `# Vision: ${topicName}\n\n` +
      `> Этот файл — стабильная шапка цели проекта. Каждый Claude-spawn в этом\n` +
      `> топике получает его первым блоком контекста (бюджет 1500 символов).\n` +
      `> Редактируй из Telegram командой \`/vision <текст>\` или вручную.\n\n` +
      `## Цель\n(не определена — пропиши через \`/vision\`)\n\n` +
      `## Критерии успеха\n(не определены)\n\n` +
      `## Constraints\n(не определены)\n`;
    writeFileSync(join(projectPath, "VISION.md"), visionTemplate, "utf-8");

    // .topic-link — canonical link from project folder back to its
    // Telegram topic. Used by findHistoricalProject so that if topics.json
    // ever loses the mapping (commit drops it, stash overwrites, etc.),
    // we can re-attach by scanning project folders for a matching link.
    // Fixes the "Аудио → Разговоры" orphan class (2026-05-05): topic 42
    // got renamed in TG, the topics.json entry was already lost in an
    // earlier commit, and the bot created razgovory/ from scratch instead
    // of finding audio/ which was right there with 20KB of memory.
    this.writeTopicLink(projectPath, topicName, groupId, topicId);

    const mapping: TopicMapping = {
      name: topicName,
      project: projectPath,
      memory: ["VISION.md", "SOUL.md", "main-memory.md", "topic-memory.md"],
      created: new Date().toISOString(),
    };

    console.log(`[ProjectFactory] Project created: ${projectPath}`);
    return mapping;
  }

  /**
   * Write .topic-link JSON inside a project folder. Idempotent — safe to
   * call on existing projects to backfill the link.
   */
  writeTopicLink(projectPath: string, topicName: string, groupId: string, topicId: string): void {
    const link = {
      topicKey: `${groupId}:${topicId || "general"}`,
      groupId,
      topicId: topicId || "general",
      name: topicName,
      writtenAt: new Date().toISOString(),
    };
    const path = join(projectPath, ".topic-link");
    try {
      writeFileSync(path, JSON.stringify(link, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[ProjectFactory] failed to write .topic-link at ${path}: ${(err as Error).message}`);
    }
  }

  /**
   * Find a project folder previously associated with this topic, even if
   * the topics.json entry is gone. Looks at three sources, in priority:
   *
   *   1) projectsRoot/&#42;&#47;.topic-link with matching topicKey.
   *      (Stable, written by createProject going forward.)
   *
   *   2) projectsRoot/&#42;&#47;topic-memory.md containing both
   *      "Группа: <chatId>" AND "Топик: <threadId>" — the format
   *      project-factory has been writing since at least April 2026.
   *
   *   3) topicsJsonBackupPaths: list of historical topics.json snapshots
   *      (e.g. config/topics.json.bak.YYYY-MM-DD). Scanned newest-first,
   *      returns the first non-stale entry whose project path still
   *      exists on disk.
   *
   * Returns the project path if found, or undefined.
   */
  findHistoricalProject(opts: {
    topicKey: string;
    groupId: string;
    topicId: string;
    topicsJsonBackupPaths?: string[];
  }): { projectPath: string; via: "topic-link" | "topic-memory" | "topics-bak" } | undefined {
    const root = this.settings.projectsRoot;

    // 1) .topic-link scan (forward-compatible)
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const projPath = resolve(root, entry);
      let st;
      try {
        st = statSync(projPath);
      } catch { continue; }
      if (!st.isDirectory()) continue;
      const linkPath = join(projPath, ".topic-link");
      if (existsSync(linkPath)) {
        try {
          const link = JSON.parse(readFileSync(linkPath, "utf-8"));
          if (link?.topicKey === opts.topicKey) {
            return { projectPath: projPath, via: "topic-link" };
          }
        } catch {
          // malformed link — ignore
        }
      }
    }

    // 2) topic-memory.md content scan ("Группа: <id>" + "Топик: <id>")
    const groupMarker = `Группа: ${opts.groupId}`;
    const topicMarker = `Топик: ${opts.topicId}`;
    for (const entry of entries) {
      const projPath = resolve(root, entry);
      const memPath = join(projPath, "topic-memory.md");
      if (!existsSync(memPath)) continue;
      try {
        const content = readFileSync(memPath, "utf-8");
        if (content.includes(groupMarker) && content.includes(topicMarker)) {
          return { projectPath: projPath, via: "topic-memory" };
        }
      } catch {
        // unreadable file — skip
      }
    }

    // 3) topics.json backup snapshots
    if (opts.topicsJsonBackupPaths && opts.topicsJsonBackupPaths.length > 0) {
      // Sort newest-first by mtime so a more-recent backup wins over
      // older ones. We accept any backup that points to a path that
      // still exists on disk.
      const dated = opts.topicsJsonBackupPaths
        .map(p => {
          try { return { p, mtime: statSync(p).mtimeMs }; } catch { return undefined; }
        })
        .filter((x): x is { p: string; mtime: number } => !!x)
        .sort((a, b) => b.mtime - a.mtime);
      for (const { p } of dated) {
        try {
          const json = JSON.parse(readFileSync(p, "utf-8"));
          const entry = json?.topics?.[opts.topicKey];
          if (entry?.project && existsSync(entry.project)) {
            return { projectPath: entry.project as string, via: "topics-bak" };
          }
        } catch {
          // malformed backup — skip
        }
      }
    }

    return undefined;
  }

  /**
   * Public probe: does the project folder for this topic name already exist
   * on disk? Used by router.ts to pick between
   * "🆕 Проект создан" (new dir + new mapping) vs
   * "🔗 Маппинг восстановлен" (dir was there, mapping was lost from topics.json).
   * Otherwise the bot tells the user "Проект создан" every time topics.json
   * regenerates, which is alarming and inaccurate.
   */
  projectExists(topicName: string): boolean {
    const slug = this.slugify(topicName);
    const projectPath = resolve(this.settings.projectsRoot, slug);
    return existsSync(projectPath);
  }

  private existingProjectMapping(projectPath: string, topicName: string): TopicMapping {
    return {
      name: topicName,
      project: projectPath,
      memory: ["VISION.md", "SOUL.md", "main-memory.md", "topic-memory.md"],
      created: new Date().toISOString(),
    };
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[а-яё]/gi, (char) => {
        const map: Record<string, string> = {
          а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh",
          з: "z", и: "i", й: "j", к: "k", л: "l", м: "m", н: "n", о: "o",
          п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
          ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
          я: "ya",
        };
        return map[char.toLowerCase()] || char;
      })
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);
  }
}
