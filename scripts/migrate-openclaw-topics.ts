/**
 * One-shot migration: для каждого топика в topics.json с
 * `migratedFromOpenClaw === true` создаёт отдельный cwd на диске,
 * копирует туда SOUL.md/main-memory.md/CLAUDE.md/topic-memory.md,
 * обновляет mapping.project и убирает migratedFromOpenClaw / topicMemory.
 *
 * Запуск (на Windows-машине, в корне репо роутера):
 *
 *   bun run scripts/migrate-openclaw-topics.ts            # dry-run
 *   bun run scripts/migrate-openclaw-topics.ts --apply    # реально пишет
 *
 * Безопасно пускать повторно: уже мигрированные топики просто пропускаются.
 *
 * Решает баг кросс-контаминации:
 * до миграции 30+ топиков делят cwd templates/openclaw-memory,
 * и `claude --continue` тащит сессию из чужого топика.
 */
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

interface TopicMapping {
  name: string;
  project: string;
  sessionId?: string;
  memory: string[];
  created: string;
  migratedFromOpenClaw?: boolean;
  topicMemory?: string;
}

interface TopicsConfig {
  groups: Record<string, { name: string; enabled: boolean }>;
  topics: Record<string, TopicMapping>;
}

interface Settings {
  projectsRoot: string;
}

function slugify(text: string): string {
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

function copyTreeMd(srcDir: string, dstDir: string): number {
  if (!existsSync(srcDir)) return 0;
  let n = 0;
  const fs = require("fs") as typeof import("fs");
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, entry.name);
    const d = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      if (APPLY) mkdirSync(d, { recursive: true });
      n += copyTreeMd(s, d);
    } else if (entry.name.endsWith(".md")) {
      if (APPLY) copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

function main() {
  const settings: Settings = JSON.parse(
    readFileSync(resolve(ROOT, "config/settings.json"), "utf-8"),
  );
  const topicsPath = resolve(ROOT, "config/topics.json");
  const topics: TopicsConfig = JSON.parse(readFileSync(topicsPath, "utf-8"));

  const templatesDir = resolve(ROOT, "templates");
  const memoryDir = resolve(templatesDir, "openclaw-memory");

  console.log(
    `[migrate] mode=${APPLY ? "APPLY" : "dry-run"}  projectsRoot=${settings.projectsRoot}`,
  );

  let migrated = 0;
  let skipped = 0;
  const usedSlugs = new Set<string>();

  // Pre-fill usedSlugs with existing project paths to detect collisions
  for (const m of Object.values(topics.topics)) {
    const last = m.project.replace(/[\\\/]+$/, "").split(/[\\\/]/).pop();
    if (last) usedSlugs.add(last);
  }

  for (const [topicKey, mapping] of Object.entries(topics.topics)) {
    if (!mapping.migratedFromOpenClaw) {
      skipped++;
      continue;
    }

    let slug = slugify(mapping.name) || `topic-${topicKey.split(":")[1] || "x"}`;
    // Disambiguate against existing slugs
    if (usedSlugs.has(slug)) {
      const tail = topicKey.split(":")[1] || Date.now().toString();
      slug = `${slug}-${tail}`;
    }
    usedSlugs.add(slug);

    const projectPath = resolve(settings.projectsRoot, slug);
    console.log(`[migrate] ${topicKey}  "${mapping.name}"  ->  ${projectPath}`);

    if (APPLY) {
      mkdirSync(projectPath, { recursive: true });

      // SOUL.md
      const soulSrc = resolve(templatesDir, "SOUL.md");
      if (existsSync(soulSrc) && !existsSync(join(projectPath, "SOUL.md"))) {
        copyFileSync(soulSrc, join(projectPath, "SOUL.md"));
      }

      // main-memory.md (copy; symlink fails on Windows w/o admin)
      const mainSrc = resolve(templatesDir, "main-memory.md");
      if (existsSync(mainSrc) && !existsSync(join(projectPath, "main-memory.md"))) {
        copyFileSync(mainSrc, join(projectPath, "main-memory.md"));
      }

      // CLAUDE.md from template
      const claudeTpl = resolve(templatesDir, "CLAUDE.md");
      if (existsSync(claudeTpl) && !existsSync(join(projectPath, "CLAUDE.md"))) {
        const tpl = readFileSync(claudeTpl, "utf-8");
        const out = tpl
          .replace(/{{PROJECT_NAME}}/g, mapping.name)
          .replace(/{{TOPIC_NAME}}/g, mapping.name)
          .replace(/{{CREATED_DATE}}/g, new Date().toISOString().split("T")[0]);
        writeFileSync(join(projectPath, "CLAUDE.md"), out, "utf-8");
      }

      // topic-memory.md from openclaw export
      const topicMemFile = mapping.topicMemory;
      const topicMemDst = join(projectPath, "topic-memory.md");
      if (topicMemFile && !existsSync(topicMemDst)) {
        const src = resolve(memoryDir, topicMemFile);
        if (existsSync(src)) {
          copyFileSync(src, topicMemDst);
        } else {
          writeFileSync(
            topicMemDst,
            `# ${mapping.name}\n\nПамять проекта (мигрировано из openclaw, исходник не найден: ${topicMemFile}).\n`,
            "utf-8",
          );
        }
      } else if (!existsSync(topicMemDst)) {
        writeFileSync(
          topicMemDst,
          `# ${mapping.name}\n\nПамять проекта.\n`,
          "utf-8",
        );
      }

      // Shared memory (people/services/shared/projects)
      const memDir = join(projectPath, "memory");
      mkdirSync(memDir, { recursive: true });
      for (const sub of ["people", "services", "shared", "projects"]) {
        const srcSub = resolve(memoryDir, sub);
        const dstSub = join(memDir, sub);
        if (existsSync(srcSub)) {
          mkdirSync(dstSub, { recursive: true });
          copyTreeMd(srcSub, dstSub);
        }
      }

      // Update mapping
      mapping.project = projectPath;
      mapping.memory = ["SOUL.md", "main-memory.md", "topic-memory.md"];
      delete mapping.migratedFromOpenClaw;
      delete mapping.topicMemory;
      // Очищаем фейковый локальный sessionId, чтобы новый код мог
      // получить настоящий session_id от claude при следующем запуске.
      delete mapping.sessionId;
    }

    migrated++;
  }

  if (APPLY) {
    writeFileSync(topicsPath, JSON.stringify(topics, null, 2), "utf-8");
    console.log(`[migrate] topics.json updated`);
  }

  console.log(
    `[migrate] done. migrated=${migrated} skipped=${skipped} total=${
      migrated + skipped
    }`,
  );
  if (!APPLY) {
    console.log(`[migrate] это был dry-run. Для применения: --apply`);
  }
}

main();
