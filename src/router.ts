import { Bot, InlineKeyboard, type Context } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { existsSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { type Settings, loadTopics, saveTopics, type TopicsConfig, type TopicMapping, type GroupMode, MODEL_ALIASES, isValidModelAlias, MODEL_SLUGS, LEGACY_MODEL_SLUGS, shortModelTag, MEMORY_BASE_DIR, EFFORT_LEVELS, isValidEffortLevel } from "./config";
import { ProcessManager } from "./process-manager";
import { RunnerClient } from "./runner-client";
import {
  CLAUDE_PROVIDER, loadProviders, getProvider, resolveTopicProvider, readProviderKey,
  providerTag, executorOfSession, sessionFor, storeSession, clearSession, PROVIDERS_PATH,
  type ProviderConfig,
} from "./providers";
import { AccountManager } from "./account-manager";
import { ProjectFactory } from "./project-factory";
import { WhisperClient, formatWhisperFailure, type WhisperResult } from "./whisper";
import { extractFrames, formatFrameFailure } from "./video-frames";
import { ContextCompactor } from "./context-compactor";
import { MemoryManager } from "./memory-manager";
import { PendingTasksStore, type PendingTask } from "./pending-tasks";
import { TypingCoordinator } from "./typing-coordinator";
import {
  ReminderStore,
  ReminderScheduler,
  parseDuration,
  parseWhen,
  formatDuration,
  formatFireAt,
  generateReminderId,
  type Reminder,
} from "./reminders";
import { Director } from "./director";
import {
  RecurringTaskStore,
  RecurringTaskScheduler,
  parseInterval,
  type RecurringTask,
} from "./recurring-tasks";
import { uploadToDashboardHost, downloadFromDashboardHost, type DashboardSyncConfig } from "./dashboard-sync";
import { KnowledgeBaseHook } from "./kb-hook.js";
import { RealtimeExtractor } from "./realtime-extractor.js";

/**
 * Строит ссылку на сообщение в Telegram.
 *
 * Для супергрупп (chatId начинается с -100) — публичный c-ссылочный
 * формат `https://t.me/c/<short>/<thread>/<msg>`. Telegram сам разберётся
 * с правами доступа: ссылка работает только для участников чата.
 *
 * Для обычных приватных чатов публичного URL у сообщений нет, поэтому
 * возвращаем заглушку с message_id — её всё равно можно процитировать.
 */
function buildMessageLink(
  chatIdStr: string,
  threadId: number | null,
  msgId: number,
): string {
  if (chatIdStr.startsWith("-100")) {
    const shortId = chatIdStr.slice(4);
    return threadId
      ? `https://t.me/c/${shortId}/${threadId}/${msgId}`
      : `https://t.me/c/${shortId}/${msgId}`;
  }
  return `(msg #${msgId})`;
}

const ROUTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TG_RULES_PATH = join(ROUTER_ROOT, "templates", "TG-RULES.md");

/**
 * Строит подсказку для Claude Code о том, каким скиллом и как читать
 * присланный из Telegram документ.
 *
 * Идея: у локального `claude -p` (через spawn) теперь установлены user-level
 * скиллы pdf/docx/xlsx/pptx в %USERPROFILE%\.claude\skills\ (раскладываются
 * через scripts/setup-document-skills.ps1). Мы не можем принудительно
 * вызвать скилл снаружи — но можем явно назвать его и дать fallback-инструкции
 * на случай, если скилл не установлен либо Read не справится.
 *
 * Критично для Windows: любая Python-обвязка ДОЛЖНА писать в файл с
 * encoding="utf-8", иначе мохибаке в cp1251 PowerShell. Это фиксируется
 * в подсказке явно.
 */
function buildDocumentSkillHint(filePath: string, fileName: string, mime: string): string {
  const name = fileName.toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || "";
  const mimeLc = mime.toLowerCase();

  type Kind = "pdf" | "docx" | "xlsx" | "pptx" | "text" | "image" | "archive" | "unknown";
  let kind: Kind = "unknown";

  if (ext === "pdf" || mimeLc === "application/pdf") kind = "pdf";
  else if (ext === "docx" || ext === "doc" || mimeLc.includes("wordprocessingml") || mimeLc === "application/msword") kind = "docx";
  else if (ext === "xlsx" || ext === "xls" || ext === "csv" || ext === "tsv" || mimeLc.includes("spreadsheetml") || mimeLc.includes("ms-excel")) kind = "xlsx";
  else if (ext === "pptx" || ext === "ppt" || mimeLc.includes("presentationml") || mimeLc.includes("ms-powerpoint")) kind = "pptx";
  else if (["txt", "md", "json", "yaml", "yml", "xml", "html", "htm", "log", "csv", "ts", "js", "py", "rs", "go", "java", "c", "cpp", "h"].includes(ext) || mimeLc.startsWith("text/")) kind = "text";
  else if (mimeLc.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) kind = "image";
  else if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) kind = "archive";

  const windowsEncodingNote =
    "ВАЖНО (Windows): если будешь запускать python-скрипты, всегда сохраняй результат " +
    "в файл с encoding=\"utf-8\" и не печатай кириллицу в stdout напрямую — PowerShell " +
    "по умолчанию в cp1251 и ломает вывод. Шаблон: " +
    "`with open(\"out.txt\", \"w\", encoding=\"utf-8\") as f: f.write(text)`.";

  const common = `Путь к файлу: ${filePath}\n\n${windowsEncodingNote}`;

  switch (kind) {
    case "pdf":
      return (
        `Это PDF. В твоём окружении установлен user-level skill \`pdf\` ` +
        `(~/.claude/skills/pdf/SKILL.md). Сначала прочитай SKILL.md этого скилла ` +
        `и следуй его инструкциям — он знает про pypdf, pdfplumber, pymupdf, OCR и формы.\n\n` +
        `Если PDF большой (>20 страниц) — НЕ читай через встроенный Read целиком, извлекай ` +
        `постранично через pymupdf/pdfplumber и пиши в промежуточный .txt файл. Если это скан ` +
        `(pymupdf возвращает пусто) — используй ocrmypdf с языками rus+eng.\n\n` +
        common
      );
    case "docx":
      return (
        `Это Word-документ. В твоём окружении установлен user-level skill \`docx\` ` +
        `(~/.claude/skills/docx/SKILL.md). Сначала прочитай SKILL.md этого скилла ` +
        `и следуй его инструкциям — там pandoc, python-docx, mammoth и схема редактирования ` +
        `через unpack → XML → pack.\n\n` +
        `Быстрый путь для чтения: \`python -c "import docx; d=docx.Document(r'${filePath.replace(/'/g, "\\'")}'); open('out.txt','w',encoding='utf-8').write('\\n'.join(p.text for p in d.paragraphs))"\`.\n\n` +
        common
      );
    case "xlsx":
      return (
        `Это таблица (Excel/CSV). В твоём окружении установлен user-level skill \`xlsx\` ` +
        `(~/.claude/skills/xlsx/SKILL.md). Сначала прочитай SKILL.md этого скилла ` +
        `и следуй его инструкциям — цветовые конвенции для финмоделей, формулы, openpyxl, ` +
        `анти-паттерны #REF!/#DIV0!.\n\n` +
        `Быстрый путь для чтения: \`python -c "import openpyxl; wb=openpyxl.load_workbook(r'${filePath.replace(/'/g, "\\'")}', data_only=True); [print(s.title) for s in wb.worksheets]"\`.\n\n` +
        common
      );
    case "pptx":
      return (
        `Это презентация PowerPoint. В твоём окружении установлен user-level skill \`pptx\` ` +
        `(~/.claude/skills/pptx/SKILL.md). Сначала прочитай SKILL.md этого скилла ` +
        `и следуй его инструкциям — markitdown для чтения, python-pptx / pptxgenjs для создания, ` +
        `editing.md для правок.\n\n` +
        `Быстрый путь для чтения: \`python -m markitdown "${filePath}"\` → перенаправь вывод в файл через \`> out.md\` (cmd /c, не PowerShell, либо chcp 65001).\n\n` +
        common
      );
    case "text":
      return `Это текстовый файл. Открой его через встроенный Read — он справляется с текстом, кодом, markdown, JSON, YAML, XML, HTML.\n\n${common}`;
    case "image":
      return `Это изображение. Открой его через встроенный Read — ты мультимодальный и увидишь картинку напрямую.\n\n${common}`;
    case "archive":
      return (
        `Это архив. Распакуй во временную папку и затем разбирай файлы по одному.\n` +
        `На Windows: \`tar -xzf "${filePath}" -C <tmpdir>\` или \`Expand-Archive\` для .zip.\n\n` +
        common
      );
    default:
      return (
        `Не распознал тип документа по расширению/MIME. Попробуй встроенный Read сначала ` +
        `(он работает с текстом, PDF, картинками). Если Read не подходит — определи формат ` +
        `по первым байтам файла и выбери подходящий инструмент.\n\n` +
        common
      );
  }
}

/**
 * Конвертер Markdown → Telegram HTML.
 * Telegram HTML — самый надёжный parse_mode: экранировать нужно только
 * `&<>`, не нужно мучить точки/скобки/тире как в MarkdownV2.
 *
 * Поддерживается:
 *   - ```fenced code``` → <pre><code class="language-...">
 *   - `inline code`     → <code>
 *   - **bold**          → <b>
 *   - # / ## / ### Заголовок → <b>Заголовок</b>
 *   - [text](url)       → <a href="url">text</a>
 *   - "- item" / "* item" в начале строки → "• item"
 *
 * Однострочные *italic* и _italic_ намеренно НЕ конвертируем — слишком
 * легко поймать ложное срабатывание (snake_case, "это * это", и т.п.).
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mdToHtml(text: string): string {
  if (!text) return "";

  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1) Вытащить fenced code blocks ```lang\n...```
  let s = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000CB${idx}\u0000`;
  });

  // 2) Вытащить inline code `...`
  s = s.replace(/`([^`\n]+?)`/g, (_m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000IC${idx}\u0000`;
  });

  // 3) Экранировать оставшийся HTML
  s = escapeHtml(s);

  // 4) Markdown-фичи
  // Заголовки → жирный
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // **bold** (одна строка, без вложенности)
  s = s.replace(/\*\*([^\n*]+?)\*\*/g, "<b>$1</b>");
  // [text](url) — экранируем url-кавычки
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => {
    const safeUrl = url.replace(/"/g, "&quot;");
    return `<a href="${safeUrl}">${txt}</a>`;
  });
  // Маркер списка в начале строки
  s = s.replace(/(^|\n)[*\-]\s+/g, "$1• ");

  // 5) Вернуть код на место
  s = s.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => inlineCodes[parseInt(i, 10)]);
  s = s.replace(/\u0000CB(\d+)\u0000/g, (_m, i) => codeBlocks[parseInt(i, 10)]);

  return s;
}

/**
 * Split markdown text into chunks of at most `maxLen` characters without
 * cutting a fenced ```-block across the boundary.
 *
 * Algorithm:
 *   1. Walk line by line, tracking whether we're currently inside a ``` block.
 *   2. Before appending a line that would overflow maxLen, flush the current
 *      buffer as a chunk. When flushing mid-fence, append a synthetic closing
 *      ``` and open the next chunk with ```<lang>, preserving the language.
 *   3. If a single line itself exceeds maxLen (rare — huge base64 blob etc.),
 *      hard-chop it by characters, closing/reopening the fence around each
 *      chop too.
 *
 * Exported at module scope so it can be unit-tested without instantiating
 * the whole Router.
 */
export function splitRespectingFences(text: string, maxLen: number): string[] {
  if (maxLen <= 16) throw new Error("maxLen too small");
  if (text.length <= maxLen) return text.length > 0 ? [text] : [];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let insideFence = false;
  let fenceLang = "";

  const flushAndMaybeReopen = (): void => {
    if (current.length === 0) return;
    const wasInside = insideFence;
    const lang = fenceLang;
    let out = current.join("\n");
    if (wasInside) out += "\n```";
    chunks.push(out);
    current = [];
    currentLen = 0;
    if (wasInside) {
      const reopen = "```" + lang;
      current.push(reopen);
      currentLen = reopen.length;
    }
  };

  for (const line of lines) {
    // Cost of adding this line to the current buffer (incl. joining newline).
    const cost = (current.length > 0 ? 1 : 0) + line.length;
    // Reserve budget for the potential closing ``` we'd append on flush.
    const reserve = insideFence ? 4 : 0; // "\n```"

    if (currentLen + cost + reserve > maxLen && current.length > 0) {
      flushAndMaybeReopen();
    }

    current.push(line);
    currentLen += (current.length > 1 ? 1 : 0) + line.length;

    // Update fence state AFTER append.
    if (!insideFence) {
      const m = line.match(/^```(\w*)\s*$/);
      if (m) {
        insideFence = true;
        fenceLang = m[1] || "";
      }
    } else if (line.trim() === "```") {
      insideFence = false;
      fenceLang = "";
    }

    // Defensive: a single line that itself busts the budget. Hard-chop by
    // characters, preserving fence around each chop if we're inside one.
    if (currentLen > maxLen && current.length === 1) {
      let remainder = current[0];
      current = [];
      currentLen = 0;
      const chopSize = insideFence ? maxLen - 4 : maxLen;
      while (remainder.length > chopSize) {
        if (insideFence) {
          chunks.push(remainder.slice(0, chopSize) + "\n```");
          remainder = "```" + fenceLang + "\n" + remainder.slice(chopSize);
        } else {
          chunks.push(remainder.slice(0, chopSize));
          remainder = remainder.slice(chopSize);
        }
      }
      if (remainder.length > 0) {
        current.push(remainder);
        currentLen = remainder.length;
      }
    }
  }

  if (current.length > 0) {
    const tail = current.join("\n") + (insideFence ? "\n```" : "");
    chunks.push(tail);
  }

  return chunks.filter(c => c.trim().length > 0);
}

export class Router {
  private bot: Bot;
  private settings: Settings;
  private topics: TopicsConfig;
  private processManager: ProcessManager | RunnerClient;
  private accountManager: AccountManager;
  private projectFactory: ProjectFactory;
  private whisper: WhisperClient;
  private compactor: ContextCompactor;
  private memoryManager: MemoryManager;
  private pendingTasks: PendingTasksStore;
  private typingCoordinator: TypingCoordinator;
  private reminderStore: ReminderStore;
  private reminderScheduler: ReminderScheduler;
  private recurringStore: RecurringTaskStore;
  private recurringScheduler: RecurringTaskScheduler;
  private director: Director;
  // /health endpoint state (Layer 3)
  private healthServer: any;
  private startedAt = 0;
  private lastTickAt = 0;
  private tickCount = 0;
  private lastTickRegistry: import("./director").DirectorRegistry | null = null;
  private runnerHandle?: RunnerHandle;
  // Dynamic topic name cache: "chatId:threadId" → name
  private topicNameCache = new Map<string, string>();
  // Pending text context per topic (for "text then audio" workflow)
  // key = topicKey, value = { text, timestamp }
  private pendingContext = new Map<string, { text: string; ts: number }>();
  private readonly PENDING_CONTEXT_TTL = 120_000; // 2 minutes
  // Recent messages buffer: key = topicKey, value = array of {user, assistant, ts}
  // Persisted to {projectPath}/recent-messages.jsonl, survives router restarts.
  // Injected into new sessions (not --resume) as context history.
  private recentMsgs = new Map<string, Array<{ user: string; assistant: string; ts: number }>>();
  private readonly RECENT_MSG_MAX = 15;
  private readonly RECENT_MSG_INJECT_CHARS = 3000; // max chars to inject from history
  // Last seen user message_id per topic. Used by /remind so phrases like
  // "напомни про это сообщение" without an explicit Telegram-reply still
  // build a working link. Populated on every accepted user message.
  private lastUserMsgId = new Map<string, number>();
  // Last sent bot message_id per topic. Used by Director to attach messageId
  // to subtasks when they transition to done:true.
  private lastBotMsgId = new Map<string, number>();
  // Версия процесса: branch + short commit + dirty-флаг.
  // Заполняется один раз в start(), читается /version.
  private versionInfo: { branch: string; commit: string; dirty: boolean } | null = null;
  // Время старта процесса — для /uptime.
  private readonly bootedAt = Date.now();
  // /quiet per-topic: временное заглушение Claude-роутинга. Команды всё равно
  // работают. Значение — unix ms, до которого топик молчит. Хранится только
  // в памяти: после рестарта роутера quiet сбрасывается — это намеренно,
  // quiet задумывался как «на ближайшие N минут не отвечай».
  private quietUntil = new Map<string, number>();
  private kbHook: KnowledgeBaseHook | null = null;
  private extractor: RealtimeExtractor | null = null;

  constructor(botToken: string, settings: Settings) {
    this.bot = new Bot(botToken);
    // Автоматический ретрай всех API-запросов (Bun на Windows переодически
    // ловит ECONNRESET / ConnectionClosed при fetch к api.telegram.org —
    // известный баг Bun, oven-sh/bun#5363, #9881, #6197). Плагин ретраит
    // rate-limits и transient-ошибки прозрачно для кода.
    this.bot.api.config.use(autoRetry({
      maxRetryAttempts: 10,
      maxDelaySeconds: 30,
      // grammy@^1.41 renamed retryOnInternalServerErrors → rethrowInternalServerErrors;
      // semantics is "do NOT silently swallow 5xx" — same intent.
      rethrowInternalServerErrors: true,
    }));
    this.settings = settings;
    this.topics = loadTopics();
    this.accountManager = new AccountManager();
    if (settings.runner?.enabled) {
      const rc = new RunnerClient(settings, this.accountManager);
      rc.setProviderResolver((topicKey) => {
        const provider = this.topicProvider(this.topics.topics[topicKey]);
        if (provider.executor === "claude") return undefined;
        return { provider, key: readProviderKey(provider) };
      });
      this.processManager = rc;
      console.log("[Router] Using RunnerClient (sidecar mode)");
    } else {
      this.processManager = new ProcessManager(settings, this.accountManager);
      console.log("[Router] Using ProcessManager (direct spawn)");
    }
    this.projectFactory = new ProjectFactory(settings);
    this.whisper = new WhisperClient(settings);
    this.compactor = new ContextCompactor(settings);
    this.memoryManager = new MemoryManager(settings);
    // Хранилище активных "Думаю..."-задач. Пишется на каждом старте
    // sendMessage и удаляется по завершению. При краше роутера сканируется
    // на старте и осиротевшие сообщения редактируются.
    this.pendingTasks = new PendingTasksStore(resolve(ROUTER_ROOT, "config/pending-tasks.json"));

    // TypingCoordinator: один таймер на чат, round-robin по активным
    // топикам. Решает 429 sendChatAction при 2+ параллельных топиках
    // в одной супергруппе. См. typing-coordinator.ts.
    this.typingCoordinator = new TypingCoordinator(this.bot);

    // --- Reminders: persistent JSON store + background scheduler ---
    // Хранилище живёт в config/reminders.json (рядом с topics.json),
    // scheduler тикает каждые 15с и сам отправляет sendMessage в нужный
    // chat_id+thread_id. Никакой Claude-сессии для напоминания не нужно.
    this.reminderStore = new ReminderStore(resolve(ROUTER_ROOT, "config/reminders.json"));
    this.reminderScheduler = new ReminderScheduler(this.reminderStore, async (r) => {
      // Two firing modes:
      //   * Plain reminder (default): sendMessage with "Напоминание: <text>".
      //     For "напомни мне X" — текст для пользователя-человека.
      //   * Run mode (runClaude=true): triggerTopicAuto, like /loop. Used
      //     for time-prefixed NL like "в 8 запусти отчёт", "через час
      //     проверь сайт" — пользователь хочет действие, не напоминание.
      if (r.runClaude) {
        const topicKey = `${r.chatId}:${r.threadId ?? "general"}`;
        await this.triggerTopicAuto({ topicKey, text: r.text });
      } else {
        const text = `Напоминание: ${r.text}`;
        await this.bot.api.sendMessage(Number(r.chatId), text, {
          message_thread_id: r.threadId ?? undefined,
        } as any);
      }
    });

    // --- Recurring tasks (/loop): persistent store + scheduler ---
    // Tasks fire by spawning Claude in their topic via triggerTopicAuto,
    // exactly the same path Director uses. Cooldown / quota / spawn
    // config / kill-silent — all reused. The scheduler ticks every 30s
    // (one minute granularity is the minimum supported interval).
    this.recurringStore = new RecurringTaskStore(resolve(ROUTER_ROOT, "config/recurring.json"));
    this.recurringScheduler = new RecurringTaskScheduler(this.recurringStore, async (task) => {
      await this.triggerTopicAuto({
        topicKey: task.topicKey,
        text: `[/loop ${task.interval}] ${task.text}`,
      });
    });

    // --- ChromaDB KB ingest hook ---
    try {
      const kbConfigPath = resolve(ROUTER_ROOT, "config/kb.local.json");
      if (existsSync(kbConfigPath)) {
        const kbConfig = JSON.parse(readFileSync(kbConfigPath, "utf-8"));
        this.kbHook = new KnowledgeBaseHook(kbConfig.baseUrl, kbConfig.token);
        console.log("[Router] KnowledgeBaseHook initialized:", kbConfig.baseUrl);
      }
    } catch (e) {
      console.warn("[Router] KnowledgeBaseHook init failed:", (e as Error).message);
    }

    // --- Real-time Knowledge Extractor (Phase 4 Nerve) ---
    // Optional, off by default: enabled only when GEMINI_API_KEY is set.
    // Sends message text to the Gemini API to extract facts into memory.
    const geminiKey = process.env.GEMINI_API_KEY || "";
    if (geminiKey) {
      this.extractor = new RealtimeExtractor({
        geminiApiKey: geminiKey,
        cooldownMs: 60_000,           // 1 min between extractions per topic
        contextCheckEnabled: true,
        contextCheckIntervalMs: 24 * 60 * 60 * 1000, // daily
        maxTopicMemoryLines: 200,
      });
      console.log("[Router] RealtimeExtractor initialized");
    }

    // --- Director: autonomous task manager ---
    // Тикает каждые 15 минут, обходит CHECKPOINT.md всех топиков,
    // обновляет реестр и дашборд. Без ИИ — 0 токенов.
    //
    // Dashboard sync: после каждого тика заливаем director-dashboard.json
    // по SSH на внешний хостинг (DASHBOARD_SYNC_REMOTE), чтобы веб-дашборд
    // видел свежие данные. Без DASHBOARD_SYNC_REMOTE синк выключен. Можно отключить переменной
    // окружения DASHBOARD_SYNC_DISABLED=1 (для разработки или временного
    // отключения, если хостинг недоступен и не хочется шумных ошибок).
    const dashboardSync: DashboardSyncConfig = {
      bashPath: process.env.GIT_BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe",
      sshKey: process.env.DASHBOARD_SYNC_SSH_KEY ?? homedir().replace(/\\/g, "/") + "/.ssh/id_ed25519",
      remote: process.env.DASHBOARD_SYNC_REMOTE ?? "",
      remoteDir: process.env.DASHBOARD_SYNC_DIR ?? "~/public_html/hub/",
      disabled: process.env.DASHBOARD_SYNC_DISABLED === "1" || !process.env.DASHBOARD_SYNC_REMOTE,
    };
    const dashboardPath = resolve(ROUTER_ROOT, "config/director-dashboard.json");
    const eventsPath = resolve(ROUTER_ROOT, "config/director-events.json");

    this.director = new Director({
      topics: this.topics,
      registryPath: resolve(ROUTER_ROOT, "config/director-registry.json"),
      dashboardPath,
      eventsPath,
      tickIntervalMs: 15 * 60 * 1000, // 15 min
      staleThresholdMs: 15 * 60 * 1000, // 15 min
      maxTriggersPerTick: 5,
      defaultAutoModel: "sonnet",
      // Fast-retry: query the runner for topics whose last job timed out
      // or failed. Director uses 5 min cooldown for these instead of 30 min,
      // so incomplete work (context broke mid-task) gets resumed quickly.
      //
      // Also includes silent-running topics: a job that's still in state
      // "running" but hasn't emitted any stream event in
      // SILENT_RUNNING_THRESHOLD_MS (5 min). These spawns are stuck on a
      // tool call or hung waiting for input that never came. Treating them
      // as failures lets Director re-trigger after 5 min instead of waiting
      // the full 2h cooldown. triggerTopicAuto kills the silent job before
      // queueing the new message — see `killSilentRunning` below.
      getRecentJobFailures: async (): Promise<Set<string>> => {
        const result = new Set<string>();
        try {
          const port = (this.processManager as any).cachedPort
            ?? (this.processManager as any).resolveRunnerPort?.((this.processManager as any).settings);
          if (!port) return result;
          const resp = await fetch(`http://127.0.0.1:${port}/jobs`);
          if (!resp.ok) return result;
          const data = await resp.json() as { jobs: Array<{ topicKey: string; state: string; startedAt: number; lastEventAt?: number }> };
          // For each topic, find the most recent job. If it's timeout/failed,
          // add to set. If it's silent-running, also add.
          const latest = new Map<string, { state: string; startedAt: number; lastEventAt?: number }>();
          for (const j of data.jobs) {
            const prev = latest.get(j.topicKey);
            if (!prev || j.startedAt > prev.startedAt) {
              latest.set(j.topicKey, { state: j.state, startedAt: j.startedAt, lastEventAt: j.lastEventAt });
            }
          }
          const SILENT_RUNNING_THRESHOLD_MS = 5 * 60 * 1000;
          const now = Date.now();
          for (const [tk, info] of latest) {
            if (info.state === "timeout" || info.state === "failed") {
              result.add(tk);
              continue;
            }
            // Silent-running: state still "running" but no stream event
            // for > 5 min. Likely stuck on a tool call or hung waiting.
            if (info.state === "running" && typeof info.lastEventAt === "number") {
              if (now - info.lastEventAt > SILENT_RUNNING_THRESHOLD_MS) {
                result.add(tk);
              }
            }
          }
        } catch {
          // Runner unreachable — no fast-retry info, use normal cooldowns.
        }
        return result;
      },
      // Web-toggle overrides: Director downloads director-overrides.json
      // from the dashboard host at start of each tick and merges it on top of the
      // per-project CHECKPOINT.md values. Allows toggling archived/priority
      // from the hub UI without editing files. See PHP endpoint at
      // /hub/api/toggle.php for the writer side.
      loadOverrides: async () => {
        const map = new Map<string, { archived?: boolean; priority?: "high" | "normal" | "low" }>();
        try {
          const raw = await downloadFromDashboardHost("director-overrides.json", dashboardSync);
          const parsed = JSON.parse(raw) as { overrides?: Record<string, { archived?: boolean; priority?: "high" | "normal" | "low" }> };
          if (parsed.overrides) {
            for (const [k, v] of Object.entries(parsed.overrides)) {
              if (v && typeof v === "object") map.set(k, v);
            }
          }
        } catch (err) {
          // File may not exist yet (no toggles set), or transient SSH glitch.
          // Either way — empty map = fall back to CHECKPOINT.md.
        }
        return map;
      },
      // Director авто-триггерит только чаты из DIRECTOR_ALLOWED_CHATS
      // (запятая-разделённый список chat ID). Остальные группы
      // read-only: их состояние видно в дашборде, но авто-триггеры
      // туда не идут. Пустой список = ограничения нет.
      allowedChatIds:
        (process.env.DIRECTOR_ALLOWED_CHATS?.split(",").map(s => s.trim()).filter(Boolean))
        ?? [],
      getActiveAccountName: () => this.accountManager.getActiveName(),
      getQuotaKey: (topicKey: string) => this.quotaKeyFor(topicKey),
      getLastBotMsgId: (topicKey: string) => this.lastBotMsgId.get(topicKey),
      onStaleTopic: async (topicKey, state, options) => {
        // Two-step trigger:
        //  1) Telegram notification — Director-supplied notice, visible
        //     in chat so the user knows what happened.
        //  2) triggerTopicAuto — actual Claude spawn. user-message and
        //     model are computed by Director (per-phase for PEV mode,
        //     plain "Продолжай: NEXT" for simple mode).
        const [chatIdStr, threadIdStr] = topicKey.split(":");
        const chatId = Number(chatIdStr);
        const threadId = threadIdStr === "general" ? undefined : Number(threadIdStr);

        // Quota pool: Claude auth mode, or provider:<id> for other providers
        const account = this.quotaKeyFor(topicKey);

        try {
          await this.bot.api.sendMessage(chatId, options.noticeText, {
            message_thread_id: threadId,
          } as any);
        } catch (err) {
          console.warn(`[Director] notice send failed for ${topicKey}:`, (err as Error).message);
          // We still try the spawn — Telegram outage shouldn't block work.
        }

        const result = await this.triggerTopicAuto({
          topicKey,
          text: options.userMessage,
          modelOverride: options.modelOverride,
        });

        // rateLimited first: a limit can come back as reply text with ok=true
        // (opencode reports a provider 429 as a result, claude sometimes too).
        if (result.rateLimited) {
          console.warn(
            `[Director] Rate-limit on ${state.name} for account "${account}". ` +
            `Director will pause and resume after the quota window.`
          );
          return { ok: false, rateLimited: true, account, error: result.error };
        } else if (result.ok) {
          console.log(
            `[Director] Triggered + spawned ${state.name} (${topicKey}) on ${options.modelOverride}`
          );
          return { ok: true, account };
        } else {
          console.error(
            `[Director] Spawn failed for ${state.name}: ${result.error}`
          );
          return { ok: false, account, error: result.error };
        }
      },
      onMorningSummary: async (summary) => {
        // Send daily summary to DIRECTOR_SUMMARY_TOPIC ("chatId:threadId").
        const summaryTopic = process.env.DIRECTOR_SUMMARY_TOPIC;
        if (!summaryTopic) return;
        const [summaryChat, summaryThread] = summaryTopic.split(":");
        const SUMMARY_CHAT_ID = Number(summaryChat);
        const SUMMARY_THREAD_ID = summaryThread ? Number(summaryThread) : undefined;
        try {
          await this.bot.api.sendMessage(SUMMARY_CHAT_ID, summary, {
            message_thread_id: SUMMARY_THREAD_ID,
          } as any);
        } catch (err) {
          console.error("[Director] Failed to send morning summary:", (err as Error).message);
        }
      },
      onTickComplete: (registry) => {
        // Update /health-tracked counters. Cheap; runs once per tick.
        this.lastTickAt = Date.now();
        this.tickCount++;
        this.lastTickRegistry = registry;
      },
      onDashboardUpdate: async (_dashboard) => {
        // Fail-soft: log and continue. Hosting downtime must not crash the
        // router — next tick will retry, and the local dashboard.json is
        // already authoritative for any future re-deploy.
        try {
          await uploadToDashboardHost(dashboardPath, "director-dashboard.json", dashboardSync);
          console.log("[Director] Dashboard uploaded");
        } catch (err) {
          console.error("[Director] Dashboard upload failed:", (err as Error).message);
        }
        // Activity events file (separate from dashboard, can be much larger).
        // Same fail-soft pattern.
        if (existsSync(eventsPath)) {
          try {
            await uploadToDashboardHost(eventsPath, "director-events.json", dashboardSync);
          } catch (err) {
            console.warn("[Director] Events upload failed:", (err as Error).message);
          }
        }
      },
    });

    // Reset compaction counters when a process is cleaned up (TTL expired)
    this.processManager.setCleanupCallback((topicKey) => {
      this.compactor.resetCounter(topicKey);
    });
  }

  async start(): Promise<void> {
    // Auto-register when bot is added to a group
    this.bot.on("my_chat_member", async (ctx) => {
      const update = ctx.myChatMember;
      if (!update) return;
      const chat = update.chat;
      const newStatus = update.new_chat_member.status;

      if ((chat.type === "supergroup" || chat.type === "group") && (newStatus === "administrator" || newStatus === "member")) {
        const chatId = chat.id.toString();
        const chatTitle = chat.title || `group-${chatId}`;
        if (!this.topics.groups[chatId]) {
          // 2026-04-19: безопасный дефолт для новых групп — mention-only.
          // Бот не должен читать каждое сообщение в незнакомой группе
          // (например, рабочей или контентной), пока его явно не позовут.
          // Пользователь переключит на active вручную через /mode active@<bot> или
          // правкой config/topics.json + рестартом.
          this.topics.groups[chatId] = { name: chatTitle, enabled: true, mode: "mention-only" };
          saveTopics(this.topics);
          console.log(`[Router] Bot added to group: ${chatTitle} (${chatId}) — registered as mention-only`);
        }
      }
    });

    // Capture topic names from forum events
    this.bot.on("message:forum_topic_created", async (ctx) => {
      const msg = ctx.message;
      if (!msg.forum_topic_created) return;
      const chatId = msg.chat.id.toString();
      const threadId = msg.message_thread_id;
      if (threadId) {
        const name = msg.forum_topic_created.name;
        this.cacheTopicName(chatId, threadId, name);
        console.log(`[Router] Topic created: ${name} (thread ${threadId})`);
      }
    });

    this.bot.on("message:forum_topic_edited", async (ctx) => {
      const msg = ctx.message;
      if (!msg.forum_topic_edited?.name) return;
      const chatId = msg.chat.id.toString();
      const threadId = msg.message_thread_id;
      if (threadId) {
        const name = msg.forum_topic_edited.name;
        this.cacheTopicName(chatId, threadId, name);
        // Update existing topic mapping name if exists
        const topicKey = this.buildTopicKey(chatId, threadId);
        if (this.topics.topics[topicKey]) {
          this.topics.topics[topicKey].name = name;
          saveTopics(this.topics);
        }
        console.log(`[Router] Topic renamed: ${name} (thread ${threadId})`);
      }
    });

    // Handle all messages
    this.bot.on("message", async (ctx) => {
      try {
        await this.handleMessage(ctx);
      } catch (err) {
        console.error("[Router] Error handling message:", err);
        try {
          await ctx.reply(`Ошибка: ${(err as Error).message}`, {
            message_thread_id: ctx.message?.message_thread_id,
          });
        } catch {}
      }
    });

    // Inline-кнопки: /help разделы, /account, /model, /ttl, /reminders отмена.
    // Регистрируется ДО runner loop — иначе нажатия потеряются.
    this.registerCallbackHandlers();

    // Прочитать git branch/commit для /version (неблокирующее).
    this.loadVersionInfo();

    // Graceful shutdown
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());

    // Start memory manager
    this.memoryManager.start();

    // Start reminders scheduler (тик каждые 15с, fires due reminders)
    this.reminderScheduler.start();

    // Start recurring tasks scheduler (/loop). 30s tick.
    this.recurringScheduler.start();

    // Start Director (тик каждые 15 мин, 0 токенов)
    this.director.start();

    // ─── /health endpoint on :7885 (Layer 3 of the safety pipeline) ─
    // The watchdog polls this BEFORE declaring a fresh start successful,
    // so it knows the router actually parsed topics.json and the Director
    // is running — not just that bun.exe exists.
    this.startedAt = Date.now();
    this.healthServer = Bun.serve({
      port: Number(process.env.ROUTER_HEALTH_PORT ?? "7885"),
      // Loopback only. A webhook tunnel (cloudflared) connects to localhost.
      hostname: process.env.ROUTER_BIND_HOST ?? "127.0.0.1",
      // SO_REUSEPORT — без него после `Stop-Process -Force` старого bun
      // ОС держит сокет в TIME_WAIT 30-60 сек, новый bun ловит EADDRINUSE,
      // watchdog объявляет crash-loop, бот лежит. Та же проблема и
      // обходной путь зафиксированы для runner :7884
      // (см. memory: "Runner :7878 zombie socket"). 2026-05-03.
      reusePort: true,
      fetch: async (req, server) => {
        const u = new URL(req.url);

        // Webhook endpoint for Telegram. Active only when ROUTER_WEBHOOK_URL
        // is set and bot is in webhook mode. In long-poll mode this still
        // accepts requests (idempotent) but Telegram won't be sending any.
        if (u.pathname === "/webhook" && req.method === "POST") {
          const expected = process.env.ROUTER_WEBHOOK_SECRET;
          if (expected) {
            const got = req.headers.get("x-telegram-bot-api-secret-token");
            if (got !== expected) {
              console.warn(`[Router] /webhook bad secret_token from ${req.headers.get("cf-connecting-ip") ?? "unknown"}`);
              return new Response("forbidden", { status: 403 });
            }
          }
          let update: any;
          try {
            update = await req.json();
          } catch (err) {
            return new Response("bad request", { status: 400 });
          }
          // Пока bot.init не завершён, botInfo пуст и handleUpdate упадёт с
          // "Bot not initialized", а апдейт будет потерян (мы ответили бы 200).
          // Отдаём 503 — Telegram повторит доставку позже, когда бот готов.
          if (!this.bot.botInfo) {
            console.warn("[Router] /webhook received before botInfo ready — 503 (Telegram will retry)");
            return new Response("not ready", { status: 503 });
          }
          // Fire-and-forget: Telegram retries failed webhooks; we don't
          // want to block its delivery thread on a multi-minute Claude
          // spawn. Reply 200 immediately, run the handler in background.
          // grammy's bot.handleUpdate awaits middleware; we wrap so any
          // throw in handlers gets logged but doesn't propagate.
          this.bot.handleUpdate(update).catch((err) => {
            console.error(`[Router] handleUpdate failed: ${(err as Error).message}`);
          });
          return new Response("", { status: 200 });
        }

        // /internal/trigger — endpoint for cross-topic spawn delegation.
        // Used by mcp__router__trigger_topic so a spawn in topic A can
        // legitimately fire a spawn in topic B (Director request another
        // topic to do work, /loop wakes paused topic, etc). bot.api.sendMessage
        // is plain text — Telegram update from bot is filtered out by
        // allowedUsers gate, so receiving topic doesn't react. This
        // endpoint takes the same path as Director auto-trigger but
        // bypasses all that.
        // Guard: loopback peer only, never via a tunnel (cf-connecting-ip),
        // plus optional shared secret ROUTER_INTERNAL_SECRET that
        // mcp-router sends in x-router-internal-secret.
        if (u.pathname === "/internal/trigger" && req.method === "POST") {
          const peer = server.requestIP(req)?.address ?? "";
          const isLoopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
          const viaTunnel = req.headers.has("cf-connecting-ip") || req.headers.has("x-forwarded-for");
          const internalSecret = process.env.ROUTER_INTERNAL_SECRET;
          const secretOk = !internalSecret || req.headers.get("x-router-internal-secret") === internalSecret;
          if (!isLoopback || viaTunnel || !secretOk) {
            console.warn(`[Router] /internal/trigger rejected (peer=${peer || "?"}, tunnel=${viaTunnel}, secretOk=${secretOk})`);
            return new Response("forbidden", { status: 403 });
          }
          let body: any;
          try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
          const topicKey = typeof body?.topicKey === "string" ? body.topicKey : null;
          const text = typeof body?.text === "string" ? body.text : null;
          if (!topicKey || !text) {
            return new Response(JSON.stringify({ ok: false, error: "missing topicKey or text" }), {
              status: 400,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          }
          // Fire-and-forget. The spawn flow itself is multi-minute; we
          // can't make MCP wait for the whole thing. Caller gets ack
          // immediately, the actual reply lands in the target topic.
          this.triggerTopicAuto({ topicKey, text }).catch((err) => {
            console.error(`[Router] /internal/trigger failed for ${topicKey}: ${(err as Error).message}`);
          });
          console.log(`[Router] /internal/trigger ${topicKey}: ${text.slice(0, 60)}`);
          return new Response(JSON.stringify({ ok: true, topicKey }), {
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }

        // /heartbeat — slim status for cloud-side Routine pings. Same data
        // as /health but with one extra field `alive: bool` indicating
        // "tick happened in last 30 min". Routines can decide to alert
        // by checking either alive=false OR HTTP non-200.
        if (u.pathname === "/heartbeat") {
          const reg = this.lastTickRegistry;
          const lastTickAgeMs = this.lastTickAt > 0 ? Date.now() - this.lastTickAt : null;
          const alive = lastTickAgeMs === null
            ? (Date.now() - this.startedAt) < 60_000  // booting (< 1 min)
            : lastTickAgeMs < 30 * 60 * 1000;          // last tick < 30 min ago
          const body = {
            alive,
            lastTickAgeMs,
            uptimeMs: Date.now() - this.startedAt,
            tickCount: this.tickCount,
            activeCount: reg?.activeCount ?? null,
            stalledCount: reg?.stalledCount ?? null,
            deferredCount: (reg?.deferredTopics?.length) ?? null,
            pid: process.pid,
          };
          return new Response(JSON.stringify(body, null, 2), {
            status: alive ? 200 : 503,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }

        // /morning-summary — last cached summary the Director generated.
        // The cloud Routine fetches this each morning and posts to a
        // Telegram thread of choice (typically the Director topic).
        // Returns 404 if no summary cached yet, 410 if it's older than
        // 18 hours (probably yesterday's, don't double-post today).
        if (u.pathname === "/morning-summary") {
          try {
            const path = resolve(ROUTER_ROOT, "config/morning-summary.json");
            if (!existsSync(path)) {
              return new Response("no summary cached yet", { status: 404 });
            }
            const raw = readFileSync(path, "utf-8");
            const data = JSON.parse(raw) as { generatedAt: number; text: string };
            const age = Date.now() - (data.generatedAt ?? 0);
            const STALE_MS = 18 * 60 * 60 * 1000;
            if (age > STALE_MS) {
              return new Response(JSON.stringify({
                error: "stale",
                ageMs: age,
                generatedAtIso: new Date(data.generatedAt).toISOString(),
              }, null, 2), {
                status: 410,
                headers: { "content-type": "application/json; charset=utf-8" },
              });
            }
            return new Response(raw, {
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          } catch (err) {
            return new Response(`error: ${(err as Error).message}`, { status: 500 });
          }
        }

        if (u.pathname !== "/health") {
          return new Response("not found", { status: 404 });
        }
        const reg = this.lastTickRegistry;
        const body = {
          ok: true,
          uptimeMs: Date.now() - this.startedAt,
          startedAt: new Date(this.startedAt).toISOString(),
          version: process.env.ROUTER_VERSION ?? null,
          lastTickAt: this.lastTickAt > 0 ? new Date(this.lastTickAt).toISOString() : null,
          lastTickAgeMs: this.lastTickAt > 0 ? Date.now() - this.lastTickAt : null,
          tickCount: this.tickCount,
          totalTopics: reg?.totalTopics ?? null,
          activeCount: reg?.activeCount ?? null,
          stalledCount: reg?.stalledCount ?? null,
          completedCount: reg?.completedCount ?? null,
          deferredCount: (reg?.deferredTopics?.length) ?? null,
          pid: process.pid,
          mode: process.env.ROUTER_WEBHOOK_URL ? "webhook" : "long-poll",
        };
        return new Response(JSON.stringify(body, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      },
    });
    console.log(`[Router] /health endpoint listening on :${this.healthServer.port}`);

    // ?????????? @grammyjs/runner ?????? bot.start() � ??? ????????
    // ???????????? ????????? ????????. ??? ????? Telegram update-loop
    // ???????????? ????????? ?????? ???????????????: ???? ??????
    // handler (????????, ???????? Whisper) ????????? ??? ?????????
    // ?????? ?? ?????? ??????????. Runner ????????? ??????????? ?
    // ????????? �????????� ?????? ????? long-poll ??????.
    // Init-watchdog. Bun.serve (выше) уже принимает /webhook, но хендлеры
    // требуют bot.botInfo. Если getMe/bot.init никогда не завершатся (шторм
    // Bun-ECONNRESET, разовый отказ Telegram на бутстрапе, гонка 409 при
    // рестарте), процесс будет "хромать" неограниченно долго: живой настолько,
    // что nssm/watchdog считают его здоровым, но каждый апдейт валится с
    // "Bot not initialized" (инцидент 2026-06-30: PID 7912 провисел так часы).
    // Сторожевой таймер форсит чистый exit, чтобы супервизор поднял заново.
    const INIT_DEADLINE_MS = 120_000;
    const initWatchdog = setTimeout(() => {
      if (!this.bot.botInfo) {
        console.error(
          `[Router] FATAL: bot.botInfo still unset ${INIT_DEADLINE_MS}ms after start; ` +
            `getMe/init never completed — exiting for supervisor restart.`,
        );
        process.exit(1);
      }
    }, INIT_DEADLINE_MS);
    // Не даём таймеру в одиночку держать процесс живым.
    if (typeof (initWatchdog as any).unref === "function") (initWatchdog as any).unref();

    console.log("[Router] Starting bot (concurrent runner)...");
    // Ручной ретрай getMe: auto-retry плагин ловит FloodWait и 5xx, но
    // Bun-специфичные ECONNRESET на самом первом запросе он не
    // перехватывает (это ошибки на уровне fetch, а не HTTP-ответа).
    // Поэтому отдельно ретраим getMe с экспоненциальным backoff.
    let me: Awaited<ReturnType<typeof this.bot.api.getMe>> | null = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        me = await this.bot.api.getMe();
        break;
      } catch (err) {
        const msg = (err as Error).message || String(err);
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 15000);
        console.error(`[Router] getMe attempt ${attempt}/6 failed: ${msg}`);
        if (attempt === 6) throw err;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    console.log(`[Router] Bot started: @${me!.username}`);

    // Initialize bot.botInfo. In long-poll mode `run()` does this for us,
    // but in webhook mode we feed updates via `bot.handleUpdate()` directly
    // and need botInfo populated up front (handlers reference bot.botInfo
    // for username/mention parsing). Idempotent, so calling here is safe
    // for both modes.
    try {
      await this.bot.init();
    } catch (err) {
      console.warn(`[Router] bot.init failed: ${(err as Error).message}`);
    }

    // botInfo обязан быть установлен к этому моменту, иначе все хендлеры
    // будут падать с "Bot not initialized". Снимаем сторож, если всё ок;
    // иначе выходим — пусть супервизор перезапустит на чистом старте.
    if (this.bot.botInfo) {
      clearTimeout(initWatchdog);
    } else {
      console.error(
        `[Router] FATAL: bot.init completed but botInfo is still unset — ` +
          `exiting for supervisor restart.`,
      );
      process.exit(1);
    }

    // Зарегистрировать меню команд в Telegram UI. Неблокирующе: если
    // setMyCommands упадёт, бот всё равно работает.
    await this.setupBotCommands();

    // --- Orphan pending-tasks recovery + auto-retry (Phase 3a) ---
    // При краше роутера все "Думаю..." сообщения остаются висеть,
    // потому что bun убивает дочерние claude.exe процессы вместе с собой.
    // Сканируем pending-tasks.json и:
    //   1) редактируем все осиротевшие сообщения в "⚠ прервана + retry";
    //   2) ЧЕРЕЗ 30 СЕК планируем авто-retry через triggerTopicAuto
    //      ("Продолжай с того, на чём остановился").
    // Без этого после рестарта пользователю приходилось вручную писать
    // "продолжай" в каждый топик — теперь Director дёргает их сам,
    // не дожидаясь следующего 15-минутного тика.
    try {
      const orphans = this.pendingTasks.snapshot();
      if (orphans.length > 0) {
        console.log(`[Router] Found ${orphans.length} orphan pending task(s), cleaning up + scheduling retry...`);
        const orphanText = "⚠ Предыдущая задача была прервана рестартом роутера. Возобновляю автоматически через 30 сек...";
        const orphanKeys: { topicKey: string; name: string }[] = [];
        for (const t of orphans) {
          try {
            await this.bot.api.editMessageText(t.chatId, t.messageId, orphanText);
            console.log(`[Router]   cleaned orphan in topic ${t.topicKey} (msg ${t.messageId})`);
            const mapping = this.topics.topics[t.topicKey];
            if (mapping && mapping.project) {
              orphanKeys.push({ topicKey: t.topicKey, name: mapping.name || t.topicKey });
            }
          } catch (err) {
            console.warn(`[Router]   failed to edit orphan in topic ${t.topicKey}: ${(err as Error).message}`);
          }
        }
        this.pendingTasks.clear();

        // Schedule retry after 30s (let Director finish boot tick first;
        // also gives Telegram getUpdates a moment to settle).
        if (orphanKeys.length > 0) {
          setTimeout(async () => {
            console.log(`[Router] Auto-retry: dispatching ${orphanKeys.length} orphaned topic(s)`);
            for (const t of orphanKeys) {
              try {
                const res = await this.triggerTopicAuto({
                  topicKey: t.topicKey,
                  text: "[orphan-retry] Продолжай с того, на чём остановился до прерывания. Сначала прочти CHECKPOINT.md, чтобы понять состояние.",
                });
                console.log(`[Router]   auto-retry ${t.name}: ok=${res.ok} rateLimited=${res.rateLimited}`);
                // Stagger: 3s between retries to avoid overwhelming runner
                await new Promise(r => setTimeout(r, 3000));
              } catch (err) {
                console.warn(`[Router]   auto-retry failed for ${t.topicKey}: ${(err as Error).message}`);
              }
            }
          }, 30000);
        }
      }
    } catch (err) {
      console.error(`[Router] Orphan cleanup failed: ${err}`);
    }

    // ─── Webhook mode (preferred when ROUTER_WEBHOOK_URL is set) ────────
    // Telegram pushes updates to https://<tunnel-host>/webhook (proxied
    // by cloudflared into our Bun.serve on :7885). No long-poll → no 409
    // Conflict ever, no ECONNRESET on getUpdates, no 30s reconnect lag.
    // The /webhook handler above feeds updates into bot.handleUpdate.
    //
    // Activation:
    //   ROUTER_WEBHOOK_URL=https://teleclaude.example.com/webhook
    //   ROUTER_WEBHOOK_SECRET=<random>  (validated against Telegram's
    //                                    x-telegram-bot-api-secret-token)
    //
    // To roll back to long-poll, unset ROUTER_WEBHOOK_URL and call
    // bot.api.deleteWebhook() once before restart (or use scripts/
    // unset-telegram-webhook.ps1).
    const webhookUrl = process.env.ROUTER_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        const params: any = {
          allowed_updates: ["message", "edited_message", "callback_query"],
          drop_pending_updates: false,
          max_connections: 40,
        };
        const secret = process.env.ROUTER_WEBHOOK_SECRET;
        if (secret) params.secret_token = secret;
        await this.bot.api.setWebhook(webhookUrl, params);
        console.log(`[Router] Webhook mode active: ${webhookUrl}`);
        // Block forever — service stays alive until SIGINT/SIGTERM. The
        // /webhook handler does all the work; nothing to spin in this
        // function. Without this, start() would return and the process
        // would exit (since nothing else holds it open in webhook mode).
        await new Promise<void>(() => { /* never resolves */ });
        return;
      } catch (err) {
        console.error(
          `[Router] setWebhook failed: ${(err as Error).message}. ` +
          `Falling back to long-poll mode.`,
        );
        // fall through to long-poll
      }
    }

    // Runner-restart loop: task() падает если Telegram вернул 409
    // (terminated by other getUpdates — часто бывает после крэша
    // предыдущего инстанса, потому что TCP-соединение ещё висит у
    // Telegram на стороне сервера 30+ секунд) или если Bun словил
    // ECONNRESET в middle of long-poll. Вместо того чтобы падать,
    // ждём и поднимаем runner заново. 401 (невалидный токен) —
    // фатально, перезапуск не поможет.
    // Если runner проработал стабильно дольше SUCCESS_RESET_MS, считаем
    // предыдущий каскад ошибок исчерпанным и сбрасываем счётчик попыток.
    // Иначе случайные сетевые иканья за неделю накапливают backoff до 30с
    // и потом одна разовая ошибка превращается в полминуты простоя.
    const SUCCESS_RESET_MS = 5 * 60 * 1000; // 5 минут
    let restartAttempt = 0;
    while (true) {
      const runStartedAt = Date.now();
      this.runnerHandle = run(this.bot);
      try {
        await this.runnerHandle.task();
        break; // task() завершилась штатно — это graceful shutdown
      } catch (err) {
        const anyErr = err as any;
        const errCode = anyErr?.error_code;
        const msg = anyErr?.message || String(err);
        const stack = (err as Error)?.stack || "";
        const cause = anyErr?.cause ? ` cause=${JSON.stringify(anyErr.cause)}` : "";
        // Принудительно стопаем runner перед рестартом — иначе старая
        // long-poll сессия может остаться висеть и Telegram вернёт 409
        // на следующий getUpdates.
        try { await this.runnerHandle?.stop(); } catch {}

        const aliveMs = Date.now() - runStartedAt;

        // 409 Conflict — НЕ наш крэш. Кто-то ещё поллит тот же токен
        // (второй инстанс на другой машине / в Docker / у другого
        // пользователя). Наш процесс жив и здоров, просто Telegram
        // выбрал другого. Логируем БЕЗ слова "crashed" чтобы watchdog
        // не считал это за крэш-лупу, НЕ инкрементируем счётчик
        // попыток и ждём 60с. Claude-подпроцессы продолжают работать.
        if (errCode === 409) {
          const offset = anyErr?.payload?.offset;
          console.error(
            `[Router] getUpdates 409 Conflict: another poller is holding the long-poll slot ` +
            `(offset=${offset ?? "n/a"}, our alive=${Math.round(aliveMs/1000)}s). ` +
            `Waiting 60s and retrying. This does NOT kill in-flight topic tasks.`
          );
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }

        if (errCode === 401) {
          // Ранее 401 был фатальным, но пользователь хочет, чтобы роутер
          // пытался подниматься после ЛЮБОЙ ошибки, даже после ротации
          // токена. Логируем и ретраим через 60 сек.
          console.error(`[Router] Token invalid (401). Retrying in 60s in case token was rotated.`);
        }

        if (aliveMs >= SUCCESS_RESET_MS && restartAttempt > 0) {
          console.error(`[Router] Runner was healthy for ${Math.round(aliveMs/1000)}s before this crash — resetting backoff counter.`);
          restartAttempt = 0;
        }
        restartAttempt++;
        // 401: токен мог быть перевыпущен — ждём минуту.
        // Остальные: exponential до 60 сек, без cap на числе попыток —
        // пользователь хочет восстанавливаться после ЛЮБОГО числа ошибок.
        const delay = (errCode === 401)
          ? 60000
          : Math.min(1000 * Math.pow(2, Math.min(restartAttempt, 6)), 60000);
        console.error(`[Router] Runner crashed (attempt #${restartAttempt}, alive ${Math.round(aliveMs/1000)}s, code=${errCode ?? "n/a"}): ${msg}${cause}`);
        if (stack) console.error(`[Router] Stack:\n${stack}`);
        console.error(`[Router] Restarting runner in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    // Security: only process messages from allowed users
    const senderId = msg.from?.id ?? 0;
    if (!this.settings.telegram.allowedUsers.includes(senderId)) {
      console.log(`[Router] Ignored message from unauthorized user ${senderId}`);
      return;
    }

    // --- Pause gate ---
    // Когда бот стоит на паузе (/pause), мы игнорируем всё, кроме узкого
    // набора команд управления. Сообщение даже не отмечаем реакцией —
    // пользователь уже знает, что пауза включена (видел ответ /pause
    // и, если нужно, /status покажет состояние).
    //
    // Разрешённые во время паузы: /resume, /status, /help, /version,
    // /uptime, /whoami, /pause (повторный). Всё остальное — no-op.
    {
      const raw = (msg.text || msg.caption || "").trim();
      const allowedDuringPause = /^\/(resume|status|help|version|uptime|whoami|pause)(@\w+)?(\s|$)/i;
      if (this.settings.runtime?.paused && !allowedDuringPause.test(raw)) {
        console.log(`[Router] Paused — ignoring message from ${senderId}`);
        return;
      }
    }

    const chatId = msg.chat.id.toString();
    const threadId = msg.message_thread_id;

    // Private messages - route as chatId:general (same pipeline as group topics)

    // Auto-register group if not known yet (skip for private chats)
    // Дефолт для новой группы — mention-only (см. my_chat_member handler выше).
    if (msg.chat.type !== "private" && !this.topics.groups[chatId]) {
      const chatTitle = msg.chat.title || `group-${chatId}`;
      this.topics.groups[chatId] = { name: chatTitle, enabled: true, mode: "mention-only" };
      saveTopics(this.topics);
      console.log(`[Router] Auto-registered new group: ${chatTitle} (${chatId}) — mention-only`);
    }
    const groupConfig = msg.chat.type !== "private"
      ? this.topics.groups[chatId]
      : { enabled: true, mode: "active" as const };
    if (!groupConfig.enabled) {
      console.log(`[Router] Group ${chatId} disabled, ignoring`);
      return;
    }

    // --- Mention-only gate ---
    // В группах с mode === "mention-only" бот реагирует только если в
    // тексте/caption есть @<botUsername>. Это позволяет держать бота в
    // группах для публикаций (контент-пайплайн и т.п.) без того чтобы
    // он расходовал модели на КАЖДОЕ сообщение пользователя. Чтобы переключить
    // обратно: `@<botUsername> /mode active` в той же группе или правка
    // config/topics.json + рестарт.
    //
    // Reply на сообщение бота и команды /xxx БЕЗ @-mention НЕ считаются
    // обращением (явное решение владельца 2026-04-19) — иначе любой случайный
    // ответ или авто-команда из меню в публичной группе будили бы бота.
    //
    // Private chats этой проверки не касаются (groupConfig.mode = "active"
    // для private fallback).
    if (msg.chat.type !== "private" && (groupConfig as any).mode === "mention-only") {
      const botUname = this.bot.botInfo?.username;
      const probe = ((msg.text || msg.caption || "") + "").toLowerCase();
      const hasMention = !!botUname && probe.includes(`@${botUname.toLowerCase()}`);
      if (!hasMention) {
        console.log(`[Router] mention-only gate: no @${botUname ?? "bot"} in msg from ${senderId} in ${chatId} — silent skip`);
        return;
      }
    }
    // Acknowledge receipt with eyes reaction
    try { await ctx.react("👀"); } catch {}

    // Get message text (or transcribe voice/audio)
    let messageText = msg.text || msg.caption || "";

    // --- DIAGNOSTIC: log what kinds of attachments are present ---
    const mAny: any = msg;
    const attachKinds: string[] = [];
    if (mAny.photo) attachKinds.push(`photo[${mAny.photo.length}]`);
    if (mAny.voice) attachKinds.push("voice");
    if (mAny.audio) attachKinds.push(`audio(${mAny.audio.mime_type || "?"})`);
    if (mAny.video) attachKinds.push("video");
    if (mAny.video_note) attachKinds.push("video_note");
    if (mAny.document) attachKinds.push(`document(${mAny.document.mime_type || "?"})`);
    if (mAny.sticker) attachKinds.push("sticker");
    if (mAny.forward_origin || mAny.forward_from || mAny.forward_from_chat) attachKinds.push("forwarded");
    if (attachKinds.length) {
      console.log(`[Router] Attachments: ${attachKinds.join(", ")}; text=${messageText ? messageText.length + " chars" : "none"}`);
    }

    // --- Photo pipeline: download largest photo, pass path to Claude ---
    // Claude Code's Read tool supports images, so we save to .tmp and tell
    // Claude to open it via Read.
    if (mAny.photo && Array.isArray(mAny.photo) && mAny.photo.length > 0) {
      try {
        const largest = mAny.photo[mAny.photo.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const ext = file.file_path?.split(".").pop() || "jpg";
        const ts = Date.now();
        const tmpDir = resolve(this.settings.projectsRoot, ".tmp");
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
        const filePath = resolve(tmpDir, `photo-${ts}.${ext}`);
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(filePath, buffer);
        const captionLine = messageText ? `Подпись к изображению: ${messageText}\n\n` : "";
        messageText = `${captionLine}Пользователь прислал изображение. Открой его через Read (ты умеешь читать картинки): ${filePath}`;
        console.log(`[Router] Photo saved: ${filePath} (${buffer.length} bytes)`);
      } catch (err) {
        console.error("[Router] Photo download failed:", err);
        await ctx.reply(`Не смог скачать изображение: ${(err as Error).message}`, { message_thread_id: threadId });
        return;
      }
    }

    // --- Video pipeline: download full video, transcribe audio track via Whisper
    // (в контейнере whisper-asr-webservice есть свой ffmpeg — принимает mp4),
    // параллельно режем ключевые кадры через локальный ffmpeg и отдаём их
    // мультимодальному Claude через Read. Если ffmpeg не стоит — сообщаем
    // причину пользователю и продолжаем без кадров (транскрипт всё равно будет).
    //
    // ВАЖНО: Telegram Bot API не даёт скачивать файлы больше 20 МБ через getFile.
    // На этот случай ловим ошибку "file is too big" и даём внятный хинт.
    let videoHandled = false;
    if (mAny.video) {
      videoHandled = true;
      const topicKey = this.buildTopicKey(chatId, threadId);
      try {
        const video = mAny.video;
        const file = await ctx.api.getFile(video.file_id);
        const ext = (file.file_path?.split(".").pop() || video.mime_type?.split("/").pop() || "mp4").toLowerCase();
        const ts = Date.now();
        const tmpDir = resolve(this.settings.projectsRoot, ".tmp");
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
        const videoPath = resolve(tmpDir, `video-${ts}.${ext}`);
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(videoPath, buffer);
        console.log(
          `[Router] Video saved: ${videoPath} (${buffer.length} bytes, ` +
            `duration=${video.duration ?? "?"}s, ${video.width ?? "?"}x${video.height ?? "?"})`,
        );

        // Параллельно: Whisper на всём mp4 + ffmpeg локально режет кадры.
        // Typing координируется через TypingCoordinator (см. ctor).
        const framesDir = resolve(tmpDir, `video-${ts}-frames`);
        this.typingCoordinator.start(chatId, threadId);

        let whisperRes: WhisperResult;
        let framesRes: Awaited<ReturnType<typeof extractFrames>>;
        try {
          [whisperRes, framesRes] = await Promise.all([
            this.whisper.transcribe(videoPath),
            extractFrames(videoPath, framesDir, {
              duration: video.duration,
              width: 1024,
            }),
          ]);
        } finally {
          this.typingCoordinator.stop(chatId, threadId);
        }

        // Транскрипт (опционально сохраняем в transcripts/)
        let transcriptBlock = "";
        let transcriptPath: string | null = null;
        if (whisperRes.ok) {
          const transcript = whisperRes.text;
          const mapping = this.topics.topics[topicKey];
          const projectPath = mapping?.project;
          if (projectPath) {
            const transcriptsDir = resolve(projectPath, "transcripts");
            if (!existsSync(transcriptsDir)) mkdirSync(transcriptsDir, { recursive: true });
            const dateStr = new Date().toISOString().slice(0, 10);
            const fname = `${dateStr}-${ts}-video.md`;
            transcriptPath = resolve(transcriptsDir, fname);
            writeFileSync(
              transcriptPath,
              `# Транскрипт видео ${new Date().toISOString()}\n\n${transcript}`,
              "utf-8",
            );
          }
          transcriptBlock =
            `\n\n=== Транскрипт аудиодорожки (${transcript.length} символов) ===\n` +
            `${transcript}\n=== конец транскрипта ===`;
          if (transcriptPath) {
            transcriptBlock += `\n(сохранён: ${transcriptPath})`;
          }
        } else {
          transcriptBlock = `\n\n[Аудиодорожка не распознана: ${formatWhisperFailure(whisperRes, videoPath)}]`;
        }

        // Кадры: список путей — Claude откроет каждый через Read.
        let framesBlock = "";
        if (framesRes.ok) {
          const lines = framesRes.frames
            .map((p, i) => `  ${i + 1}. ${p}`)
            .join("\n");
          framesBlock =
            `\n\n=== Кадры (${framesRes.count} шт., за ${framesRes.elapsedSec.toFixed(1)}s) ===\n` +
            `Прочитай каждый через Read — ты умеешь видеть картинки:\n${lines}\n` +
            `=== конец списка кадров ===`;
        } else {
          framesBlock = `\n\n[Покадровая раскладка недоступна: ${formatFrameFailure(framesRes)}]`;
        }

        const captionLine = messageText ? `Подпись к видео: ${messageText}\n\n` : "";
        const meta =
          `Длительность: ${video.duration ?? "?"}s, ` +
          `разрешение: ${video.width ?? "?"}x${video.height ?? "?"}, ` +
          `размер: ${buffer.length} байт, MIME: ${video.mime_type || "неизвестно"}`;
        messageText =
          `${captionLine}Пользователь прислал видео.\n${meta}\nФайл: ${videoPath}` +
          `${transcriptBlock}${framesBlock}\n\n` +
          `Проанализируй содержание видео: сопоставь транскрипт с кадрами, ` +
          `обрати внимание на тексты/UI/жесты/сцены и дай подробное саммари.`;
      } catch (err) {
        console.error("[Router] Video processing failed:", err);
        const errMsg = (err as Error).message;
        if (/file is too big|file too big/i.test(errMsg)) {
          await ctx.reply(
            "Видео больше 20 МБ — Telegram Bot API не даёт скачивать такие файлы. " +
              'Пришли сжатую версию (опция "compress video" в мобильном клиенте) ' +
              "или ссылкой на облачное хранилище.",
            { message_thread_id: threadId, reply_to_message_id: msg.message_id },
          );
        } else {
          await ctx.reply(`Ошибка обработки видео: ${errMsg}`, {
            message_thread_id: threadId,
            reply_to_message_id: msg.message_id,
          });
        }
        return;
      }
    }

    // Detect audio from any source: voice, audio, or document with audio MIME
    const audioFileId = videoHandled ? null : this.extractAudioFileId(msg);

    if (audioFileId) {
      // --- Audio processing pipeline ---
      const topicKey = this.buildTopicKey(chatId, threadId);

      try {
        const file = await ctx.api.getFile(audioFileId);
        const ext = this.audioExt(msg, file.file_path);
        const ts = Date.now();
        const filePath = resolve(this.settings.projectsRoot, ".tmp", `voice-${ts}.${ext}`);
        console.log(`[Router] Audio file: tg_path=${file.file_path}, resolved_ext=${ext}, mime=${(msg.audio || msg.voice || msg.document)?.mime_type || "?"}, fname=${(msg.audio || msg.document)?.file_name || "-"}`);

        // Download file
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());

        const tmpDir = resolve(this.settings.projectsRoot, ".tmp");
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
        writeFileSync(filePath, buffer);

        // Transcribe via Whisper. На CPU 11 МБ MP3 ≈ 8-10 минут — держим
        // typing-indicator пока не будет ответа, иначе пользователь думает что
        // бот завис.
        //
        // ВАЖНО (после инцидента 2026-04-08): транскрипция возвращает
        // структурированный WhisperResult, не string|null. Любая
        // не-успешная ветка теперь шлёт пользователю ВНЯТНОЕ сообщение
        // (formatWhisperFailure) с указанием причины и пути к файлу,
        // а не молчаливый "Не удалось распознать аудио."
        this.typingCoordinator.start(chatId, threadId);

        // Если whisper лежит — поднимаем заранее и пишем плашку, чтобы
        // пользователь видел что происходит (docker start медленный).
        const upRes = await this.whisper.ensureUp();
        let warmupNotice: number | null = null;
        if (!upRes.ok) {
          // ensureUp может валиться по причинам, которые transcribe()
          // повторит честно. Пробуем дальше — transcribe ещё раз
          // вызовет ensureUp и сформирует точный отчёт. Но плашку
          // покажем заранее, она информативная.
          try {
            const m = await ctx.reply(
              "Whisper не отвечает, пробую поднять контейнер...",
              { message_thread_id: threadId },
            );
            warmupNotice = m.message_id;
          } catch {}
        }

        let result: WhisperResult;
        try {
          result = await this.whisper.transcribe(filePath);
        } finally {
          this.typingCoordinator.stop(chatId, threadId);
          if (warmupNotice !== null) {
            ctx.api.deleteMessage(chatId, warmupNotice).catch(() => {});
          }
        }
        if (!result.ok) {
          const text = formatWhisperFailure(result, filePath);
          console.error(`[Router] Whisper failed: ${result.reason} — ${result.detail}`);
          await ctx.reply(text, {
            message_thread_id: threadId,
            reply_to_message_id: msg.message_id,
          });
          return;
        }
        const transcript = result.text;

        // Save full transcript to file in project dir
        const mapping = this.topics.topics[topicKey];
        const projectPath = mapping?.project;
        let transcriptPath: string | null = null;
        if (projectPath) {
          const transcriptsDir = resolve(projectPath, "transcripts");
          if (!existsSync(transcriptsDir)) mkdirSync(transcriptsDir, { recursive: true });
          const dateStr = new Date().toISOString().slice(0, 10);
          const fname = `${dateStr}-${ts}.md`;
          transcriptPath = resolve(transcriptsDir, fname);
          writeFileSync(transcriptPath, `# Транскрипт ${new Date().toISOString()}\n\n${transcript}`, "utf-8");
        }

        // Send transcript to user: inline if short, file reference if long
        const INLINE_LIMIT = 1500;
        if (transcript.length <= INLINE_LIMIT) {
          await ctx.reply(`Расшифровка:\n\n${transcript}`, {
            message_thread_id: threadId,
            reply_to_message_id: msg.message_id,
          });
        } else {
          const preview = transcript.slice(0, 500) + "...";
          const pathNote = transcriptPath ? `\n\nПолный текст: ${transcriptPath}` : "";
          await ctx.reply(`Расшифровка (${transcript.length} символов):\n\n${preview}${pathNote}`, {
            message_thread_id: threadId,
            reply_to_message_id: msg.message_id,
          });
        }

        // Check for pending context (text sent before this audio)
        const pending = this.pendingContext.get(topicKey);
        let userContext = "";
        if (pending && (Date.now() - pending.ts) < this.PENDING_CONTEXT_TTL) {
          userContext = pending.text;
          this.pendingContext.delete(topicKey);
        }

        // Build structured message for Claude: context + transcript + instruction
        const contextLine = userContext ? `Контекст от пользователя: ${userContext}\n\n` : "";
        messageText = `${contextLine}Ниже — полная расшифровка аудиосообщения (${transcript.length} символов). Сделай подробное саммари, выдели ключевые мысли и решения.\n\n---\n${transcript}\n---`;

      } catch (err) {
        console.error("[Router] Audio processing failed:", err);
        await ctx.reply(`Ошибка обработки аудио: ${(err as Error).message}`, { message_thread_id: threadId });
        return;
      }
    } else if (messageText && !videoHandled) {
      // Not audio and not video — это чистый текст, сохраняем как pending
      // context для возможного следующего аудио/видео. В случае video выше
      // messageText уже содержит структурированный блок с транскриптом и
      // кадрами — его как контекст к будущему аудио использовать нельзя.
      const topicKey = this.buildTopicKey(chatId, threadId);
      this.pendingContext.set(topicKey, { text: messageText, ts: Date.now() });
    }

    // --- Document pipeline: download non-audio documents and pass path to Claude ---
    // Claude Code's Read tool работает с текстом, кодом, PDF и картинками,
    // поэтому скачиваем файл в .tmp и просим агента открыть его через Read.
    // Аудио/видео-документы уже обработаны выше через extractAudioFileId.
    if (mAny.document && !audioFileId && !videoHandled) {
      try {
        const doc = mAny.document;
        const file = await ctx.api.getFile(doc.file_id);
        const ts = Date.now();
        const rawName = doc.file_name || `file-${ts}`;
        // Sanitize filename: оставляем буквы/цифры/._- (включая кириллицу),
        // остальное → underscore. Защита от path traversal.
        const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
        const tmpDir = resolve(this.settings.projectsRoot, ".tmp");
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
        const filePath = resolve(tmpDir, `doc-${ts}-${safeName}`);
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(filePath, buffer);
        console.log(`[Router] Document saved: ${filePath} (${buffer.length} bytes, mime=${doc.mime_type || "?"})`);

        const captionLine = messageText ? `Подпись/контекст к документу от пользователя:\n${messageText}\n\n` : "";
        const meta = `Имя файла: ${doc.file_name || "(без имени)"}\nMIME: ${doc.mime_type || "неизвестно"}\nРазмер: ${buffer.length} байт`;

        // Skill hint: выбираем подходящий user-level skill по MIME/расширению.
        // Скиллы раскладываются в ~/.claude/skills/{pdf,docx,xlsx,pptx} один раз
        // через scripts/setup-document-skills.ps1. Если их нет — Claude просто
        // отработает fallback-инструкциями ниже (pypdf/python-docx/openpyxl).
        const skillHint = buildDocumentSkillHint(filePath, doc.file_name || "", doc.mime_type || "");

        messageText = `${captionLine}Пользователь прислал документ.\n${meta}\nПуть к файлу: ${filePath}\n\n${skillHint}`;
      } catch (err) {
        console.error("[Router] Document download failed:", err);
        await ctx.reply(`Не смог скачать документ: ${(err as Error).message}`, { message_thread_id: threadId });
        return;
      }
    }

    // --- Forwarded message context ---
    // Если сообщение переслано — добавляем метаданные источника, чтобы агент
    // понимал что это не от самого пользователя, и кто/когда это написал.
    if (mAny.forward_origin || mAny.forward_from || mAny.forward_from_chat || mAny.forward_sender_name) {
      const fo: any = mAny.forward_origin || {};
      const senderParts: string[] = [];
      if (fo.sender_user) {
        const u = fo.sender_user;
        senderParts.push([u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || `id:${u.id}`);
      } else if (fo.sender_user_name) {
        senderParts.push(fo.sender_user_name);
      } else if (fo.chat) {
        senderParts.push(fo.chat.title || fo.chat.username || `chat:${fo.chat.id}`);
      } else if (mAny.forward_from) {
        const u = mAny.forward_from;
        senderParts.push([u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || `id:${u.id}`);
      } else if (mAny.forward_from_chat) {
        senderParts.push(mAny.forward_from_chat.title || `chat:${mAny.forward_from_chat.id}`);
      } else if (mAny.forward_sender_name) {
        senderParts.push(mAny.forward_sender_name);
      }
      const senderName = senderParts.filter(Boolean).join(" / ") || "(скрытый отправитель)";
      const dateUnix = fo.date || mAny.forward_date;
      const dateStr = dateUnix ? new Date(dateUnix * 1000).toISOString() : "";
      const forwardNote = `[Пересланное сообщение. Автор: ${senderName}${dateStr ? `; отправлено: ${dateStr}` : ""}]\n\n`;
      if (messageText) {
        messageText = forwardNote + messageText;
      } else {
        // Переслано без текста и без вложений — всё равно сообщаем агенту о факте.
        messageText = `${forwardNote}(сообщение без текста и без поддерживаемых вложений)`;
      }
      console.log(`[Router] Forwarded from: ${senderName}`);
    }

    if (!messageText) return;

    // Remove bot mention from text
    const botUsername = this.bot.botInfo?.username;
    if (botUsername) {
      messageText = messageText.replace(new RegExp(`@${botUsername}\\s*`, "gi"), "").trim();
    }

    if (!messageText) return;

    // KB ingest — fire-and-forget, never throws
    if (this.kbHook) {
      const msgType = mAny.photo ? "photo" : mAny.voice ? "voice" : mAny.audio ? "audio" : mAny.video ? "video" : mAny.document ? "document" : "text";
      this.kbHook.ingest({
        msg_id: String(msg.message_id),
        chat_id: chatId,
        thread_id: String(threadId ?? ""),
        sender: String(senderId),
        date: new Date(msg.date * 1000).toISOString(),
        text: messageText,
        msg_type: msgType,
      }).catch(() => {});
    }

    // Real-time knowledge extraction — fire-and-forget, after KB ingest.
    // Runs async; topicKey and mapping are resolved later, so we defer
    // the call to after resolveTopicMapping (see below, after line 1731).

    // Track previous user message_id BEFORE replacing it. /remind uses
    // this when text says "это сообщение" / "this message" without an
    // explicit Telegram reply: we treat the previous message in this
    // topic as the implicit referent.
    const lastIdKey = `${chatId}:${threadId ?? "general"}`;
    const prevUserMsgId = this.lastUserMsgId.get(lastIdKey);
    this.lastUserMsgId.set(lastIdKey, msg.message_id);

    // Handle bot commands before routing to Claude
    if (messageText.startsWith("/")) {
      const handled = await this.handleCommand(ctx, messageText, threadId, prevUserMsgId);
      if (handled) return;
    }

    // Natural-language reminder alias (без слеша).
    // Триггеры: "напомни ...", "напомнить ...", "напомни мне ...",
    //           "remind me ..." — только в начале сообщения.
    // Переписывается в "/remind ..." и идёт через тот же handleCommand,
    // включая reply-to логику и chrono-парсер.
    //
    // Примеры:
    //   "напомни завтра в 9 позвонить в банк"
    //   (reply на старое сообщение) "напомни об этом завтра"
    //   "remind me in 2 hours to check the build"
    // ВАЖНО: \b в JS-regex без флага u не считает кириллицу word-char,
    // поэтому используем явную группу разделителей и флаг `u`.
    const nlRemindMatch = messageText.match(
      /^(?:напомни(?:ть)?(?:\s+мне)?|remind\s+me)(?:[\s,:.\-]+(.*))?$/isu,
    );
    if (nlRemindMatch) {
      const rest = (nlRemindMatch[1] || "").trim();
      const rewritten = rest ? `/remind ${rest}` : "/remind";
      const handled = await this.handleCommand(ctx, rewritten, threadId, prevUserMsgId);
      if (handled) return;
    }

    // Time-prefixed natural-language scheduled tasks (без "напомни"):
    //   "через час проверь все боты"
    //   "в 9 утра запусти отчёт"
    //   "завтра в 8 пришли статистику Яндекс.Директ"
    //   "через 30 минут собери метрики"
    //   "in 2 hours run the report"
    //
    // Семантика разная: "напомни X" = напомнить тебе текстом.
    // "<time> X"        = выполнить X в это время (Claude-spawn).
    // Переписываем в /remind <time> <text> --do — flag активирует
    // runClaude=true в reminder, scheduler позовёт triggerTopicAuto.
    //
    // Чтобы не словить ложные совпадения с обычными фразами вроде
    // "в самом деле X", "через год X", regex требует чтобы time-token
    // ВЫГЛЯДЕЛ как time: либо число+единица, либо "завтра"/"послезавтра"
    // (опционально + "в HH"), либо явное "в HH(:MM)" / "in N <units>".
    const TIME_PREFIX = "(?:" + [
      "через\\s+\\d+\\s*(?:сек|мин|с|м|ч|час|часов|часа|д|дн|день|дня|дней|недел|месяц|год|лет)\\S*",
      "в\\s+\\d{1,2}(?::\\d{2})?(?:\\s*(?:утра|вечера|дня|ночи))?",
      "на\\s+\\d{1,2}(?::\\d{2})?",
      "завтра(?:\\s+в\\s+\\d{1,2}(?::\\d{2})?)?",
      "послезавтра(?:\\s+в\\s+\\d{1,2}(?::\\d{2})?)?",
      "сегодня\\s+в\\s+\\d{1,2}(?::\\d{2})?",
      "утром",
      "вечером",
      "ночью",
      "in\\s+\\d+\\s*(?:sec|min|h|hour|hours|d|day|days)\\S*",
      "at\\s+\\d{1,2}(?::\\d{2})?(?:\\s*(?:am|pm))?",
      "tomorrow(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?)?",
    ].join("|") + ")";
    const nlScheduleMatch = messageText.match(
      new RegExp(`^(${TIME_PREFIX})\\s+(.+)$`, "isu"),
    );
    if (nlScheduleMatch && !messageText.match(/^напомни|^remind/iu)) {
      const when = nlScheduleMatch[1].trim();
      const what = nlScheduleMatch[2].trim();
      const rewritten = `/remind --do ${when} ${what}`;
      console.log(`[Router] NL schedule -> ${rewritten.slice(0, 100)}`);
      const handled = await this.handleCommand(ctx, rewritten, threadId, prevUserMsgId);
      if (handled) return;
    }

    // Route by topic
    const topicKey = this.buildTopicKey(chatId, threadId);

    // --- Per-topic quiet gate ---
    // Команда /quiet N ставит этот топик в mute на N минут. Роутинг к
    // Claude блокируется, но команды продолжают работать (они уже обработаны
    // выше). Саму паузу снимает /quiet 0 или истечение таймера.
    const qUntil = this.quietUntil.get(topicKey);
    if (qUntil && qUntil > Date.now()) {
      console.log(`[Router] Topic ${topicKey} is quiet until ${new Date(qUntil).toISOString()} — skipping Claude`);
      return;
    }
    if (qUntil && qUntil <= Date.now()) {
      this.quietUntil.delete(topicKey);
    }

    console.log(`[Router] Message in topic ${topicKey}: ${messageText.slice(0, 80)}...`);
    // Reset Director's consecutive-trigger counter for this topic — the user
    // (or any other human) just engaged, so subsequent auto-triggers
    // start fresh against the runaway cap.
    if (typeof (this.director as any).resetConsecutiveTriggers === "function") {
      (this.director as any).resetConsecutiveTriggers(topicKey);
    }

    // Typing indicator — централизованно через TypingCoordinator.
    // Сразу же шлёт первый typing и регистрирует (chat, thread) для
    // последующего round-robin-тика. Стопаться будем в finally ниже.
    this.typingCoordinator.start(msg.chat.id, threadId);

    // Get or create project for this topic
    const mapping = await this.resolveTopicMapping(topicKey, chatId, threadId, messageText, ctx);

    // Record manual user activity for the auto-archive policy. Director
    // uses this to skip topics that haven't had a real user message in
    // > 30 days. Bumped on every gate-passed user message.
    this.director.recordUserMessage(topicKey, Date.now());

    // Real-time knowledge extraction — fire-and-forget, Gemini Flash.
    if (this.extractor) {
      this.extractor.extract({
        topicKey,
        topicName: mapping.name,
        projectPath: mapping.project,
        sender: "user",
        text: messageText,
      }).catch(() => {});
    }

    // Load recent messages buffer from disk (no-op if already loaded)
    this.loadRecentMessages(topicKey, mapping.project);

    // --- Build the user message with a clock prefix ---
    // Префикс времени помогает агенту понимать паузы между сообщениями
    // (паттерн заимствован у claudeclaw, prefixUserMessageWithClock).
    const clockPrefix = this.buildClockPrefix();
    const userMessage = `${clockPrefix}\n${messageText}`;

    // --- Build the system prompt fragment for THIS call ---
    // Передаём память через --append-system-prompt НА КАЖДОМ вызове,
    // потому что claude не сохраняет --append-system-prompt при --resume.
    // Это решает проблему «бот забывает контекст после рестарта/TTL».
    const systemPromptFragment = this.buildSystemPromptFragment(mapping.project, mapping.name, mapping.model, mapping.contextFiles, this.topicProvider(mapping));

    // --- Inject recent message history for new sessions ---
    // При --resume Claude уже видит историю из сессии. При новой сессии
    // (TTL истёк, роутер перезапущен) — инжектим последние N сообщений,
    // чтобы не начинать с чистого листа.
    // Session of the topic's current executor (claude UUID or opencode ses_*)
    const isNewSession = !this.topicSessionId(topicKey, mapping);
    const historyPreamble = isNewSession ? this.buildHistoryPreamble(topicKey) : "";
    if (historyPreamble) {
      console.log(`[Router] Injecting history for new session in ${topicKey} (${this.recentMsgs.get(topicKey)?.length ?? 0} msgs)`);
    }

    // Track message for compaction (raw size, без префиксов)
    const compactionPrompt = this.compactor.trackMessage(topicKey, userMessage.length);
    let fullMessage = historyPreamble + userMessage;
    if (compactionPrompt) {
      fullMessage = compactionPrompt + fullMessage;
      console.log(`[Router] Compaction triggered for ${topicKey} (${this.compactor.getMessageCount(topicKey)} msgs, ${this.compactor.getCharCount(topicKey)} chars)`);
    }

    // Send to Claude Code with streaming
    const sessionId = this.topicSessionId(topicKey, mapping);
    const chatIdNum = msg.chat.id;

    // Typing уже зарегистрирован через TypingCoordinator выше —
    // никаких отдельных setInterval здесь не нужно.

    // 2. Status message that will be updated with streamed content
    const statusMsg = await ctx.reply("Думаю...", {
      message_thread_id: threadId,
    });

    // Регистрируем "pending task" чтобы при краше роутера можно было
    // отредактировать осиротевшее "Думаю..." и не оставить пользователя
    // в бесконечном ожидании.
    this.pendingTasks.add({
      topicKey,
      chatId: chatIdNum,
      threadId: threadId,
      messageId: statusMsg.message_id,
      startedAt: Date.now(),
      preview: (fullMessage || "").slice(0, 80),
    });

    // 3. Streaming: update message every 2 seconds with accumulated output
    let lastUpdateLen = 0;
    let lastUpdateTime = 0;
    const STREAM_INTERVAL = 2000; // ms between edits
    const MAX_PREVIEW = 3900; // Telegram limit ~4096, leave room

    // Время последнего изменения текста (для heartbeat: если текста нет
    // дольше N секунд — показываем технический прогресс).
    let lastTextAt = Date.now();
    const startedAt = Date.now();

    // Live text preview in the status message is disabled now that
    // each assistant-event block is shipped as its own TG message via
    // onMessageBlock (see below). onData only updates lastTextAt so
    // the heartbeat ("Working... step N: tool") does not appear over
    // an active text stream.
    void lastUpdateTime; void lastUpdateLen; void MAX_PREVIEW; void STREAM_INTERVAL;
    const onData = (_chunk: string, _accumulated: string) => {
      lastTextAt = Date.now();
    };

    // --- Heartbeat: показываем технический прогресс если нет текста ---
    // Включается ТОЛЬКО после heartbeatAfterSeconds секунд молчания (чтобы
    // короткие ответы не плодили служебные сообщения). Затем редактирует
    // одно и то же statusMsg каждые heartbeatIntervalSeconds.
    const heartbeatAfter = (this.settings.processes.heartbeatAfterSeconds ?? 60) * 1000;
    const heartbeatEvery = (this.settings.processes.heartbeatIntervalSeconds ?? 60) * 1000;

    const fmtElapsed = (ms: number) => {
      const s = Math.floor(ms / 1000);
      const mm = Math.floor(s / 60).toString().padStart(2, "0");
      const ss = (s % 60).toString().padStart(2, "0");
      return `${mm}:${ss}`;
    };

    // Тикаем чаще, чем шлём, через дроссель:
    //  - tick каждые 5с
    //  - если текст идёт (sinceText < heartbeatAfter) — пропускаем
    //  - иначе редактируем statusMsg, но не чаще heartbeatEvery
    let lastHeartbeatAt = 0;
    const heartbeatTimer2 = setInterval(() => {
      const now = Date.now();
      const sinceText = now - lastTextAt;
      if (sinceText < heartbeatAfter) return;
      if (now - lastHeartbeatAt < heartbeatEvery) return;
      const status = this.processManager.getStatus(topicKey);
      if (!status.active) return;
      lastHeartbeatAt = now;

      const elapsed = fmtElapsed(now - startedAt);
      const tool = status.currentTool || "...";
      const detail = status.toolDetail ? `(${status.toolDetail})` : "";
      const text = `Работаю...\nшаг ${status.stepCount}: ${tool}${detail}\nпрошло ${elapsed}`;
      ctx.api.editMessageText(chatIdNum, statusMsg.message_id, text, {}).catch(() => {});
    }, 5 * 1000);

    // onProgress нужен только для побочного эффекта — апдейтить статус
    // ProcessManager (что уже происходит внутри). Здесь оставляем пустой
    // hook на случай будущих расширений.
    const onProgress = () => {};

    // Per-block TG streaming. Each completed assistant-event text
    // block becomes a separate Telegram message. Serialized via a
    // promise chain so messages arrive in the order the model wrote
    // them. The final response (resultText fallback) is only sent if
    // zero blocks were shipped (covers short replies and fast errors).
    let blocksSent = 0;
    let lastSentBlock = "";
    let sendChain: Promise<void> = Promise.resolve();
    const onMessageBlock = (text: string) => {
      const t = text.trim();
      if (!t) return;
      blocksSent++;
      lastSentBlock = t;
      sendChain = sendChain.then(async () => {
        try {
          const lastId = await this.sendLongMessage(ctx, this.ensureModelPrefix(t, mapping.model, mapping), threadId);
          if (lastId) this.lastBotMsgId.set(topicKey, lastId);
        } catch (e) {
          console.error(`[Router] per-block send failed for ${topicKey}: ${(e as Error).message}`);
        }
      });
    };

    let response: string;
    // Auto-recovery for "session gone" — claude-cli storage no longer has
    // the sessionId we asked it to --resume (TTL expired, storage wiped,
    // claude-cli reinstalled). Without retry, every spawn for this topic
    // crashes exit=1. We clear mapping.sessionId from topics.json and
    // retry once without --resume so the spawn starts fresh.
    let activeSessionId: string | undefined = sessionId;
    let recoveryAttempt = 0;
    try {
      while (true) {
        try {
          response = await this.processManager.sendMessage(
            topicKey,
            mapping.project,
            fullMessage,
            activeSessionId,
            onData,
            mapping.model,
            systemPromptFragment,
            onProgress,
            onMessageBlock,
            mapping.effort
          );
          break;
        } catch (err) {
          const errMsg = (err as Error).message || "";
          if (errMsg.includes("session gone") && recoveryAttempt === 0) {
            recoveryAttempt++;
            console.warn(`[Router] session-gone recovery for ${topicKey}: clearing the session and retrying without --resume`);
            if (clearSession(mapping, this.topicProvider(mapping).executor)) {
              this.topics.topics[topicKey] = mapping;
              saveTopics(this.topics);
            }
            activeSessionId = undefined;
            continue;
          }
          throw err;
        }
      }
    } finally {
      this.typingCoordinator.stop(chatIdNum, threadId);
      clearInterval(heartbeatTimer2);
      // Задача завершена (успех или ошибка) — снимаем pending-запись.
      this.pendingTasks.remove(topicKey);
    }

    // 4. Delete the streaming status message
    try {
      await ctx.api.deleteMessage(chatIdNum, statusMsg.message_id);
    } catch {}

    // Update session ID (stored per executor: claude / opencode)
    const newSessionId = this.processManager.getSessionId(topicKey);
    if (storeSession(mapping, newSessionId)) {
      this.topics.topics[topicKey] = mapping;
      saveTopics(this.topics);
    }

    // Wait for per-block sends to flush so a fallback (if needed) does
    // not race ahead of them.
    try { await sendChain; } catch {}

    // Send final fallback only when zero blocks were shipped. When
    // blocks were shipped, response (= resultText) is almost always
    // equal to lastSentBlock; if it differs (rare), we log but do not
    // send, to avoid duplicating the model's already-shipped tail.
    if (blocksSent === 0) {
      if (response) {
        const lastId = await this.sendLongMessage(ctx, this.ensureModelPrefix(response, mapping.model, mapping), threadId);
        if (lastId) this.lastBotMsgId.set(topicKey, lastId);
      } else {
        await ctx.reply("Claude не вернул ответ.", { message_thread_id: threadId });
      }
    } else if (response && response.trim() && response.trim() !== lastSentBlock) {
      console.log(`[Router] resultText differs from lastSentBlock for ${topicKey} ` +
        `(blocksSent=${blocksSent}, diff=${response.length - lastSentBlock.length}). ` +
        `Not sending to avoid duplication.`);
    }

    // Persist exchange to recent messages buffer (async, non-blocking).
    const recentReply = blocksSent > 0 ? lastSentBlock : response;
    if (recentReply) {
      try {
        this.saveRecentMessage(topicKey, mapping.project, messageText, recentReply);
      } catch (e) {
        console.error(`[Router] saveRecentMessage failed for ${topicKey}:`, e);
      }
    }
  }

  private async resolveTopicMapping(
    topicKey: string,
    chatId: string,
    threadId: number | undefined,
    firstMessage: string,
    ctx: Context
  ): Promise<TopicMapping> {
    const memoryDir = resolve(__dirname, "..", "templates", "openclaw-memory");

    // Check existing mapping
    if (this.topics.topics[topicKey]) {
      const mapping = this.topics.topics[topicKey];

      // If migrated from OpenClaw but no real project dir yet — create one
      if ((mapping as any).migratedFromOpenClaw && !existsSync(resolve(this.settings.projectsRoot, mapping.name))) {
        const realProject = this.projectFactory.createProject(
          mapping.name, chatId, String(threadId || "general"), firstMessage
        );
        mapping.project = realProject.project;

        // Copy topic-specific memory from OpenClaw export
        const topicMemFile = (mapping as any).topicMemory as string | undefined;
        if (topicMemFile) {
          const src = resolve(memoryDir, topicMemFile);
          if (existsSync(src)) {
            copyFileSync(src, join(realProject.project, "topic-memory.md"));
            console.log(`[Router] Copied topic memory: ${topicMemFile}`);
          }
        }

        // Copy shared memory files (people, services, shared, projects)
        this.copySharedMemory(realProject.project, memoryDir);

        delete (mapping as any).migratedFromOpenClaw;
        delete (mapping as any).topicMemory;
        this.topics.topics[topicKey] = mapping;
        saveTopics(this.topics);

        await ctx.reply(`📂 Проект инициализирован: ${mapping.name}\n📁 ${mapping.project}`, {
          message_thread_id: threadId,
        });
        return mapping;
      }

      // Verify project still exists
      if (existsSync(mapping.project)) {
        return mapping;
      }
      console.log(`[Router] Project path missing, recreating: ${mapping.project}`);
    }

    // Get topic name — try multiple methods
    let topicName = "general";
    const chatTitle = ctx.message?.chat.title || "";
    if (threadId) {
      // Method 1: forum_topic_created in reply_to_message (most reliable)
      if (ctx.message?.reply_to_message?.forum_topic_created) {
        topicName = ctx.message.reply_to_message.forum_topic_created.name;
        this.cacheTopicName(chatId, threadId, topicName);
      } else {
        // Method 2: dynamic cache (populated from forum events)
        const cacheKey = `${chatId}:${threadId}`;
        const cachedName = this.topicNameCache.get(cacheKey);
        if (cachedName) {
          topicName = cachedName;
        } else {
          // Method 3: check topics.json for previously saved name
          const knownName = this.getKnownTopicName(chatId, threadId);
          if (knownName) {
            topicName = knownName;
            this.topicNameCache.set(cacheKey, knownName);
          } else {
            // Method 4: fallback to group-topic-id
            topicName = `${chatTitle}-topic-${threadId}`;
          }
        }
      }
    } else {
      topicName = chatTitle ? `${chatTitle}-general` : "general";
    }

    // Check if OpenClaw topic memory knows the real project path for this
    // thread. If yes, reuse it instead of creating a new dir from slugified
    // topic name. This prevents the "Проект создан" false alarm when a topic
    // existed before topics.json was reset (e.g. MaxPost/baslaybot, 2026-05-04).
    let openClawProjectPath: string | undefined;
    if (threadId) {
      const topicMemFile = `topics/topic-${threadId}.md`;
      const src = resolve(memoryDir, topicMemFile);
      if (existsSync(src)) {
        try {
          const memContent = readFileSync(src, "utf-8");
          // Look for project path patterns in the memory file
          const pathMatch = memContent.match(/(?:Путь|project|Project|path):\s*(C:\\[^\n]+|\/[^\n]+)/i);
          if (pathMatch) {
            const candidate = pathMatch[1].trim();
            if (existsSync(candidate)) {
              openClawProjectPath = candidate;
              console.log(`[Router] OpenClaw memory for topic ${threadId} points to existing project: ${candidate}`);
            }
          }
        } catch {}
      }
    }

    // Mapping-aware re-attach. BEFORE we slug the current topic name and
    // create a fresh dir, look for an existing project that was previously
    // bound to this exact (chatId,threadId) — even if the user has since
    // renamed the topic in Telegram. This catches the class of bugs where
    // topics.json silently lost an entry (commit/stash/race) and the topic
    // got renamed afterward, so slug-based projectExists() can't find it.
    // Concrete incident: thread 42 was "Аудио" → Projects/audio with
    // 20KB of memory, then renamed to "Разговоры" → bot created an empty
    // razgovory/ and orphaned audio/.  See ProjectFactory.findHistoricalProject.
    let historical: ReturnType<ProjectFactory["findHistoricalProject"]>;
    try {
      // Discover backup snapshots of topics.json — config/topics.json.bak.*
      const cfgDir = resolve(ROUTER_ROOT, "config");
      const backups: string[] = [];
      try {
        for (const f of readdirSync(cfgDir)) {
          if (f.startsWith("topics.json.bak.")) {
            backups.push(resolve(cfgDir, f));
          }
        }
      } catch {}
      historical = this.projectFactory.findHistoricalProject({
        topicKey,
        groupId: chatId,
        topicId: String(threadId || "general"),
        topicsJsonBackupPaths: backups,
      });
      if (historical) {
        console.log(
          `[Router] re-attaching topic ${topicKey} to historical project ` +
          `${historical.projectPath} (via ${historical.via})`,
        );
      }
    } catch (err) {
      console.warn(`[Router] findHistoricalProject failed: ${(err as Error).message}`);
    }

    // Probe disk before creation. If the folder is already there, this is a
    // "mapping lost from topics.json" recovery — NOT a fresh project. Saying
    // "Проект создан" in that case scared the user 2026-05-03 ("почему бот
    // написал что создан, а там 568 сообщений?") — accurate text matters.
    const wasNew = !historical && !openClawProjectPath && !this.projectFactory.projectExists(topicName);

    let mapping: TopicMapping;
    if (historical) {
      // Re-attach to a previously-bound project folder. Backfill the
      // .topic-link so this discovery path is faster next time.
      this.projectFactory.writeTopicLink(
        historical.projectPath, topicName, chatId, String(threadId || "general"),
      );
      mapping = {
        name: topicName,
        project: historical.projectPath,
        memory: ["VISION.md", "SOUL.md", "main-memory.md", "topic-memory.md"],
        created: new Date().toISOString(),
      };
    } else if (openClawProjectPath) {
      // Reuse existing project directory found via OpenClaw memory
      mapping = {
        name: topicName,
        project: openClawProjectPath,
        memory: ["SOUL.md", "main-memory.md", "topic-memory.md"],
        created: new Date().toISOString(),
      };
    } else {
      // Create new project (or attach to existing dir)
      mapping = this.projectFactory.createProject(topicName, chatId, String(threadId || "general"), firstMessage);
    }

    // Copy OpenClaw topic memory if present
    if (threadId) {
      const topicMemFile = `topics/topic-${threadId}.md`;
      const src = resolve(memoryDir, topicMemFile);
      if (existsSync(src)) {
        const dest = join(mapping.project, "topic-memory.md");
        if (!existsSync(dest)) {
          copyFileSync(src, dest);
        }
        console.log(`[Router] Found OpenClaw memory for topic ${threadId}`);
      }
    }

    // Copy shared memory
    this.copySharedMemory(mapping.project, memoryDir);

    this.topics.topics[topicKey] = mapping;
    saveTopics(this.topics);

    let replyText: string;
    if (historical) {
      replyText =
        `🔗 Привязан к существующему проекту: ${mapping.name}\n` +
        `📁 ${mapping.project}\n` +
        `(найдено по ${historical.via}; история и память сохранены)`;
    } else if (wasNew) {
      replyText = `🆕 Проект создан: ${mapping.name}\n📁 ${mapping.project}`;
    } else {
      replyText =
        `🔗 Маппинг восстановлен: ${mapping.name}\n📁 ${mapping.project}\n` +
        `(папка уже существовала, ничего не перезаписано)`;
    }
    await ctx.reply(replyText, {
      message_thread_id: threadId,
    });

    return mapping;
  }

  private copySharedMemory(projectPath: string, memoryDir: string): void {
    // Copy shared memory subdirectories into the project
    const sharedDirs = ["people", "services", "shared", "projects"];
    for (const dir of sharedDirs) {
      const srcDir = resolve(memoryDir, dir);
      if (!existsSync(srcDir)) continue;
      const dstDir = join(projectPath, "memory", dir);
      mkdirSync(dstDir, { recursive: true });

      // Copy all .md files from srcDir
      try {
        const files = require("fs").readdirSync(srcDir) as string[];
        for (const file of files) {
          if (file.endsWith(".md")) {
            copyFileSync(join(srcDir, file), join(dstDir, file));
          }
        }
      } catch {}
    }
    console.log(`[Router] Shared memory copied to ${projectPath}`);
  }

  /**
   * Build the system-prompt fragment to inject via --append-system-prompt
   * on EVERY claude invocation. Includes SOUL, topic memory, main memory,
   * and a directory-scope reminder. Total length is capped to ~5500 chars
   * to stay safely under Windows command-line limits.
   *
   * Inspired by claudeclaw's loadPrompts() + DIR_SCOPE_PROMPT pattern,
   * but assembled per-topic from per-project memory files.
   */
  /**
   * Короткий тег модели для префикса сообщений ("opus-5.5"), по тем же
   * правилам, что и в system prompt (override топика -> default settings).
   */
  private modelTagFor(model?: string, mapping?: TopicMapping): string {
    const provider = this.topicProvider(mapping);
    if (provider.executor !== "claude") return providerTag(provider);
    const alias = model || this.settings.processes.defaultModel;
    const slug = (MODEL_SLUGS as Record<string, string>)[alias]
      || LEGACY_MODEL_SLUGS[alias]
      || alias;
    return shortModelTag(slug);
  }

  /**
   * Гарантия префикса модели на стороне роутера (2026-09-23, запрос пользователя):
   * модель в длинных resumed-сессиях теряет правило "[tag] в начале",
   * поэтому если текст не начинается с "[", подставляем тег сами.
   */
  private ensureModelPrefix(text: string, model?: string, mapping?: TopicMapping): string {
    const t = text.trimStart();
    if (t.startsWith('[')) return text;
    return `[${this.modelTagFor(model, mapping)}] ${text}`;
  }

  /**
   * Provider of a topic (config/providers.json + /provider). Non-claude
   * executors run only through the runner sidecar; with direct spawn
   * (runner.enabled=false) every topic stays on claude.
   */
  private topicProvider(mapping?: TopicMapping): ProviderConfig {
    if (!(this.processManager instanceof RunnerClient)) return CLAUDE_PROVIDER;
    return resolveTopicProvider(mapping);
  }

  /** Quota pool for Director: Claude auth mode, or "provider:<id>". */
  private quotaKeyFor(topicKey: string): string {
    const provider = this.topicProvider(this.topics.topics[topicKey]);
    return provider.executor === "claude" ? this.accountManager.getActiveName() : `provider:${provider.id}`;
  }

  /** Session id to resume for the topic's current executor, if any. */
  private topicSessionId(topicKey: string, mapping: TopicMapping): string | undefined {
    const executor = this.topicProvider(mapping).executor;
    const cached = this.processManager.getSessionId(topicKey);
    if (cached && executorOfSession(cached) === executor) return cached;
    return sessionFor(mapping, executor);
  }

  /** Text and buttons for /provider without an argument. */
  private providerMenu(topicKey: string): { text: string; kb: InlineKeyboard } {
    const mapping = this.topics.topics[topicKey];
    const file = loadProviders();
    const current = this.topicProvider(mapping);
    const lines: string[] = [];
    lines.push(`Провайдер: ${current.id} (${current.name || current.executor}${current.model ? ", " + current.model : ""})`);
    lines.push(mapping?.provider ? "Источник: override топика" : `Источник: default (${file.default || "claude"})`);
    lines.push("");
    if (file.providers.length <= 1) {
      lines.push(`Других провайдеров нет. Добавьте их в ${PROVIDERS_PATH} (пример: config/providers.example.json).`);
    } else {
      lines.push("Нажмите кнопку или напишите /provider <id>. Применится со следующего сообщения.");
      lines.push("Сессии хранятся отдельно для каждого исполнителя, при возврате диалог продолжится.");
    }
    const kb = new InlineKeyboard();
    let n = 0;
    for (const p of file.providers) {
      if (n > 0 && n % 3 === 0) kb.row();
      kb.text(p.id, `provider:${p.id}`);
      if (p.id === current.id) kb.primary();
      n++;
    }
    return { text: lines.join("\n"), kb };
  }

  /** Switch the provider of a topic. Returns the reply text. */
  private applyProvider(topicKey: string, id: string): string {
    const mapping = this.topics.topics[topicKey];
    if (!mapping) return "Топик не инициализирован: сначала напишите любое сообщение.";
    const file = loadProviders();
    const target = id === "default" ? getProvider(file.default, file) ?? CLAUDE_PROVIDER : getProvider(id, file);
    if (!target) {
      return `Неизвестный провайдер "${id}". Доступно: ${file.providers.map((p) => p.id).join(", ")}, default.`;
    }
    if (target.executor !== "claude" && !(this.processManager instanceof RunnerClient)) {
      return "Провайдеры кроме claude работают только через runner (settings.runner.enabled = true).";
    }
    const prev = this.topicProvider(mapping).id;
    if (id === "default") delete mapping.provider;
    else mapping.provider = target.id;
    this.topics.topics[topicKey] = mapping;
    saveTopics(this.topics);
    const lines = [`Провайдер топика: ${prev} → ${target.id}${id === "default" ? " (default)" : ""}. Применится со следующего сообщения.`];
    if (target.executor !== "claude" && target.apiKeyEnv && !readProviderKey(target)) {
      lines.push(`Внимание: ключ ${target.apiKeyEnv} не найден (keyFile: ${target.keyFile ?? "не задан"}). Без него задача не запустится.`);
    }
    if (target.executor !== "claude") {
      lines.push("Лимиты провайдера: при 429 топик встаёт на паузу, автоматического переключения нет.");
    }
    return lines.join("\n");
  }

  private buildSystemPromptFragment(projectPath: string, projectName: string, model?: string, contextFiles?: string[], provider: ProviderConfig = CLAUDE_PROVIDER): string {
    const parts: string[] = [];
    parts.push(`Ты работаешь внутри TeleClaude, в проекте «${projectName}».`);
    parts.push(`Корень проекта: ${projectPath}`);
    parts.push(`Не выходи из этого каталога без явной просьбы пользователя.`);

    // Какая модель отвечает прямо сейчас. Одна запись в system prompt на
    // каждом spawn — чтобы Claude понимал свои возможности (sonnet и opus
    // различаются по стилю и глубине). История переключений НЕ пишется
    // никуда, чтобы не раздувать контекст в длинных топиках.
    //
    // Кладём точный API slug (claude-opus-4-7 и т. п.), потому что модель
    // из training data знает только устаревший релиз и без подсказки
    // называет себя предыдущей версией. System prompt авторитетнее.
    const effectiveAlias = model || this.settings.processes.defaultModel;
    const modelSource = model ? "override топика" : "default";
    const slug = (MODEL_SLUGS as Record<string, string>)[effectiveAlias]
      || LEGACY_MODEL_SLUGS[effectiveAlias]
      || effectiveAlias;
    let shortTag = shortModelTag(slug);
    if (provider.executor !== "claude") {
      // Другой исполнитель (OpenCode) и провайдер: модель берётся из providers.json
      shortTag = providerTag(provider);
      parts.push(
        `Твоя точная модель: ${provider.model} у провайдера ${provider.name || provider.id} ` +
        `(исполнитель ${provider.executor}). Смена провайдера: /provider в топике.`
      );
    } else {
      parts.push(
        `Твоя точная модель: ${slug} (alias "${effectiveAlias}", источник: ${modelSource}). ` +
        `Переключение — команда /model в топике.`
      );
    }
    parts.push(
      `ОБЯЗАТЕЛЬНО: начинай каждое своё сообщение пользователю с префикса [${shortTag}] ` +
      `в квадратных скобках. Не полагайся на свою внутреннюю память о версиях — ` +
      `твой training cutoff устарел. Эта строка system prompt — источник истины ` +
      `о твоей реальной версии.`
    );

    // ВАЖНО: жёсткий guardrail против старого telegram-плагина Claude Code.
    // Единственный канал ответа пользователю — stdout этого процесса.
    // Роутер сам отправит твой вывод в нужный topic.
    parts.push(
      `КАНАЛ ОТВЕТА: только stdout. Роутер сам отправит вывод в нужный ` +
      `topic. НЕ используй mcp__plugin_telegram_telegram__* ` +
      `(reply/react/edit_message/download_attachment — это старый ` +
      `telegram-плагин, он дублирует в #General). Каждый topic изолирован.`
    );

    // КРАТКИЕ правила оформления TG. Полная версия — в
    // templates/TG-RULES.md, доступна через команду /rules в топике.
    // Здесь — только самое важное, чтобы не тратить токены на каждый
    // spawn.
    parts.push(
      `ФОРМАТ TG (кратко; полная версия — /rules или templates/TG-RULES.md):\n` +
      `• Таблицы — ТОЛЬКО внутри \`\`\`fenced code block\`\`\` с пробельным ` +
      `выравниванием колонок. Markdown pipe-таблицы (| a | b |) в Telegram ` +
      `не рендерятся.\n` +
      `• Обычный текст — нормальная проза, абзацы через ПУСТУЮ ` +
      `строку (2-4 предложения). НЕ рви строки внутри абзаца, ` +
      `Telegram сам переносит. Жёсткие переносы строк — ТОЛЬКО ` +
      `для таблиц и кода. Не простыни.\n` +
      `• Проза в \`\`\`-блоке (черновик сообщения/письма для ` +
      `копирования) — БЕЗ жёстких переносов: абзац = одна длинная ` +
      `строка, абзацы через пустую строку. Ручные переносы каждые ` +
      `~60 символов — ТОЛЬКО в таблицах, иначе при пересылке ` +
      `получается рваная лесенка.\n` +
      `• Эмодзи не использовать.\n` +
      `• Тире (— и –) НЕ использовать как пунктуацию. Замени на ` +
      `запятую, двоеточие или точку. Дефис в словах (bat-wrapper) ok.\n` +
      `• Пути к файлам ВСЕГДА абсолютные (${this.settings.projectsRoot}/...), ` +
      `не относительные. Пользователь не помнит твой cwd.\n` +
      `• Не дублировать raw exec output — пересказывай.\n` +
      `• Никакого постамбля "я сделал ...". Без "хочешь ещё?".`
    );

    // КРИТИЧНО: защита от дублирования работы после auto-compaction.
    // Claude Code умеет автоматически сжимать историю и вставлять
    // "Continue from where you left off" — это НЕ команда повторить
    // уже выполненные шаги. На длинных деплой-сессиях это приводит
    // к повторному деплою, повторным миграциям и двойному потоку
    // сообщений в Telegram. Эта инструкция системного уровня
    // гарантирует, что спавн после compaction сначала сверится
    // с CHECKPOINT.md и git/сервером, и только потом действует.
    parts.push(
      `ПОСЛЕ COMPACTION / "Continue from where you left off":\n` +
      `• СНАЧАЛА прочти CHECKPOINT.md в корне проекта (если есть). ` +
      `Если STATUS: COMPLETED — НЕ повторяй работу. Ответь коротко ` +
      `"по <задаче> всё готово, жду новых инструкций" и остановись.\n` +
      `• Перед любым deploy / migration / destructive-действием — ` +
      `верифицируй текущее состояние (git log -1, curl /health, ` +
      `release version, list_migrations). Если цель уже достигнута — ` +
      `пропусти шаг, залогируй "already done".\n` +
      `• НЕ дублируй успешный tool call без явной новой причины.\n` +
      `• По завершении крупной задачи — перезапиши CHECKPOINT.md:\n` +
      `  STATUS: COMPLETED | IN_PROGRESS\n` +
      `  TASK: <описание>\n` +
      `  DATE: <ISO>\n` +
      `  LAST_ACTION: <что сделал>\n` +
      `  NEXT: await user input | <следующий шаг>\n` +
      `  DO_NOT_REDO:\n  - <идемпотентные пункты>\n` +
      `  VERIFY_BEFORE_ACT: <команды проверки>\n` +
      `ПРАВИЛО МОЛЧАНИЯ: роутер шлёт каждый текстовый блок между ` +
      `tool calls отдельным сообщением в Telegram. НЕ комментируй ` +
      `каждый шаг ("сейчас проверю", "теперь деплою"). Делай ` +
      `tool calls подряд, пиши один финальный ответ.\n` +
      `ФИНАЛ ОБЯЗАТЕЛЕН: молчание — только МЕЖДУ tool calls. ` +
      `После последнего tool call ВСЕГДА пиши финальное сообщение ` +
      `пользователю (минимум 1 строка: "готово: <что именно>"). ` +
      `Если выйдешь без текста — claude exits with code 0, и ` +
      `пользователь увидит "Ошибка: Claude exited with code 0" ` +
      `вместо твоей работы.`
    );

    // Token diet: раньше было 1500/2500/2000 = 6000 chars per spawn.
    // 2026-04: 800/1800/1000 = 3600.
    // 2026-05: + VISION.md 1500 = 5100. SOFT_LIMIT расширен до 6500,
    // чтобы VISION точно влез — пользователь редактирует его через
    // `/vision`, и без него остальной контекст подвешен в воздухе.
    // VISION идёт ПЕРВЫМ блоком — он фиксирует цель проекта,
    // которая важнее текущего state'а в topic-memory.
    const SOFT_LIMIT = 6500;
    const remaining = () => SOFT_LIMIT - parts.join("\n\n").length;

    const tryAppend = (label: string, filePath: string, maxChars: number) => {
      if (!existsSync(filePath)) return;
      try {
        let content = readFileSync(filePath, "utf-8").trim();
        if (!content) return;
        const budget = Math.min(maxChars, Math.max(0, remaining() - label.length - 20));
        if (budget < 200) return; // не тратимся на огрызки
        if (content.length > budget) content = content.slice(0, budget) + "\n...(обрезано, читай файл целиком при необходимости)";
        parts.push(`--- ${label} ---\n${content}`);
      } catch {}
    };

    // VISION.md первым: стабильная шапка цели топика. Если пользователь
    // её не заполнил, файл будет содержать template с "(не определена)" —
    // пусть Claude видит и спрашивает. Лучше явный пробел, чем гадание.
    tryAppend("VISION.md", join(projectPath, "VISION.md"), 1500);
    tryAppend("SOUL.md", join(projectPath, "SOUL.md"), 800);
    tryAppend("topic-memory.md", join(projectPath, "topic-memory.md"), 1800);
    tryAppend("main-memory.md", join(projectPath, "main-memory.md"), 1000);

    // Inject topic-specific context files from global memory base
    if (contextFiles && contextFiles.length > 0) {
      const perFileLimit = Math.floor(1000 / contextFiles.length);
      for (const relPath of contextFiles) {
        const fullPath = join(MEMORY_BASE_DIR, relPath);
        tryAppend(relPath, fullPath, Math.max(perFileLimit, 300));
      }
    }

    return parts.join("\n\n");
  }

  /**
   * Build a clock prefix in the form `[YYYY-MM-DD HH:mm:ss UTC+3]`.
   * Borrowed in spirit from claudeclaw's prefixUserMessageWithClock —
   * helps the agent understand pauses and timing between messages.
   */
  private buildClockPrefix(): string {
    const now = new Date();
    const offsetMin = -now.getTimezoneOffset(); // local offset in minutes
    const sign = offsetMin >= 0 ? "+" : "-";
    const absMin = Math.abs(offsetMin);
    const offH = Math.floor(absMin / 60);
    const offM = absMin % 60;
    const offsetLabel = offM === 0
      ? `UTC${sign}${offH}`
      : `UTC${sign}${offH}:${String(offM).padStart(2, "0")}`;
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
                  `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return `[${stamp} ${offsetLabel}]`;
  }

  // ─── Recent messages buffer ──────────────────────────────────────────────

  /**
   * Load recent messages from disk into in-memory buffer.
   * Called once per topic on first access in a router session.
   */
  private loadRecentMessages(topicKey: string, projectPath: string): void {
    if (this.recentMsgs.has(topicKey)) return;
    const filePath = resolve(projectPath, "recent-messages.jsonl");
    if (!existsSync(filePath)) {
      this.recentMsgs.set(topicKey, []);
      return;
    }
    try {
      const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
      const msgs = lines
        .map(l => { try { return JSON.parse(l) as { user: string; assistant: string; ts: number }; } catch { return null; } })
        .filter((m): m is { user: string; assistant: string; ts: number } => !!m)
        .slice(-this.RECENT_MSG_MAX);
      this.recentMsgs.set(topicKey, msgs);
      if (msgs.length > 0) {
        console.log(`[Router] Loaded ${msgs.length} recent msgs for ${topicKey}`);
      }
    } catch {
      this.recentMsgs.set(topicKey, []);
    }
  }

  /**
   * Append a user+assistant exchange to the buffer and persist to disk.
   */
  private saveRecentMessage(topicKey: string, projectPath: string, user: string, assistant: string): void {
    const buf = this.recentMsgs.get(topicKey) ?? [];
    buf.push({
      // Trim to keep file manageable: keep first 600 chars of user, 1000 of assistant
      user: user.slice(0, 600),
      assistant: assistant.slice(0, 1000),
      ts: Date.now(),
    });
    if (buf.length > this.RECENT_MSG_MAX) buf.splice(0, buf.length - this.RECENT_MSG_MAX);
    this.recentMsgs.set(topicKey, buf);

    const filePath = resolve(projectPath, "recent-messages.jsonl");
    try {
      writeFileSync(filePath, buf.map(m => JSON.stringify(m)).join("\n") + "\n", "utf-8");
    } catch (e) {
      console.error(`[Router] Failed to save recent messages for ${topicKey}:`, e);
    }
  }

  /**
   * Build a history preamble to inject at the start of a NEW session.
   * Injects last N messages from buffer, capped at RECENT_MSG_INJECT_CHARS.
   */
  private buildHistoryPreamble(topicKey: string): string {
    const buf = this.recentMsgs.get(topicKey);
    if (!buf || buf.length === 0) return "";

    // Pick messages from the end, staying within the char budget
    let total = 0;
    const included: typeof buf = [];
    for (let i = buf.length - 1; i >= 0; i--) {
      const size = buf[i].user.length + buf[i].assistant.length;
      if (total + size > this.RECENT_MSG_INJECT_CHARS) break;
      included.unshift(buf[i]);
      total += size;
    }
    if (included.length === 0) return "";

    const dateOf = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
    const lines = included.map((m, i) =>
      `[${i + 1}] ${dateOf(m.ts)}\nUser: ${m.user}\nAssistant: ${m.assistant}`
    );
    return (
      `[КОНТЕКСТ: последние ${included.length} сообщений этого топика]\n` +
      lines.join("\n---\n") +
      `\n[КОНЕЦ КОНТЕКСТА]\n`
    );
  }

  // ─── Audio detection helpers ──────────────────────────────────────────────

  /**
   * Extract audio file_id from any message type: voice, audio, or document with audio MIME.
   */
  private extractAudioFileId(msg: any): string | null {
    if (msg.voice) return msg.voice.file_id;
    if (msg.audio) return msg.audio.file_id;
    if (msg.video_note) return msg.video_note.file_id;
    // Document: match by MIME or by file extension when MIME is absent/generic
    if (msg.document) {
      const mime: string = msg.document.mime_type || "";
      const fname: string = msg.document.file_name || "";
      const ext = fname.split(".").pop()?.toLowerCase() || "";
      const AUDIO_EXTS = new Set([
        "mp3", "ogg", "oga", "m4a", "aac", "flac", "wav",
        "opus", "wma", "aiff", "aif", "amr", "caf", "spx",
      ]);
      if (
        mime.startsWith("audio/") ||
        mime === "video/ogg" ||
        mime === "application/ogg" ||
        // Generic binary MIME but audio extension (common for forwarded bot files)
        (mime === "application/octet-stream" && AUDIO_EXTS.has(ext)) ||
        // No MIME at all but recognizable audio extension
        (!mime && AUDIO_EXTS.has(ext))
      ) {
        return msg.document.file_id;
      }
    }
    return null;
  }

  /**
   * Derive a sane file extension for a downloaded audio.
   * Telegram sometimes returns file_path ending in .bin/.tgvoice for forwarded files.
   */
  private audioExt(msg: any, tgFilePath: string | undefined): string {
    const pathExt = tgFilePath?.split(".").pop()?.toLowerCase() || "";
    const GOOD_EXTS = new Set([
      "mp3", "ogg", "oga", "m4a", "aac", "flac", "wav",
      "opus", "wma", "aiff", "aif", "amr",
    ]);
    if (pathExt && GOOD_EXTS.has(pathExt)) return pathExt;

    // Try file_name from original message fields
    const fname: string =
      msg.audio?.file_name || msg.document?.file_name || msg.voice?.file_name || "";
    const nameExt = fname.split(".").pop()?.toLowerCase() || "";
    if (nameExt && GOOD_EXTS.has(nameExt)) return nameExt;

    // Derive from MIME
    const mime: string =
      msg.audio?.mime_type || msg.voice?.mime_type || msg.document?.mime_type || "";
    const MIME_EXT: Record<string, string> = {
      "audio/mpeg": "mp3", "audio/mp3": "mp3",
      "audio/ogg": "ogg", "audio/opus": "opus",
      "audio/mp4": "m4a", "audio/aac": "aac",
      "audio/flac": "flac", "audio/wav": "wav",
      "audio/x-wav": "wav", "audio/amr": "amr",
      "video/ogg": "ogg", "application/ogg": "ogg",
    };
    if (mime && MIME_EXT[mime]) return MIME_EXT[mime];

    return "oga"; // safe Whisper fallback (OGG Opus)
  }

  /**
   * Try to get topic name from existing topics.json mappings (by threadId).
   * Replaces the old hardcoded TOPIC_NAMES map — names are now persisted in topics.json.
   */
  private getKnownTopicName(chatId: string, threadId: number): string | null {
    // Search topics.json for any mapping with this chatId:threadId
    const topicKey = `${chatId}:${threadId}`;
    const existing = this.topics.topics[topicKey];
    if (existing?.name && !existing.name.includes("-topic-")) {
      return existing.name;
    }
    return null;
  }

  private buildTopicKey(chatId: string, threadId?: number): string {
    if (threadId) {
      return `${chatId}:${threadId}`;
    }
    return `${chatId}:general`;
  }


  /**
   * Split long messages (Telegram limit: 4096 chars).
   *
   * Fence-aware: never cuts inside a fenced ```-block. If the block itself
   * is longer than MAX_LEN, the split closes ``` at the chunk boundary and
   * reopens ```<lang> at the start of the next chunk so each message
   * renders as a valid, self-contained code block.
   *
   * Why it matters: Telegram has no native markdown-table rendering, so we
   * output tables as monospace ``` blocks. The previous splitter cut on
   * arbitrary newline/space boundaries — if the cut landed inside a
   * ```-block, mdToHtml's lazy /```...```/ regex would fail to match the
   * orphan opening fence, ``` leaked to Telegram as literal text, and a
   * trailing orphan closing fence pair-matched with the NEXT ```-block
   * and wrapped unrelated prose as a "copy" code-block (observed
   * 2026-04-18 on the GPU-hours table answer).
   */
  private async sendLongMessage(ctx: Context, text: string, threadId?: number): Promise<number | undefined> {
    const chatId = ctx.message?.chat.id ?? ctx.callbackQuery?.message?.chat.id;
    if (!chatId) {
      console.error("[Router] sendLongMessage: no chatId in ctx");
      return undefined;
    }
    return this.sendLongMessageRaw(Number(chatId), threadId, text);
  }

  /**
   * sendLongMessage variant that doesn't need a Telegram Context — for
   * Director auto-triggers and other internal flows where there is no
   * incoming Update. Identical splitting / fallback semantics.
   */
  private async sendLongMessageRaw(chatId: number, threadId: number | undefined, text: string): Promise<number | undefined> {
    const MAX_LEN = 4000; // Leave some room under Telegram's 4096
    const chunks = splitRespectingFences(text, MAX_LEN);
    let lastMsgId: number | undefined;

    for (const chunk of chunks) {
      const html = mdToHtml(chunk);
      try {
        const sent = await this.bot.api.sendMessage(chatId, html, {
          message_thread_id: threadId,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        } as any);
        lastMsgId = sent.message_id;
      } catch (err) {
        console.error("[Router] HTML send failed, fallback to plain:", (err as Error).message);
        try {
          const sent = await this.bot.api.sendMessage(chatId, chunk, {
            message_thread_id: threadId,
          } as any);
          lastMsgId = sent.message_id;
        } catch (e2) {
          console.error("[Router] Plain fallback also failed:", (e2 as Error).message);
        }
      }
    }
    return lastMsgId;
  }

  // ─── Silent-running detection helper ─────────────────────────────────
  /**
   * If the given topic has an active runner job that hasn't emitted any
   * stream event in > silentMs, kill it via processManager.killTopic.
   * Used by triggerTopicAuto so a stuck spawn doesn't block Director's
   * retry. Manual user messages are NOT routed through here — those queue
   * normally so user-initiated work doesn't get interrupted.
   *
   * Detection uses runner /jobs?active=true and the per-job lastEventAt
   * field (already exposed by job-manager.ts:getJobStatus).
   */
  private async killIfSilentRunning(
    topicKey: string,
    silentMs = 5 * 60 * 1000,
  ): Promise<boolean> {
    try {
      const port = (this.processManager as any).cachedPort
        ?? (this.processManager as any).resolveRunnerPort?.((this.processManager as any).settings);
      if (!port) return false;
      const resp = await fetch(`http://127.0.0.1:${port}/jobs?active=true`);
      if (!resp.ok) return false;
      const data = await resp.json() as {
        jobs: Array<{ topicKey: string; state: string; lastEventAt?: number; jobId?: string }>;
      };
      const cutoff = Date.now() - silentMs;
      let silent = false;
      for (const j of data.jobs) {
        if (j.topicKey !== topicKey) continue;
        if (j.state !== "running") continue;
        if (typeof j.lastEventAt !== "number") continue;
        if (j.lastEventAt < cutoff) {
          silent = true;
          const ageMin = Math.round((Date.now() - j.lastEventAt) / 60000);
          console.log(
            `[Router] killing silent-running spawn for ${topicKey} ` +
            `(jobId=${j.jobId}, last event ${ageMin} min ago)`,
          );
          break;
        }
      }
      if (!silent) return false;
      this.processManager.killTopic(topicKey);
      // Brief grace so the cancel propagates before we queue the new message.
      await new Promise((r) => setTimeout(r, 500));
      return true;
    } catch {
      return false;
    }
  }

  // ─── Director auto-trigger spawn path ────────────────────────────────
  /**
   * Public spawn entry point used by Director auto-triggers.
   * Mirrors handleMessage's spawn flow but without:
   *   - Telegram Update parsing (text is pre-parsed)
   *   - typing indicator (auto-runs may take minutes; the heartbeat/edit
   *     logic from handleMessage is overkill for unattended work)
   *   - streaming preview edits (final message is enough for auto)
   *   - quiet gate (Director-initiated work bypasses /quiet)
   *
   * Keeps:
   *   - mapping resolution from topics.json (for project, model, sessionId)
   *   - system prompt + memory injection (same as user message)
   *   - compaction tracking
   *   - pending-task registration (so a router crash mid-spawn shows
   *     orphan-recovery message just like for user messages)
   *   - rate-limit detection (exception message + response text scan)
   *
   * Returns { ok, rateLimited, error }.  Director uses rateLimited to
   * defer the topic and pause the originating account.
   */
  public async triggerTopicAuto(opts: {
    topicKey: string;
    text: string;
    modelOverride?: string;
  }): Promise<{ ok: boolean; rateLimited: boolean; error?: string }> {
    const { topicKey, text, modelOverride } = opts;

    const [chatIdStr, threadIdStr] = topicKey.split(":");
    const chatId = Number(chatIdStr);
    const threadId = threadIdStr === "general" ? undefined : Number(threadIdStr);

    const mapping = this.topics.topics[topicKey];
    if (!mapping) {
      return { ok: false, rateLimited: false, error: `topic ${topicKey} not registered` };
    }

    // Silent-running guard: if the topic has an active spawn that hasn't
    // emitted a stream event in > 5 min, it's stuck. Without killing it,
    // the new auto-trigger would queue behind the stuck job and never run.
    // Kill the silent spawn so the new message can spawn fresh.
    await this.killIfSilentRunning(topicKey);

    console.log(`[Router] auto-trigger ${topicKey} (${mapping.name}): ${text.slice(0, 80)}`);

    const clockPrefix = this.buildClockPrefix();
    const userMessage = `${clockPrefix}\n${text}`;

    const effectiveModel = modelOverride ?? mapping.model;

    const systemPromptFragment = this.buildSystemPromptFragment(
      mapping.project, mapping.name, effectiveModel, mapping.contextFiles, this.topicProvider(mapping),
    );

    const compactionPrompt = this.compactor.trackMessage(topicKey, userMessage.length);
    const fullMessage = compactionPrompt ? compactionPrompt + userMessage : userMessage;

    let statusMsg: { message_id: number };
    try {
      statusMsg = await this.bot.api.sendMessage(chatId, "Думаю... (auto)", {
        message_thread_id: threadId,
      } as any);
    } catch (err) {
      return { ok: false, rateLimited: false, error: `failed to post status: ${(err as Error).message}` };
    }

    this.pendingTasks.add({
      topicKey,
      chatId,
      threadId,
      messageId: statusMsg.message_id,
      startedAt: Date.now(),
      preview: text.slice(0, 80),
    });

    // Typing indicator on auto-runs — без него в чате полная тишина
    // пока спавн идёт. Coordinator сам периодически рефрешит индикатор
    // (Telegram гасит его через ~5 сек), нам только start/stop.
    this.typingCoordinator.start(chatId, threadId);

    const sessionId = this.topicSessionId(topicKey, mapping);

    // Per-block TG streaming for auto-trigger path. Uses
    // sendLongMessageRaw (no ctx) and the same promise-chain order
    // guarantee as the user-driven path.
    let blocksSent = 0;
    let lastSentBlock = "";
    let sendChain: Promise<void> = Promise.resolve();
    const onMessageBlock = (text: string) => {
      const t = text.trim();
      if (!t) return;
      blocksSent++;
      lastSentBlock = t;
      sendChain = sendChain.then(async () => {
        try {
          const lastId = await this.sendLongMessageRaw(chatId, threadId, this.ensureModelPrefix(t, effectiveModel, mapping));
          if (lastId) this.lastBotMsgId.set(topicKey, lastId);
        } catch (e) {
          console.error(`[Router] auto per-block send failed for ${topicKey}: ${(e as Error).message}`);
        }
      });
    };

    let response = "";
    let rateLimited = false;
    let errorText: string | undefined;
    // Auto-recovery for "session gone" — same logic as handleMessage.
    // When claude-cli storage no longer has the sessionId we asked it to
    // --resume, clear mapping.sessionId and retry once with fresh session.
    let activeSessionId: string | undefined = sessionId;
    let recoveryAttempt = 0;
    try {
      while (true) {
        try {
          response = await this.processManager.sendMessage(
            topicKey,
            mapping.project,
            fullMessage,
            activeSessionId,
            undefined,                  // no streaming preview for auto
            effectiveModel,
            systemPromptFragment,
            undefined,
            onMessageBlock,
            mapping.effort,
          );
          break;
        } catch (err) {
          const errMsg = (err as Error).message || "";
          if (errMsg.includes("session gone") && recoveryAttempt === 0) {
            recoveryAttempt++;
            console.warn(`[Router] auto session-gone recovery for ${topicKey}: clearing the session and retrying without --resume`);
            if (clearSession(mapping, this.topicProvider(mapping).executor)) {
              this.topics.topics[topicKey] = mapping;
              saveTopics(this.topics);
            }
            activeSessionId = undefined;
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      errorText = (err as Error).message || String(err);
      if (this.isRateLimitMessage(errorText)) rateLimited = true;
    } finally {
      this.pendingTasks.remove(topicKey);
      this.typingCoordinator.stop(chatId, threadId);
    }

    // Anthropic sometimes returns a 200 with rate-limit text inside the body.
    if (response && this.isRateLimitMessage(response)) rateLimited = true;

    // Update session ID (same as handleMessage)
    const newSessionId = this.processManager.getSessionId(topicKey);
    if (storeSession(mapping, newSessionId)) {
      this.topics.topics[topicKey] = mapping;
      saveTopics(this.topics);
    }

    // Delete the "Думаю... (auto)" status message
    try { await this.bot.api.deleteMessage(chatId, statusMsg.message_id); } catch {}

    if (errorText) {
      // Surface the error in chat so the user sees what went wrong, then return.
      const errMsg = rateLimited
        ? `[Director auto] Аккаунт исчерпан. Топик отложен до сброса лимита.`
        : `[Director auto] Ошибка спавна: ${errorText.slice(0, 300)}`;
      try {
        await this.bot.api.sendMessage(chatId, errMsg, { message_thread_id: threadId } as any);
      } catch {}
      return { ok: false, rateLimited, error: errorText };
    }

    // Wait for any per-block sends to drain before the fallback.
    try { await sendChain; } catch {}

    if (blocksSent === 0 && response && response.trim()) {
      try {
        const lastId = await this.sendLongMessageRaw(chatId, threadId, this.ensureModelPrefix(response, effectiveModel, mapping));
        if (lastId) this.lastBotMsgId.set(topicKey, lastId);
      } catch (err) {
        console.warn(`[Router] auto-trigger sendLongMessageRaw failed: ${(err as Error).message}`);
      }
    } else if (blocksSent > 0 && response && response.trim() && response.trim() !== lastSentBlock) {
      console.log(`[Router] auto resultText differs from lastSentBlock for ${topicKey} ` +
        `(blocksSent=${blocksSent}). Not sending to avoid duplication.`);
    }

    return { ok: true, rateLimited };
  }

  /**
   * Atomically edit one field in a topic's CHECKPOINT.md. Used by
   * /archive, /unarchive, /priority commands.
   *
   *   field   — line key, e.g. "ARCHIVED" or "PRIORITY".
   *   value   — string to write, or null to REMOVE the line entirely.
   *
   * If the file doesn't exist, creates a minimal one with STATUS: NOT_STARTED
   * + the requested field (or just STATUS: NOT_STARTED for null-value case).
   */
  private async editCheckpointField(
    topicKey: string,
    field: string,
    value: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    const mapping = this.topics.topics[topicKey];
    if (!mapping) {
      return { ok: false, error: `Топик ${topicKey} не зарегистрирован в topics.json` };
    }
    const cpPath = resolve(mapping.project, "CHECKPOINT.md");
    try {
      let content = "";
      if (existsSync(cpPath)) {
        content = readFileSync(cpPath, "utf-8");
      } else {
        // Create minimal stub. Caller has presumably set field=value already
        // for an archive operation, so we'll add it below.
        content = "STATUS: NOT_STARTED\nTASK: \nNEXT: await user input\n";
      }
      const lineRegex = new RegExp(`^${field}:.*$`, "im");
      if (value === null) {
        // Remove the line if present; idempotent.
        content = content.replace(new RegExp(`^${field}:.*\r?\n?`, "im"), "");
      } else if (lineRegex.test(content)) {
        content = content.replace(lineRegex, `${field}: ${value}`);
      } else {
        // Insert after STATUS line (preferred) or prepend.
        if (/^STATUS:/im.test(content)) {
          content = content.replace(/^(STATUS:.*)$/im, `$1\n${field}: ${value}`);
        } else {
          content = `${field}: ${value}\n` + content;
        }
      }
      // Atomic write: tmp + rename (same pattern as Director.writeJson).
      const tmp = cpPath + ".tmp";
      writeFileSync(tmp, content, "utf-8");
      // fs.renameSync is atomic on Windows when same volume.
      const fs = require("fs") as typeof import("fs");
      fs.renameSync(tmp, cpPath);
      console.log(`[Router] /${field.toLowerCase()} edited ${topicKey}: ${field}=${value === null ? "<removed>" : value}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Create a forum topic in a supergroup via Bot API. Bot must be admin
   * with `can_manage_topics`. Returns the new message_thread_id, or null
   * on failure.
   *
   * Used for bootstrapping multi-stream projects (e.g. a site
   * with several sub-streams) where we want one parent "umbrella" topic
   * and N sub-topics with consistent naming.
   *
   * Supergroup name is the only thing varying; supply chatId from the
   * group config (e.g. -1001234567890).
   */
  public async createForumTopic(
    chatId: number,
    topicName: string,
  ): Promise<number | null> {
    try {
      const result = await this.bot.api.createForumTopic(chatId, topicName);
      const tid = (result as { message_thread_id?: number })?.message_thread_id;
      if (typeof tid !== "number") {
        console.error(`[Router] createForumTopic returned no message_thread_id:`, result);
        return null;
      }
      console.log(`[Router] createForumTopic ok: ${chatId}:${tid} "${topicName}"`);
      return tid;
    } catch (err) {
      console.error(
        `[Router] createForumTopic failed for "${topicName}" in ${chatId}:`,
        (err as Error).message,
      );
      return null;
    }
  }

  /**
   * Send a message into a specific forum topic. Helper around the
   * grammy api so callers don't need to know the exact bot.api shape.
   */
  public async sendToTopic(
    chatId: number,
    threadId: number,
    text: string,
    opts?: { parse_mode?: "Markdown" | "MarkdownV2" | "HTML" },
  ): Promise<boolean> {
    try {
      await this.bot.api.sendMessage(chatId, text, {
        message_thread_id: threadId,
        ...(opts?.parse_mode ? { parse_mode: opts.parse_mode } : {}),
      });
      return true;
    } catch (err) {
      console.error(
        `[Router] sendToTopic ${chatId}:${threadId} failed:`,
        (err as Error).message,
      );
      return false;
    }
  }

  /**
   * Heuristic match for Anthropic / claude-cli rate-limit responses.
   * Covers known phrasings as of 2026-05; widen if false negatives appear.
   *
   * 2026-05-02: Max-plan returns "You've hit your limit · resets 8am
   * (Europe/London)" as plain-text 200 OK without the words "rate",
   * "limit reached", "429". Adding explicit matchers — the v1 regex
   * missed this format and Director counted such replies as success,
   * causing 86 spawns overnight before the user noticed.
   */
  private isRateLimitMessage(text: string): boolean {
    return /rate.?limit|usage limit reached|too\s+many\s+requests|\b429\b|5-?hour limit|quota.*exceeded|rate_limit_error|hit your limit|you'?ve hit|resets?\s+\d{1,2}\s*(?:am|pm)|limit\s*[·•]\s*resets/i.test(text);
  }

  /**
   * Cache a discovered topic name for future use.
   */
  private cacheTopicName(chatId: string, threadId: number, name: string): void {
    const cacheKey = `${chatId}:${threadId}`;
    this.topicNameCache.set(cacheKey, name);
    console.log(`[Router] Cached topic name: ${name} (${cacheKey})`);
  }

  /**
   * Handle bot commands — returns true if handled.
   */
  private async handleCommand(ctx: Context, text: string, threadId?: number, prevUserMsgId?: number): Promise<boolean> {
    const trimmed = text.trim();
    const chatId = ctx.message!.chat.id.toString();
    const topicKey = this.buildTopicKey(chatId, threadId);

    // /help — inline-меню разделов. Текстовый аргумент (напр. /help all)
    // показывает полный плоский список — удобно на десктопе и для поиска.
    const helpMatch = trimmed.match(/^\/help(?:@\w+)?(?:\s+(\S+))?$/);
    if (helpMatch) {
      const arg = (helpMatch[1] || "").toLowerCase();
      if (arg === "all") {
        await ctx.reply(this.buildHelpAll(), { message_thread_id: threadId });
        return true;
      }
      const kb = new InlineKeyboard()
        .text("Контроль", "help:control").primary()
        .text("Память", "help:memory").primary().row()
        .text("Напоминания", "help:reminders").primary()
        .text("Настройки", "help:settings").primary().row()
        .text("Все команды", "help:all").success();
      await ctx.reply(
        "Справка по командам. Выбери раздел или «Все команды».",
        { message_thread_id: threadId, reply_markup: kb },
      );
      return true;
    }

    // /pause [причина] — глобальная пауза бота. Игнорит все сообщения кроме
    // /resume, /status, /help, /version, /uptime, /whoami. Флаг персистит
    // в settings.json, поэтому переживает рестарт.
    const pauseMatch = trimmed.match(/^\/pause(?:@\w+)?(?:\s+(.+))?$/s);
    if (pauseMatch) {
      const reason = (pauseMatch[1] || "").trim();
      if (!this.settings.runtime) this.settings.runtime = {};
      if (this.settings.runtime.paused) {
        await ctx.reply(
          `Бот уже на паузе (с ${new Date(this.settings.runtime.pausedAt || Date.now()).toLocaleString("ru-RU")}).\n` +
          `/resume — снять паузу.`,
          { message_thread_id: threadId },
        );
        return true;
      }
      this.settings.runtime.paused = true;
      this.settings.runtime.pausedAt = Date.now();
      if (reason) this.settings.runtime.pausedReason = reason;
      else delete this.settings.runtime.pausedReason;
      this.saveSettings();
      await ctx.reply(
        `Бот на паузе${reason ? ` (${reason})` : ""}. Новые сообщения игнорятся.\n` +
        `Команды /resume, /status, /help продолжают работать.\n` +
        `Запущенные Claude-процессы НЕ убиты — /killall если нужно.`,
        { message_thread_id: threadId },
      );
      return true;
    }

    // /resume — снять глобальную паузу.
    if (trimmed.match(/^\/resume(?:@\w+)?$/)) {
      if (!this.settings.runtime?.paused) {
        await ctx.reply("Бот не на паузе.", { message_thread_id: threadId });
        return true;
      }
      const wasPausedAt = this.settings.runtime.pausedAt;
      this.settings.runtime.paused = false;
      delete this.settings.runtime.pausedAt;
      delete this.settings.runtime.pausedReason;
      this.saveSettings();
      const durationMs = wasPausedAt ? Date.now() - wasPausedAt : 0;
      const durStr = durationMs > 0 ? ` (пауза длилась ${formatDuration(durationMs)})` : "";
      await ctx.reply(`Пауза снята${durStr}. Поехали.`, { message_thread_id: threadId });
      return true;
    }

    // /killall — убить все активные Claude-процессы разом. Сам роутер
    // продолжает работать, новые сообщения обрабатываются нормально.
    if (trimmed.match(/^\/killall(?:@\w+)?$/)) {
      const killed = this.processManager.killAll();
      if (killed === 0) {
        await ctx.reply("Активных Claude-процессов нет.", { message_thread_id: threadId });
      } else {
        await ctx.reply(`Убито процессов: ${killed}. Роутер продолжает работать.`, { message_thread_id: threadId });
      }
      return true;
    }

    // /cancel — мягкий alias к /kill для текущего топика. Смысл тот же,
    // просто привычнее слово: «отмени то что сейчас делаешь».
    if (trimmed.match(/^\/cancel(?:@\w+)?$/)) {
      const wasActive = this.processManager.killTopic(topicKey);
      if (wasActive) {
        await ctx.reply("Отменил. Топик свободен.", { message_thread_id: threadId });
      } else {
        await ctx.reply("Нечего отменять — процесс не запущен.", { message_thread_id: threadId });
      }
      return true;
    }

    // /quiet N — замьютить текущий топик на N минут. N=0 снимает mute.
    // Хранится в памяти, не переживает рестарт — это намеренно.
    const quietMatch = trimmed.match(/^\/quiet(?:@\w+)?(?:\s+(\d+))?$/);
    if (quietMatch) {
      const arg = quietMatch[1];
      if (arg === undefined) {
        const until = this.quietUntil.get(topicKey);
        if (until && until > Date.now()) {
          const left = Math.ceil((until - Date.now()) / 60000);
          await ctx.reply(`Mute активен ещё ${left} мин.\n/quiet 0 — снять.`, { message_thread_id: threadId });
        } else {
          await ctx.reply("Использование: /quiet <минут>. 0 — снять mute.", { message_thread_id: threadId });
        }
        return true;
      }
      const minutes = parseInt(arg, 10);
      if (minutes === 0) {
        this.quietUntil.delete(topicKey);
        await ctx.reply("Mute снят.", { message_thread_id: threadId });
        return true;
      }
      if (minutes < 1 || minutes > 720) {
        await ctx.reply("Минуты: 1-720 (или 0 чтобы снять).", { message_thread_id: threadId });
        return true;
      }
      this.quietUntil.set(topicKey, Date.now() + minutes * 60_000);
      await ctx.reply(
        `Замьютил топик на ${minutes} мин. Команды (кроме роутинга в Claude) продолжают работать.`,
        { message_thread_id: threadId },
      );
      return true;
    }

    // ─── /archive, /unarchive — Director controls ───────────────────
    // Управление флагом ARCHIVED в CHECKPOINT.md текущего топика.
    // ARCHIVED: true — Director никогда не auto-триггерит этот топик
    //   (всё ещё виден в дашборде в свёрнутой секции «Архив»).
    // Применяется на следующем тике Director (≤ 15 мин).
    const archiveMatch = trimmed.match(/^\/(archive|unarchive)(?:@\w+)?$/i);
    if (archiveMatch) {
      const verb = archiveMatch[1].toLowerCase();
      const want = verb === "archive";
      const result = await this.editCheckpointField(topicKey, "ARCHIVED", want ? "true" : null);
      if (result.ok) {
        await ctx.reply(
          want
            ? `📦 Топик отправлен в архив (ARCHIVED: true в CHECKPOINT.md). Director прекратит auto-триггеры.`
            : `📂 Топик возвращён в работу (флаг ARCHIVED убран). Director возобновит триггеры на следующем тике.`,
          { message_thread_id: threadId },
        );
      } else {
        await ctx.reply(`Не получилось: ${result.error}`, { message_thread_id: threadId });
      }
      return true;
    }

    // ─── /priority high|normal|low ─────────────────────────────────────
    // Управление сортировкой в Director'е. high уходит в начало очереди.
    const priorityMatch = trimmed.match(/^\/priority(?:@\w+)?(?:\s+(\S+))?$/i);
    if (priorityMatch) {
      const arg = (priorityMatch[1] || "").toLowerCase();
      if (!arg) {
        await ctx.reply("Использование: /priority high | normal | low", { message_thread_id: threadId });
        return true;
      }
      if (!["high", "normal", "low"].includes(arg)) {
        await ctx.reply(`Неизвестное значение: ${arg}. Допустимо: high, normal, low.`, { message_thread_id: threadId });
        return true;
      }
      const value = arg === "normal" ? null : arg; // normal = убираем строку
      const result = await this.editCheckpointField(topicKey, "PRIORITY", value);
      if (result.ok) {
        await ctx.reply(
          arg === "normal"
            ? `Приоритет сброшен (PRIORITY-строка убрана из CHECKPOINT.md).`
            : `Приоритет: ${arg}. Director учтёт на следующем тике.`,
          { message_thread_id: threadId },
        );
      } else {
        await ctx.reply(`Не получилось: ${result.error}`, { message_thread_id: threadId });
      }
      return true;
    }

    // /mode [active|mention-only] — управление режимом текущей группы.
    // В private чате команда недоступна (там mode всегда active по
    // определению). В mention-only группе сама команда сможет сработать
    // только при наличии @<bot> в сообщении — иначе gate её отфильтрует
    // раньше handleCommand. То есть из отложки переключаться надо как
    // `@YourBot /mode active`.
    const modeMatch = trimmed.match(/^\/mode(?:@\w+)?(?:\s+(\S+))?$/i);
    if (modeMatch) {
      const msgForMode = ctx.message;
      if (!msgForMode || msgForMode.chat.type === "private") {
        await ctx.reply(
          "/mode работает только в группах. В личке режим всегда active.",
          { message_thread_id: threadId },
        );
        return true;
      }
      const chatIdForMode = msgForMode.chat.id.toString();
      const group = this.topics.groups[chatIdForMode];
      if (!group) {
        await ctx.reply(
          "Группа ещё не зарегистрирована. Напиши любое сообщение — бот авто-зарегистрирует и она появится в topics.json.",
          { message_thread_id: threadId },
        );
        return true;
      }
      const current = group.mode || "active";
      const arg = (modeMatch[1] || "").toLowerCase();
      if (!arg) {
        await ctx.reply(
          `Режим группы "${group.name}": ${current}\n` +
          `Переключить: /mode active  или  /mode mention-only`,
          { message_thread_id: threadId },
        );
        return true;
      }
      if (arg !== "active" && arg !== "mention-only") {
        await ctx.reply(
          `Неизвестный режим: ${arg}. Допустимые: active, mention-only.`,
          { message_thread_id: threadId },
        );
        return true;
      }
      if (current === arg) {
        await ctx.reply(`Режим уже ${arg}, изменений нет.`, { message_thread_id: threadId });
        return true;
      }
      group.mode = arg as GroupMode;
      saveTopics(this.topics);
      const explain = arg === "mention-only"
        ? "Теперь бот реагирует только если тегнуть @<bot> в тексте или подписи."
        : "Теперь бот реагирует на все сообщения от разрешённых пользователей в этой группе.";
      await ctx.reply(
        `Режим группы "${group.name}" переключён: ${current} → ${arg}\n${explain}`,
        { message_thread_id: threadId },
      );
      return true;
    }

    // /uptime — сколько роутер уже работает с последнего рестарта.
    if (trimmed.match(/^\/uptime(?:@\w+)?$/)) {
      const ms = Date.now() - this.bootedAt;
      await ctx.reply(
        `Аптайм роутера: ${formatDuration(ms)}\n` +
        `Старт: ${new Date(this.bootedAt).toLocaleString("ru-RU")}`,
        { message_thread_id: threadId },
      );
      return true;
    }

    // /version — branch + short commit + dirty-флаг. Инфо заполняется
    // один раз в start() через git rev-parse.
    if (trimmed.match(/^\/version(?:@\w+)?$/)) {
      if (!this.versionInfo) {
        await ctx.reply("Информация о версии недоступна (git не отвечает).", { message_thread_id: threadId });
        return true;
      }
      const dirtyMark = this.versionInfo.dirty ? " [dirty]" : "";
      await ctx.reply(
        `Ветка: ${this.versionInfo.branch}\n` +
        `Коммит: ${this.versionInfo.commit}${dirtyMark}\n` +
        `Старт процесса: ${new Date(this.bootedAt).toLocaleString("ru-RU")}`,
        { message_thread_id: threadId },
      );
      return true;
    }

    // /whoami — Telegram-id отправителя, тип чата, thread, активный OAuth.
    // Полезно для отладки в групповых форумах и multi-account настройки.
    if (trimmed.match(/^\/whoami(?:@\w+)?$/)) {
      const from = ctx.message!.from;
      const chat = ctx.message!.chat;
      const who = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "(no name)";
      const lines = [
        `Ты: ${who} (id: ${from?.id ?? "?"}${from?.username ? `, @${from.username}` : ""})`,
        `Чат: ${chat.title || chat.type} (id: ${chat.id})`,
        `Topic key: ${topicKey}${threadId ? ` (thread ${threadId})` : ""}`,
        `Режим авторизации Claude: ${this.accountManager.getActiveName()}`,
      ];
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /project — путь к папке проекта и рабочему корню топика.
    if (trimmed.match(/^\/project(?:@\w+)?$/)) {
      const mapping = this.topics.topics[topicKey];
      if (!mapping) {
        await ctx.reply("Топик не инициализирован (напиши любое сообщение).", { message_thread_id: threadId });
        return true;
      }
      const lines = [
        `Топик: ${mapping.name}`,
        `Путь: ${mapping.project}`,
        `Создан: ${mapping.created}`,
      ];
      if (mapping.sessionId) lines.push(`Session: ${mapping.sessionId}`);
      for (const [ex, sid] of Object.entries(mapping.sessions || {})) lines.push(`Session (${ex}): ${sid}`);
      if (mapping.provider) lines.push(`Провайдер (override): ${mapping.provider}`);
      if (mapping.model) lines.push(`Модель (override): ${mapping.model}`);
      if (mapping.effort) lines.push(`Effort (override): ${mapping.effort}`);
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /topics — все активные Claude-процессы через processManager.listActive.
    if (trimmed.match(/^\/topics(?:@\w+)?$/)) {
      const active = this.processManager.listActive();
      if (active.length === 0) {
        await ctx.reply("Активных процессов нет.", { message_thread_id: threadId });
        return true;
      }
      const now = Date.now();
      const lines = [`Активных процессов: ${active.length}`, ""];
      for (const a of active) {
        const elapsed = a.startedAt ? formatDuration(now - a.startedAt) : "?";
        const tool = a.currentTool || "(wait)";
        const mapping = this.topics.topics[a.topicKey];
        const name = mapping?.name || a.topicKey;
        lines.push(`• ${name}`);
        lines.push(`  шагов ${a.stepCount}, ${tool}, идёт ${elapsed}`);
      }
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /runner — статус sidecar-демона. В direct-spawn режиме просто
    // отвечаем, что runner выключен.
    if (trimmed.match(/^\/runner(?:@\w+)?$/)) {
      const enabled = !!this.settings.runner?.enabled;
      if (!enabled) {
        await ctx.reply("Runner выключен (direct-spawn режим).", { message_thread_id: threadId });
        return true;
      }
      const port = this.settings.runner?.port ?? 7878;
      const url = `http://127.0.0.1:${port}/health`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        const resp = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const body = await resp.text();
          await ctx.reply(`Runner на :${port} жив.\n${body.slice(0, 400)}`, { message_thread_id: threadId });
        } else {
          await ctx.reply(`Runner ответил HTTP ${resp.status} на :${port}.`, { message_thread_id: threadId });
        }
      } catch (err) {
        await ctx.reply(
          `Runner не отвечает на :${port} (${(err as Error).message}).\n` +
          `Проверь runner/scripts/start-runner.cmd или runner watchdog.`,
          { message_thread_id: threadId },
        );
      }
      return true;
    }

    // /logs [N] — последние N строк из bot.out.log (по умолчанию 30).
    const logsMatch = trimmed.match(/^\/logs(?:@\w+)?(?:\s+(\d+))?$/);
    if (logsMatch) {
      const n = Math.min(parseInt(logsMatch[1] || "30", 10), 200);
      try {
        const logPath = resolve(ROUTER_ROOT, "bot.out.log");
        if (!existsSync(logPath)) {
          await ctx.reply(`Лог не найден: ${logPath}`, { message_thread_id: threadId });
          return true;
        }
        const content = readFileSync(logPath, "utf-8");
        const lines = content.split(/\r?\n/);
        const tail = lines.slice(-n).join("\n");
        const truncated = tail.length > 3500 ? "...\n" + tail.slice(-3500) : tail;
        await ctx.reply(
          `Последние ${n} строк bot.out.log:\n\n<pre>${escapeHtml(truncated)}</pre>`,
          { message_thread_id: threadId, parse_mode: "HTML" },
        );
      } catch (err) {
        await ctx.reply(`Ошибка чтения лога: ${(err as Error).message}`, { message_thread_id: threadId });
      }
      return true;
    }

    // /status — show active processes
    if (trimmed === "/status") {
      const active = this.processManager.getActiveCount();
      const ttl = this.settings.processes.ttlMinutes;
      const maxConc = this.settings.processes.maxConcurrent;
      const compaction = this.settings.compaction.enabled ? "ON" : "OFF";
      const memory = this.settings.memory.enabled ? "ON" : "OFF";

      const lines = [
        `Активных процессов: ${active}/${maxConc}`,
        `TTL: ${ttl} мин`,
        `Компрессия контекста: ${compaction}`,
        `Ревизия памяти: ${memory}`,
      ];
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /ttl без аргумента — показать текущее значение + пресеты кнопками.
    // Вариант с числом (/ttl N) идёт дальше.
    if (trimmed.match(/^\/ttl(?:@\w+)?$/)) {
      const current = this.settings.processes.ttlMinutes;
      const kb = new InlineKeyboard()
        .text("5 мин", "ttl:5").primary()
        .text("15 мин", "ttl:15").primary().row()
        .text("30 мин", "ttl:30").primary()
        .text("60 мин", "ttl:60").primary().row()
        .text("3 часа", "ttl:180").primary()
        .text("12 часов", "ttl:720").primary();
      await ctx.reply(
        `Текущий TTL: ${current} мин.\n` +
        `Выбери пресет кнопкой или пришли /ttl <минут> (1-1440).`,
        { message_thread_id: threadId, reply_markup: kb } as any,
      );
      return true;
    }

    // /ttl N — set TTL in minutes
    const ttlMatch = trimmed.match(/^\/ttl\s+(\d+)$/);
    if (ttlMatch) {
      const newTtl = parseInt(ttlMatch[1], 10);
      if (newTtl < 1 || newTtl > 1440) {
        await ctx.reply("TTL должен быть от 1 до 1440 минут.", { message_thread_id: threadId });
        return true;
      }
      this.settings.processes.ttlMinutes = newTtl;
      this.saveSettings();
      await ctx.reply(`TTL установлен: ${newTtl} мин.`, { message_thread_id: threadId });
      return true;
    }

    // /name <name> — rename current topic
    const nameMatch = trimmed.match(/^\/name\s+(.+)$/);
    if (nameMatch) {
      const newName = nameMatch[1].trim();
      if (!newName) {
        await ctx.reply("Использование: /name <новое имя>", { message_thread_id: threadId });
        return true;
      }

      // Update topics.json
      if (this.topics.topics[topicKey]) {
        this.topics.topics[topicKey].name = newName;
        saveTopics(this.topics);
      }

      // Update cache
      if (threadId) {
        this.cacheTopicName(chatId, threadId, newName);
      }

      await ctx.reply(`Топик переименован: ${newName}`, { message_thread_id: threadId });
      return true;
    }

    // /compact — force context compaction
    if (trimmed === "/compact") {
      const mapping = this.topics.topics[topicKey];
      if (!mapping) {
        await ctx.reply("Топик не инициализирован.", { message_thread_id: threadId });
        return true;
      }

      // Force compaction by sending compaction instruction as the next message
      const compactionMsg = this.compactor.getCompactionPrompt();
      const fullMessage = `${compactionMsg}\n---\nСообщение от пользователя:\nОбнови topic-memory.md: сохрани все важные решения и факты из нашего диалога, удали устаревшее. Ответь кратко что сохранил.`;

      this.typingCoordinator.start(ctx.message!.chat.id, threadId);

      const sessionId = this.topicSessionId(topicKey, mapping);
      const sysPrompt = this.buildSystemPromptFragment(mapping.project, mapping.name, mapping.model, undefined, this.topicProvider(mapping));
      let response: string;
      try {
        response = await this.processManager.sendMessage(
          topicKey, mapping.project, fullMessage, sessionId, undefined, mapping.model, sysPrompt,
          undefined, undefined, mapping.effort
        );
      } finally {
        this.typingCoordinator.stop(ctx.message!.chat.id, threadId);
      }

      // Reset compaction counters after manual compaction
      this.compactor.resetCounter(topicKey);

      if (response) {
        await this.sendLongMessage(ctx, response, threadId);
      } else {
        await ctx.reply("Компрессия выполнена.", { message_thread_id: threadId });
      }
      return true;
    }

    // /reset — reset session (kill process, start fresh with memory)
    if (trimmed === "/reset") {
      this.processManager.killTopic(topicKey);
      this.compactor.resetCounter(topicKey);

      // Clear session ID so next message starts a new session
      if (this.topics.topics[topicKey]) {
        delete this.topics.topics[topicKey].sessionId;
        delete this.topics.topics[topicKey].sessions;
        saveTopics(this.topics);
      }

      await ctx.reply("Сессия сброшена. Следующее сообщение начнет новый диалог с сохраненной памятью.", { message_thread_id: threadId });
      return true;
    }

    // /alive — show current process status (что делает, сколько работает)
    if (trimmed === "/alive") {
      const status = this.processManager.getStatus(topicKey);
      if (!status.active) {
        await ctx.reply("Нет активного процесса для этого топика.", { message_thread_id: threadId });
        return true;
      }
      const now = Date.now();
      const elapsed = status.startedAt ? Math.floor((now - status.startedAt) / 1000) : 0;
      const sinceEvent = status.lastEventAt ? Math.floor((now - status.lastEventAt) / 1000) : 0;
      const mm = (n: number) => `${Math.floor(n / 60).toString().padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
      const idleMin = this.settings.processes.idleTimeoutMinutes ?? 5;
      const lines = [
        `Процесс жив`,
        `Шагов: ${status.stepCount}`,
        `Текущий tool: ${status.currentTool || "(нет)"}${status.toolDetail ? ` — ${status.toolDetail}` : ""}`,
        `Работает: ${mm(elapsed)}`,
        `С последнего события: ${sinceEvent}с`,
        `Idle-таймаут: ${idleMin} мин`,
      ];
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /kill — kill current topic's process
    if (trimmed === "/kill") {
      const wasActive = this.processManager.killTopic(topicKey);
      if (wasActive) {
        await ctx.reply("Процесс убит.", { message_thread_id: threadId });
      } else {
        await ctx.reply("Нет активного процесса для этого топика.", { message_thread_id: threadId });
      }
      return true;
    }

    // /memory — show memory stats for current topic
    if (trimmed === "/memory") {
      const mapping = this.topics.topics[topicKey];
      if (!mapping) {
        await ctx.reply("Топик не инициализирован.", { message_thread_id: threadId });
        return true;
      }

      const stats = this.memoryManager.getStats(mapping.project);
      const msgCount = this.compactor.getMessageCount(topicKey);
      const charCount = this.compactor.getCharCount(topicKey);

      const lines = [
        `Топик: ${mapping.name}`,
        `Файлов памяти: ${stats.totalFiles}`,
        `Строк: ${stats.totalLines}`,
        `Размер: ${(stats.totalSize / 1024).toFixed(1)} KB`,
        ``,
        `Текущая сессия:`,
        `Сообщений: ${msgCount}`,
        `Символов контекста: ${(charCount / 1000).toFixed(1)}K`,
      ];
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /rules — отправить канонический файл правил оформления TG.
    // Источник: templates/TG-RULES.md (правится напрямую). Кратко эти
    // правила также захардкожены в system prompt каждого spawn'а
    // (см. buildSystemPromptFragment), команда нужна для:
    //   1) показать пользователю, что бот "должен" знать;
    //   2) пользователь может реплайнуть на это сообщение и сказать
    //      "вспомни и применяй" — бот увидит правила в reply-to и
    //      применит к следующему ответу.
    if (trimmed === "/rules" || trimmed.startsWith("/rules@")) {
      try {
        if (!existsSync(TG_RULES_PATH)) {
          await ctx.reply(
            `Файл правил не найден: ${TG_RULES_PATH}`,
            { message_thread_id: threadId }
          );
          return true;
        }
        const content = readFileSync(TG_RULES_PATH, "utf-8").trim();
        // Telegram limit 4096; файл должен быть короче, но на всякий
        // случай режем.
        const safe = content.length > 3900
          ? content.slice(0, 3900) + "\n...(обрезано, см. файл целиком)"
          : content;
        await ctx.reply(safe, { message_thread_id: threadId });
      } catch (err) {
        await ctx.reply(
          `Ошибка чтения правил: ${err instanceof Error ? err.message : String(err)}`,
          { message_thread_id: threadId }
        );
      }
      return true;
    }

    // /vision [текст]   — стабильная шапка цели топика, прокидывается
    //                     первым блоком в system prompt каждого spawn'а
    //                     (см. buildSystemPromptFragment, бюджет 1500).
    //   /vision         — показать текущий VISION.md
    //   /vision <текст> — перезаписать VISION.md (создаёт если нет)
    //   /vision --append <текст>  — дописать к существующему
    //
    // Файл живёт в корне проекта топика рядом с CHECKPOINT.md.
    // Пользователь редактирует один раз, дальше любой Claude-spawn в
    // топике видит цель и не задаёт "а что мы делаем?" заново.
    const visionMatch = trimmed.match(/^\/vision(?:@\w+)?(?:\s+([\s\S]+))?$/);
    if (visionMatch) {
      const arg = (visionMatch[1] || "").trim();
      const mapping = this.topics.topics[topicKey];
      if (!mapping) {
        await ctx.reply(
          `Топик ${topicKey} не зарегистрирован — отправь любое сообщение, ` +
          `Director создаст проект, потом снова /vision.`,
          { message_thread_id: threadId }
        );
        return true;
      }
      const visionPath = join(mapping.project, "VISION.md");

      // /vision без аргументов — показать.
      if (!arg) {
        if (!existsSync(visionPath)) {
          await ctx.reply(
            `VISION.md не существует. Перезапиши через ` +
            `\`/vision <текст цели проекта>\`.`,
            { message_thread_id: threadId, parse_mode: "Markdown" }
          );
          return true;
        }
        const cur = readFileSync(visionPath, "utf-8").trim();
        const safe = cur.length > 3900 ? cur.slice(0, 3900) + "\n...(обрезано)" : cur;
        await ctx.reply(
          `VISION.md (${cur.length} символов):\n\n${safe}`,
          { message_thread_id: threadId }
        );
        return true;
      }

      // /vision --append <текст> — дописать
      const appendMatch = arg.match(/^--append\s+([\s\S]+)$/);
      try {
        let nextContent: string;
        if (appendMatch) {
          const tail = appendMatch[1].trim();
          const prev = existsSync(visionPath) ? readFileSync(visionPath, "utf-8") : "";
          nextContent = prev.trimEnd() + "\n\n" + tail + "\n";
        } else {
          // Полная замена. Если пользователь прислал короткий one-liner,
          // оборачиваем в минимальный шаблон с заголовком, чтобы не
          // терять структуру разделов.
          if (arg.length < 200 && !arg.includes("\n") && !arg.startsWith("#")) {
            nextContent =
              `# Vision: ${mapping.name || topicKey}\n\n` +
              `## Цель\n${arg}\n\n` +
              `## Критерии успеха\n(уточнить)\n\n` +
              `## Constraints\n(уточнить)\n`;
          } else {
            nextContent = arg.endsWith("\n") ? arg : arg + "\n";
          }
        }
        // Atomic write: tmp + rename.
        const tmp = visionPath + ".tmp";
        writeFileSync(tmp, nextContent, "utf-8");
        const fs = require("fs") as typeof import("fs");
        fs.renameSync(tmp, visionPath);
        const action = appendMatch ? "дописан" : "перезаписан";
        await ctx.reply(
          `VISION.md ${action} (${nextContent.length} символов). ` +
          `Применится со следующего spawn'а.`,
          { message_thread_id: threadId }
        );
      } catch (err) {
        await ctx.reply(
          `Ошибка записи VISION.md: ${err instanceof Error ? err.message : String(err)}`,
          { message_thread_id: threadId }
        );
      }
      return true;
    }

    // /remind <когда> [текст] [to:<chatId>[:<threadId>]]
    //
    // Форматы "когда" (любой из):
    //   - relative:  1h, 30m, 2d3h, 90s, 2ч30м, 1д
    //   - natural:   "завтра в 9", "в пятницу 14:00", "10 апреля 18:00"
    //                (русский + английский через chrono-node)
    //
    // Reply-to: если команда — реплай на сообщение, текст напоминания
    // автоматически получает ссылку на оригинал + снiппет первых 80 символов.
    // Это значит: можно сделать reply + написать просто `/remind через неделю`,
    // без дополнительного текста.
    //
    // Примеры:
    //   /remind 1h поднять Figma
    //   /remind завтра в 9 купить хлеб
    //   /remind в пятницу 14:00 митинг
    //   (reply) /remind через неделю
    //   /remind to:-1001234567890:42 1h напомни в чужой топик
    const remindMatch = trimmed.match(/^\/remind(?:@\w+)?(?:\s+(.*))?$/s);
    if (remindMatch) {
      const rest = (remindMatch[1] || "").trim();
      // Telegram автоматически прикладывает service-message о создании
      // топика (forum_topic_created, message_id == threadId) как
      // reply_to_message КО ВСЕМ сообщениям в форумных топиках. Это НЕ
      // настоящий reply пользователя. Фильтруем такие ложные reply'и:
      // если reply_to_message содержит forum_topic_created — игнорируем,
      // если message_id == threadId — игнорируем (та же ситуация).
      // Иначе ссылка-напоминание получалась /<thread>/<thread> вместо
      // /<thread>/<реальный msgId> (видно в чате 2026-05-07).
      const rawReply = ctx.message?.reply_to_message as any;
      let replyTo: any = (rawReply
        && !rawReply.forum_topic_created
        && rawReply.message_id !== threadId)
        ? rawReply
        : undefined;

      // Fallback for natural-language: "напомни про это сообщение",
      // "remind me about this" — без явного TG-reply. Берём предыдущее
      // сообщение в этом топике (lastUserMsgId map). Это интуитивно
      // правильно: «это» обычно ссылается на то, что только что было.
      if (!replyTo && prevUserMsgId && prevUserMsgId !== ctx.message?.message_id) {
        const refersToThis = /\bэт(о|ом|их|у|ого)\b|\bthis\b/iu.test(rest);
        if (refersToThis) {
          replyTo = { message_id: prevUserMsgId, text: "", caption: "" };
        }
      }

      // 0) Флаг --do — при срабатывании запустить Claude (через
      //    triggerTopicAuto), а не просто sendMessage. Может стоять в
      //    любой позиции; вырезаем из payload до chrono-парсинга.
      let runClaude = false;
      let restAfterDo = rest;
      const doMatch = restAfterDo.match(/(?:^|\s)--do\b\s*/);
      if (doMatch) {
        runClaude = true;
        restAfterDo = (restAfterDo.slice(0, doMatch.index) + restAfterDo.slice(doMatch.index! + doMatch[0].length)).trim();
      }

      // 1) Опциональный override "to:CHAT[:THREAD]" — в любой позиции
      let targetChatId = chatId;
      let targetThreadId: number | null = threadId ?? null;
      let payload = restAfterDo;
      const toMatch = payload.match(/(?:^|\s)to:(-?\d+)(?::(\d+))?(?=\s|$)/);
      if (toMatch) {
        targetChatId = toMatch[1];
        targetThreadId = toMatch[2] ? parseInt(toMatch[2], 10) : null;
        payload = (payload.slice(0, toMatch.index) + payload.slice(toMatch.index! + toMatch[0].length)).trim();
      }

      // 2) Пустой payload — только через reply? Нет, всё равно нужно время.
      if (!payload) {
        await ctx.reply(
          [
            "Использование: /remind <когда> [текст]",
            "Можно делать reply на сообщение — тогда текст не обязателен.",
            "Примеры:",
            "  /remind 1h позвонить",
            "  /remind 2д3ч дедлайн",
            "  /remind завтра в 9 купить хлеб",
            "  /remind в пятницу 14:00 митинг",
            "  (reply) /remind через неделю",
          ].join("\n"),
          { message_thread_id: threadId },
        );
        return true;
      }

      // 3) Парсим «когда» — сначала strict relative, потом chrono (ru+en)
      const parsedWhen = parseWhen(payload);
      if (!parsedWhen) {
        await ctx.reply(
          `Не понял время: "${payload}".\n` +
            `Примеры: 1h, 30m, 2д3ч, "завтра в 9", "в пятницу 14:00", "10 апреля 18:00".`,
          { message_thread_id: threadId },
        );
        return true;
      }
      const fireAt = parsedWhen.fireAt;
      let userText = parsedWhen.rest;

      const now = Date.now();
      const ms = fireAt - now;
      if (ms <= 0) {
        await ctx.reply("Это время уже прошло. Укажи момент в будущем.", { message_thread_id: threadId });
        return true;
      }
      // Защита от случайного спама в очень далёком будущем
      const MAX_MS = 365 * 24 * 3_600_000;
      if (ms > MAX_MS) {
        await ctx.reply("Слишком далеко в будущем (>1 года). Сократи длительность.", { message_thread_id: threadId });
        return true;
      }

      // 4) Формируем итоговый текст напоминания.
      //    - Есть reply: ссылка + снiппет (первые 80 символов) + опц. текст.
      //    - Нет reply: просто userText, он обязателен.
      let text: string;
      if (replyTo) {
        const link = buildMessageLink(targetChatId, targetThreadId, replyTo.message_id);
        const original = ((replyTo as any).text || (replyTo as any).caption || "")
          .replace(/\s+/g, " ")
          .trim();
        const snippet = original.length > 80 ? original.slice(0, 77) + "..." : original;
        const quoted = snippet ? `«${snippet}»` : "(сообщение без текста)";
        text = userText
          ? `${userText}\n${link}\n${quoted}`
          : `Напомнить о: ${link}\n${quoted}`;
      } else {
        if (!userText) {
          await ctx.reply(
            "Текст напоминания не может быть пустым (или сделай reply на сообщение).",
            { message_thread_id: threadId },
          );
          return true;
        }
        text = userText;
      }

      const reminder: Reminder = {
        id: generateReminderId(),
        chatId: targetChatId,
        threadId: targetThreadId,
        text,
        fireAt,
        createdAt: now,
        createdBy: ctx.message!.from?.id ?? 0,
        runClaude: runClaude || undefined,
      };
      this.reminderStore.add(reminder);

      const lines = [
        runClaude
          ? `OK, через ${formatDuration(ms)} запущу Claude с этим текстом.`
          : `OK, напомню через ${formatDuration(ms)}.`,
        `Когда: ${formatFireAt(reminder.fireAt)}`,
        `id: ${reminder.id}`,
      ];
      if (replyTo) lines.push("(с ссылкой на reply-сообщение)");
      if (targetChatId !== chatId || (targetThreadId ?? null) !== (threadId ?? null)) {
        lines.push(`Куда: chat ${targetChatId}${targetThreadId ? `, thread ${targetThreadId}` : ""}`);
      }
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /reminders [all] — список напоминаний
    const remindersMatch = trimmed.match(/^\/reminders(?:@\w+)?(?:\s+(\w+))?$/);
    if (remindersMatch) {
      const scope = (remindersMatch[1] || "").toLowerCase();
      const all = scope === "all";
      const filter = all
        ? undefined
        : { chatId, threadId: (threadId ?? null) as number | null };
      const list = this.reminderStore.list(filter);
      if (list.length === 0) {
        await ctx.reply(
          all ? "Напоминаний нет." : "В этом топике напоминаний нет. /reminders all — показать все.",
          { message_thread_id: threadId },
        );
        return true;
      }
      const now = Date.now();
      // Telegram лимит на InlineKeyboard: не больше 100 кнопок и разумный
      // вес сообщения. Ограничим шапку списка 20 элементами, остальное
      // спрячем в хвост без кнопок. Для типового use-case (<10 напоминаний)
      // это никогда не триггерится.
      const WITH_BUTTONS = Math.min(list.length, 20);
      const lines = [`Напоминания (${list.length}):`];
      for (const r of list) {
        const left = formatDuration(r.fireAt - now);
        const where = all
          ? ` [chat ${r.chatId}${r.threadId ? `/thread ${r.threadId}` : ""}]`
          : "";
        const preview = r.text.length > 60 ? r.text.slice(0, 57) + "..." : r.text;
        lines.push(`• ${r.id} — через ${left}${where}\n  ${preview}`);
      }
      const kb = new InlineKeyboard();
      for (let i = 0; i < WITH_BUTTONS; i++) {
        const r = list[i];
        // callback_data <= 64 байт. id напоминания короткий (8-10 симв.), укладываемся.
        kb.text(r.id, `rem:rm:${r.id}`).danger().row();
      }
      if (list.length > WITH_BUTTONS) {
        lines.push(``);
        lines.push(`(показаны кнопки отмены для первых ${WITH_BUTTONS} — для остальных /unremind <id>)`);
      }
      await ctx.reply(lines.join("\n"), {
        message_thread_id: threadId,
        reply_markup: kb,
      } as any);
      return true;
    }

    // /unremind <id> — отменить напоминание
    const unremindMatch = trimmed.match(/^\/unremind(?:@\w+)?\s+(\S+)$/);
    if (unremindMatch) {
      const id = unremindMatch[1];
      const ok = this.reminderStore.remove(id);
      await ctx.reply(
        ok ? `Напоминание ${id} отменено.` : `Не нашёл напоминание с id ${id}.`,
        { message_thread_id: threadId },
      );
      return true;
    }

    // /loop <interval> <text> — register a recurring auto-trigger.
    // Examples:
    //   /loop 6h проверь все боты
    //   /loop 12h собери метрики и пришли отчёт
    //   /loop 5m мониторь webhook
    // Persisted in config/recurring.json. Fires via triggerTopicAuto.
    const loopMatch = trimmed.match(/^\/loop(?:@\w+)?(?:\s+(\S+)\s+(.+))?$/s);
    if (loopMatch) {
      const interval = loopMatch[1];
      const text = (loopMatch[2] || "").trim();
      if (!interval || !text) {
        await ctx.reply(
          [
            "Использование: /loop <interval> <text>",
            "",
            "Интервал: 5m, 30m, 1h, 6h, 12h, 1d, 7d (мин 1m, макс 30d).",
            "Текст — что Claude должен сделать на каждом запуске.",
            "",
            "/loops — список запущенных в этом топике",
            "/unloop <id> — снять",
          ].join("\n"),
          { message_thread_id: threadId },
        );
        return true;
      }
      const result = this.recurringStore.add({
        topicKey,
        interval,
        text,
        createdBy: ctx.from?.id,
      });
      if ("error" in result) {
        await ctx.reply(`Не получилось: ${result.error}`, { message_thread_id: threadId });
        return true;
      }
      const nextStr = new Date(result.nextRunAt).toLocaleString("ru-RU", { timeZone: "Europe/London" });
      await ctx.reply(
        [
          `/loop зарегистрирован: ${result.id}`,
          `Интервал: ${result.interval}`,
          `Первый запуск: ${nextStr} BST`,
          `Текст: ${text.length > 100 ? text.slice(0, 97) + "..." : text}`,
        ].join("\n"),
        { message_thread_id: threadId },
      );
      return true;
    }

    // /loops — list recurring tasks for current topic (or "all").
    const loopsMatch = trimmed.match(/^\/loops(?:@\w+)?(?:\s+(\w+))?$/);
    if (loopsMatch) {
      const scope = (loopsMatch[1] || "").toLowerCase();
      const all = scope === "all";
      const list: RecurringTask[] = all
        ? this.recurringStore.list()
        : this.recurringStore.list(topicKey);
      if (list.length === 0) {
        await ctx.reply(
          all ? "Активных /loop задач нет." : "В этом топике /loop задач нет. /loops all — все.",
          { message_thread_id: threadId },
        );
        return true;
      }
      const now = Date.now();
      const lines = [`/loop задач: ${list.length}`];
      for (const t of list) {
        const left = Math.max(0, t.nextRunAt - now);
        const min = Math.round(left / 60000);
        const where = all ? ` [${t.topicKey}]` : "";
        const preview = t.text.length > 60 ? t.text.slice(0, 57) + "..." : t.text;
        const ranTimes = t.runCount ? ` (запусков: ${t.runCount})` : "";
        lines.push(`• ${t.id} — каждые ${t.interval}, через ~${min}м${where}${ranTimes}\n  ${preview}`);
      }
      lines.push("");
      lines.push("/unloop <id> — снять задачу");
      await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
      return true;
    }

    // /unloop <id> — remove a recurring task by id.
    const unloopMatch = trimmed.match(/^\/unloop(?:@\w+)?\s+(\S+)$/);
    if (unloopMatch) {
      const id = unloopMatch[1];
      const ok = this.recurringStore.remove(id);
      await ctx.reply(
        ok ? `Задача ${id} снята.` : `Не нашёл /loop задачу с id ${id}.`,
        { message_thread_id: threadId },
      );
      return true;
    }

    // /provider [id] — показать или сменить провайдера топика (config/providers.json).
    // Без аргумента: текущий провайдер + кнопки. "default" снимает override.
    // Применяется со следующего spawn; идущая задача доработает как была.
    const providerMatch = trimmed.match(/^\/provider(?:@\w+)?(?:\s+(\S+))?$/);
    if (providerMatch) {
      const arg = providerMatch[1];
      if (!arg) {
        const { text, kb } = this.providerMenu(topicKey);
        await ctx.reply(text, { message_thread_id: threadId, reply_markup: kb } as any);
        return true;
      }
      await ctx.reply(this.applyProvider(topicKey, arg), { message_thread_id: threadId });
      return true;
    }

    // /model [alias] — показать или сменить Claude-модель для текущего топика.
    // Без аргумента: показать текущую эффективную модель и откуда она взята
    // (override в topics.json vs default из settings).
    // С алиасом из MODEL_ALIASES (fable|opus|sonnet):
    // записать override в topics.json.
    // С "default": снять override, вернуться к settings.processes.defaultModel.
    // Запущенный процесс НЕ убиваем — новая модель применится со следующего
    // spawn (как у /account). Для форс-применения — /kill, затем любое
    // сообщение.
    const modelMatch = trimmed.match(/^\/model(?:@\w+)?(?:\s+(\S+))?$/);
    if (modelMatch) {
      const arg = modelMatch[1];
      const mapping = this.topics.topics[topicKey];
      const defaultModel = this.settings.processes.defaultModel;

      if (!arg) {
        const override = mapping?.model;
        const effective = override || defaultModel;
        const source = override ? "override топика" : "default из settings";
        const lines: string[] = [];
        lines.push(`Модель: ${effective} (${source})`);
        const prov = this.topicProvider(mapping);
        if (prov.executor !== "claude") {
          lines.push(`Сейчас топик на провайдере ${prov.id} (${prov.model}); /model действует на Claude и применится после /provider claude.`);
        }
        lines.push(``);
        lines.push(`Нажми кнопку или напиши /model <alias>.`);
        lines.push(`Применится со следующего сообщения.`);

        const kb = new InlineKeyboard();
        let btnCount = 0;
        for (const a of MODEL_ALIASES) {
          if (btnCount > 0 && btnCount % 3 === 0) kb.row();
          // override явно задан и совпадает — активен (синяя кнопка)
          const isActive = override && a === override;
          kb.text(a, `model:${a}`);
          if (isActive) kb.primary();
          btnCount++;
        }
        // default активен, если override не задан (используется settings default)
        const defaultActive = !override;
        kb.row().text("default", "model:default");
        if (defaultActive) kb.success();
        await ctx.reply(lines.join("\n"), {
          message_thread_id: threadId,
          reply_markup: kb,
        } as any);
        return true;
      }

      if (!mapping) {
        await ctx.reply(
          "Топик не инициализирован — сначала напиши любое сообщение, чтобы он создался.",
          { message_thread_id: threadId },
        );
        return true;
      }

      if (arg === "default") {
        const prev = mapping.model;
        if (!prev) {
          await ctx.reply(
            `Override не задан. Используется default: ${defaultModel}.`,
            { message_thread_id: threadId },
          );
          return true;
        }
        delete mapping.model;
        this.topics.topics[topicKey] = mapping;
        saveTopics(this.topics);
        await ctx.reply(
          `Override снят (был: ${prev}). Теперь: ${defaultModel} (default). Применится со следующего сообщения.`,
          { message_thread_id: threadId },
        );
        return true;
      }

      if (!isValidModelAlias(arg)) {
        const list = MODEL_ALIASES.join(", ");
        await ctx.reply(
          `Неизвестный алиас "${arg}". Доступно: ${list}, default.`,
          { message_thread_id: threadId },
        );
        return true;
      }

      if (mapping.model === arg) {
        await ctx.reply(`Модель топика уже "${arg}".`, { message_thread_id: threadId });
        return true;
      }
      const prev = mapping.model || `default (${defaultModel})`;
      mapping.model = arg;
      this.topics.topics[topicKey] = mapping;
      saveTopics(this.topics);
      await ctx.reply(
        `Модель топика: ${prev} → ${arg}. Применится со следующего сообщения.`,
        { message_thread_id: threadId },
      );
      return true;
    }

    // /effort [level] — thinking effort для текущего топика (claude --effort).
    // Без аргумента: показать текущий уровень + кнопки.
    // low|medium|high|max: записать override в topics.json.
    // "default": снять override (флаг --effort не передаётся, CLI default = high).
    // Применяется со следующего spawn, как /model.
    const effortMatch = trimmed.match(/^\/effort(?:@\w+)?(?:\s+(\S+))?$/);
    if (effortMatch) {
      const arg = effortMatch[1];
      const mapping = this.topics.topics[topicKey];

      if (!arg) {
        const override = mapping?.effort;
        const effective = override || "high (default CLI)";
        const source = override ? "override топика" : "default";
        const lines: string[] = [];
        lines.push(`Effort: ${effective} (${source})`);
        lines.push(``);
        lines.push(`Уровень усилий размышления. Выше = тщательнее,`);
        lines.push(`но медленнее и дороже по лимитам (max ~1.5x+).`);
        lines.push(`Нажми кнопку или напиши /effort <level>.`);
        lines.push(`Применится со следующего сообщения.`);

        const kb = new InlineKeyboard();
        let btnCount = 0;
        for (const lv of EFFORT_LEVELS) {
          if (btnCount > 0 && btnCount % 4 === 0) kb.row();
          const isActive = override && lv === override;
          kb.text(lv, `effort:${lv}`);
          if (isActive) kb.primary();
          btnCount++;
        }
        const defaultActive = !override;
        kb.row().text("default", "effort:default");
        if (defaultActive) kb.success();
        await ctx.reply(lines.join("\n"), {
          message_thread_id: threadId,
          reply_markup: kb,
        } as any);
        return true;
      }

      if (!mapping) {
        await ctx.reply(
          "Топик не инициализирован — сначала напиши любое сообщение, чтобы он создался.",
          { message_thread_id: threadId },
        );
        return true;
      }

      if (arg === "default") {
        const prev = mapping.effort;
        if (!prev) {
          await ctx.reply(
            `Override не задан. Используется default CLI (high).`,
            { message_thread_id: threadId },
          );
          return true;
        }
        delete mapping.effort;
        this.topics.topics[topicKey] = mapping;
        saveTopics(this.topics);
        await ctx.reply(
          `Effort override снят (был: ${prev}). Теперь default CLI (high). Применится со следующего сообщения.`,
          { message_thread_id: threadId },
        );
        return true;
      }

      if (!isValidEffortLevel(arg)) {
        const list = EFFORT_LEVELS.join(", ");
        await ctx.reply(
          `Неизвестный уровень "${arg}". Доступно: ${list}, default.`,
          { message_thread_id: threadId },
        );
        return true;
      }

      if (mapping.effort === arg) {
        await ctx.reply(`Effort топика уже "${arg}".`, { message_thread_id: threadId });
        return true;
      }
      const prevEffort = mapping.effort || "default (high)";
      mapping.effort = arg;
      this.topics.topics[topicKey] = mapping;
      saveTopics(this.topics);
      await ctx.reply(
        `Effort топика: ${prevEffort} → ${arg}. Применится со следующего сообщения.`,
        { message_thread_id: threadId },
      );
      return true;
    }

    // /account [mode] -- режим авторизации Claude (accounts.json)
    // Без аргумента: показать текущий режим и список режимов.
    // С аргументом: переключить активный на указанный (если он есть в accounts.json).
    // Существующие процессы НЕ убиваются: они доработают на том OAuth,
    // под которым были зарождены. Новые spawn пойдут в новом режиме.
    const accountMatch = trimmed.match(/^\/account(?:@\w+)?(?:\s+(\S+))?$/);
    if (accountMatch) {
      const target = accountMatch[1];
      if (!target) {
        const list = this.accountManager.list();
        const activeName = this.accountManager.getActiveName();
        const lines: string[] = [];
        lines.push(`Режим авторизации Claude: ${activeName}`);
        lines.push(``);
        lines.push(`Режимы:`);
        for (const a of list) {
          const marker = a.active ? `[active] ` : ``;
          const ready = a.ready ? `` : ` (проблема: ${a.problem})`;
          const desc = a.description ? ` — ${a.description}` : ``;
          lines.push(`${marker}${a.name} [${a.type}]${desc}${ready}`);
        }
        lines.push(``);
        lines.push(`Нажмите кнопку, чтобы сменить режим.`);
        lines.push(`Идущие задачи доработают в прежнем режиме.`);

        // Inline keyboard: по 2 в ряд, активный слот — зелёная кнопка (.success())
        const kb = new InlineKeyboard();
        let col = 0;
        for (const a of list) {
          // callback_data ограничен 64 байтами, имена слотов короткие — ok
          kb.text(a.name, `account:${a.name}`);
          if (a.active) kb.success();
          col++;
          if (col % 2 === 0) kb.row();
        }
        await ctx.reply(lines.join("\n"), {
          message_thread_id: threadId,
          reply_markup: kb,
        } as any);
        return true;
      }
      if (!this.accountManager.has(target)) {
        const names = this.accountManager.listNames().join(", ");
        await ctx.reply(`Режим "${target}" не найден. Доступные: ${names}`, { message_thread_id: threadId });
        return true;
      }
      const prev = this.accountManager.getActiveName();
      if (prev === target) {
        await ctx.reply(`Режим уже "${target}".`, { message_thread_id: threadId });
        return true;
      }
      const ok = this.accountManager.setActive(target);
      if (!ok) {
        await ctx.reply(`Не получилось сменить режим.`, { message_thread_id: threadId });
        return true;
      }
      const info = this.accountManager.list().find(x => x.name === target);
      const warn = info && !info.ready ? `\nВнимание: ${info.problem}` : ``;
      await ctx.reply(`Режим авторизации: ${prev} → ${target}. Применится к новым задачам.${warn}`, { message_thread_id: threadId });
      return true;
    }

    return false;
  }

  /**
   * Read git branch / short commit / dirty-флаг один раз на старте.
   * Используется /version. Ошибки неблокирующие: если git молчит,
   * /version просто отдаст "недоступно".
   */
  private loadVersionInfo(): void {
    try {
      const { execSync } = require("child_process") as typeof import("child_process");
      const opts = {
        cwd: ROUTER_ROOT,
        encoding: "utf8" as const,
        timeout: 3000,
        windowsHide: true,
      };
      const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
      const commit = execSync("git rev-parse --short HEAD", opts).trim();
      const status = execSync("git status --porcelain", opts).trim();
      this.versionInfo = { branch, commit, dirty: status.length > 0 };
      console.log(`[Router] Version: ${branch}@${commit}${status ? " [dirty]" : ""}`);
    } catch (err) {
      console.warn(`[Router] Failed to load version info: ${(err as Error).message}`);
      this.versionInfo = null;
    }
  }

  /**
   * Полный плоский список команд. Отдаётся по /help all и по кнопке
   * "Все команды".
   */
  private buildHelpAll(): string {
    return [
      "Все команды",
      "",
      "Контроль",
      "  /pause [причина] — приостановить бота (игнорит сообщения)",
      "  /resume — снять паузу",
      "  /killall — убить все Claude-процессы",
      "  /cancel — отменить процесс в текущем топике",
      "  /kill — алиас /cancel",
      "  /quiet <мин> — замьютить топик на N минут",
      "  /reset — сбросить сессию топика",
      "",
      "Информация",
      "  /status — активные процессы + настройки",
      "  /topics — список всех живых процессов",
      "  /alive — что делает текущий процесс",
      "  /uptime — время работы роутера",
      "  /version — ветка + коммит",
      "  /whoami — моё id + аккаунт",
      "  /project — путь к проекту топика",
      "  /runner — статус sidecar-демона",
      "  /logs [N] — последние N строк лога",
      "",
      "Память",
      "  /memory — статистика памяти топика",
      "  /compact — принудительная компрессия",
      "  /rules — правила оформления в TG (templates/TG-RULES.md)",
      "",
      "Напоминания",
      "  /remind <когда> [текст] — создать",
      "  /reminders [all] — список (с кнопками отмены)",
      "  /unremind <id> — отменить",
      "",
      "Настройки",
      "  /account [режим] — режим авторизации Claude (без аргумента — кнопки)",
      "  /provider [id] — провайдер и исполнитель топика (без аргумента — кнопки)",
      "  /model [alias] — модель Claude (без аргумента — кнопки)",
      "  /effort [level] — thinking effort: low|medium|high|max (без аргумента — кнопки)",
      "  /ttl [N] — TTL в минутах (без аргумента — кнопки)",
      "  /name <имя> — переименовать топик",
    ].join("\n");
  }

  /**
   * Раздельные разделы help — показываются по нажатию inline-кнопок.
   * Вызывается из callback_query handler.
   */
  private buildHelpSection(section: string): string {
    if (section === "control") {
      return [
        "Контроль",
        "",
        "/pause [причина] — пауза (бот игнорит сообщения)",
        "/resume — снять паузу",
        "/killall — убить все Claude-процессы",
        "/cancel — отменить процесс в топике",
        "/kill — алиас /cancel",
        "/quiet <мин> — замьютить топик на N минут",
        "/reset — сбросить сессию",
      ].join("\n");
    }
    if (section === "memory") {
      return [
        "Память",
        "",
        "/memory — статистика памяти топика",
        "/compact — принудительная компрессия",
        "/rules — правила оформления в TG (из templates/TG-RULES.md)",
      ].join("\n");
    }
    if (section === "reminders") {
      return [
        "Напоминания",
        "",
        "/remind <когда> [текст] — создать",
        "  Форматы: 1h, 30m, 2d, завтра в 9, в пятницу 14:00",
        "/reminders [all] — список с кнопками отмены",
        "/unremind <id> — отменить вручную",
      ].join("\n");
    }
    if (section === "settings") {
      return [
        "Настройки",
        "",
        "/account [режим] — режим авторизации Claude",
        "/provider [id] — провайдер топика (config/providers.json)",
        "/model [alias] — модель Claude топика",
        "/effort [level] — thinking effort топика (low|medium|high|max)",
        "/ttl [N] — TTL в минутах",
        "/name <имя> — переименовать топик",
        "/mode [active|mention-only] — режим группы",
      ].join("\n");
    }
    return this.buildHelpAll();
  }

  /**
   * Регистрирует команды в Telegram UI (всплывающий список под "/" в клиенте).
   *
   * Telegram кэширует команды на клиенте агрессивно — если ничего не меняется,
   * повторный вызов setMyCommands не вредит. Важно: не падаем, если API вернул
   * ошибку — это не критично для работы бота.
   */
  private async setupBotCommands(): Promise<void> {
    const commands = [
      { command: "help", description: "Справка (разделы кнопками)" },
      { command: "status", description: "Активные процессы + настройки" },
      { command: "model", description: "Модель Claude (без arg — кнопки)" },
      { command: "effort", description: "Thinking effort (без arg — кнопки)" },
      { command: "account", description: "Режим авторизации Claude" },
      { command: "provider", description: "Провайдер топика (без arg — кнопки)" },
      { command: "topics", description: "Список живых процессов" },
      { command: "alive", description: "Что делает текущий процесс" },
      { command: "cancel", description: "Отменить процесс топика" },
      { command: "killall", description: "Убить все процессы" },
      { command: "pause", description: "Пауза бота" },
      { command: "resume", description: "Снять паузу" },
      { command: "quiet", description: "Замьютить топик на N минут" },
      { command: "reset", description: "Сбросить сессию топика" },
      { command: "memory", description: "Статистика памяти топика" },
      { command: "compact", description: "Компрессия контекста" },
      { command: "rules", description: "Правила оформления в TG" },
      { command: "remind", description: "Создать напоминание" },
      { command: "reminders", description: "Список напоминаний" },
      { command: "unremind", description: "Отменить напоминание" },
      { command: "loop", description: "Повторяющаяся задача: /loop 6h <text>" },
      { command: "loops", description: "Список /loop задач топика (или all)" },
      { command: "unloop", description: "Снять /loop задачу" },
      { command: "ttl", description: "TTL в минутах (без arg — кнопки)" },
      { command: "name", description: "Переименовать топик" },
      { command: "mode", description: "Режим группы (active|mention-only)" },
      { command: "uptime", description: "Аптайм роутера" },
      { command: "version", description: "Ветка + коммит" },
      { command: "whoami", description: "Моё id + аккаунт" },
      { command: "project", description: "Путь к проекту топика" },
      { command: "runner", description: "Статус sidecar-демона" },
      { command: "logs", description: "Последние строки лога" },
    ];
    try {
      await this.bot.api.setMyCommands(commands);
      // Явный scope для личных чатов — на случай если default scope
      // перезапишется где-то ещё.
      await this.bot.api.setMyCommands(commands, {
        scope: { type: "all_private_chats" },
      } as any);
      console.log(`[Router] Registered ${commands.length} bot commands in Telegram UI`);
    } catch (err) {
      console.warn(`[Router] setMyCommands failed: ${(err as Error).message}`);
    }
  }

  /**
   * Обработчик callback_query — нажатия на inline-кнопки.
   * Формат data: "<namespace>:<arg1>[:<arg2>...]".
   *   help:<section>     — показать раздел справки
   *   account:<name>     — переключить активный OAuth-слот
   *   model:<alias>      — поменять модель топика (sonnet/opus/default)
   *   ttl:<minutes>      — установить TTL
   *   rem:rm:<id>        — удалить напоминание
   *
   * Авторизация — тот же allowedUsers из settings (иначе чужой может
   * угадать callback_data и пошатать настройки).
   */
  private registerCallbackHandlers(): void {
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data || "";
      const senderId = ctx.from?.id ?? 0;
      if (!this.settings.telegram.allowedUsers.includes(senderId)) {
        try { await ctx.answerCallbackQuery({ text: "Нет доступа" }); } catch {}
        return;
      }

      const chatId = ctx.chat?.id.toString() || "";
      const threadId = ctx.callbackQuery.message?.message_thread_id;
      const topicKey = this.buildTopicKey(chatId, threadId);

      try {
        const [ns, ...rest] = data.split(":");

        // --- /help разделы ---
        if (ns === "help") {
          const section = rest[0] || "all";
          const text = this.buildHelpSection(section);
          const kb = new InlineKeyboard()
            .text("Контроль", "help:control").primary()
            .text("Память", "help:memory").primary().row()
            .text("Напоминания", "help:reminders").primary()
            .text("Настройки", "help:settings").primary().row()
            .text("Все команды", "help:all").success();
          try {
            await ctx.editMessageText(text, { reply_markup: kb } as any);
          } catch {
            // Если сообщение не редактируется (слишком старое / удалено) —
            // отправим новое.
            await ctx.reply(text, { message_thread_id: threadId, reply_markup: kb } as any);
          }
          await ctx.answerCallbackQuery();
          return;
        }

        // --- /account переключение ---
        if (ns === "account") {
          const target = rest[0];
          if (!target || !this.accountManager.has(target)) {
            await ctx.answerCallbackQuery({ text: "Режим не найден" });
            return;
          }
          const prev = this.accountManager.getActiveName();
          if (prev === target) {
            await ctx.answerCallbackQuery({ text: `Уже активен: ${target}` });
            return;
          }
          this.accountManager.setActive(target);
          await ctx.answerCallbackQuery({ text: `Активный: ${target}` });
          try {
            await ctx.editMessageText(
              `Режим авторизации: ${prev} → ${target}. ` +
              `Новые spawn пойдут под ним.`,
            );
          } catch { /* старое сообщение — пофиг */ }
          return;
        }

        // --- /provider переключение ---
        if (ns === "provider") {
          const target = rest.join(":");
          const text = this.applyProvider(topicKey, target);
          await ctx.answerCallbackQuery({ text: text.split("\n")[0].slice(0, 190) });
          try { await ctx.editMessageText(text); } catch { /* старое сообщение */ }
          return;
        }

        // --- /model переключение ---
        if (ns === "model") {
          const target = rest[0];
          const mapping = this.topics.topics[topicKey];
          if (!mapping) {
            await ctx.answerCallbackQuery({ text: "Топик не инициализирован" });
            return;
          }
          const defaultModel = this.settings.processes.defaultModel;
          if (target === "default") {
            const prev = mapping.model;
            if (!prev) {
              await ctx.answerCallbackQuery({ text: `Уже default (${defaultModel})` });
              return;
            }
            delete mapping.model;
            saveTopics(this.topics);
            await ctx.answerCallbackQuery({ text: `Сброшено → default` });
            try {
              await ctx.editMessageText(
                `Модель топика: ${prev} → default (${defaultModel}). ` +
                `Применится со следующего сообщения.`,
              );
            } catch {}
            return;
          }
          if (!target || !isValidModelAlias(target)) {
            await ctx.answerCallbackQuery({ text: "Неизвестный alias" });
            return;
          }
          if (mapping.model === target) {
            await ctx.answerCallbackQuery({ text: `Уже: ${target}` });
            return;
          }
          const prev = mapping.model || `default (${defaultModel})`;
          mapping.model = target;
          saveTopics(this.topics);
          await ctx.answerCallbackQuery({ text: `${prev} → ${target}` });
          try {
            await ctx.editMessageText(
              `Модель топика: ${prev} → ${target}. ` +
              `Применится со следующего сообщения.`,
            );
          } catch {}
          return;
        }

        // --- /effort переключение ---
        if (ns === "effort") {
          const target = rest[0];
          const mapping = this.topics.topics[topicKey];
          if (!mapping) {
            await ctx.answerCallbackQuery({ text: "Топик не инициализирован" });
            return;
          }
          if (target === "default") {
            const prev = mapping.effort;
            if (!prev) {
              await ctx.answerCallbackQuery({ text: "Уже default (high)" });
              return;
            }
            delete mapping.effort;
            saveTopics(this.topics);
            await ctx.answerCallbackQuery({ text: "Сброшено → default" });
            try {
              await ctx.editMessageText(
                `Effort топика: ${prev} → default (high). ` +
                `Применится со следующего сообщения.`,
              );
            } catch {}
            return;
          }
          if (!target || !isValidEffortLevel(target)) {
            await ctx.answerCallbackQuery({ text: "Неизвестный уровень" });
            return;
          }
          if (mapping.effort === target) {
            await ctx.answerCallbackQuery({ text: `Уже: ${target}` });
            return;
          }
          const prev = mapping.effort || "default (high)";
          mapping.effort = target;
          saveTopics(this.topics);
          await ctx.answerCallbackQuery({ text: `${prev} → ${target}` });
          try {
            await ctx.editMessageText(
              `Effort топика: ${prev} → ${target}. ` +
              `Применится со следующего сообщения.`,
            );
          } catch {}
          return;
        }

        // --- /ttl пресеты ---
        if (ns === "ttl") {
          const n = parseInt(rest[0] || "0", 10);
          if (!Number.isFinite(n) || n < 1 || n > 1440) {
            await ctx.answerCallbackQuery({ text: "Неверное значение" });
            return;
          }
          this.settings.processes.ttlMinutes = n;
          this.saveSettings();
          await ctx.answerCallbackQuery({ text: `TTL: ${n} мин` });
          try { await ctx.editMessageText(`TTL установлен: ${n} мин.`); } catch {}
          return;
        }

        // --- /reminders удаление ---
        if (ns === "rem" && rest[0] === "rm") {
          const id = rest[1];
          if (!id) {
            await ctx.answerCallbackQuery({ text: "Нет id" });
            return;
          }
          const ok = this.reminderStore.remove(id);
          await ctx.answerCallbackQuery({
            text: ok ? `Отменено ${id}` : `Не нашёл ${id}`,
          });
          return;
        }

        await ctx.answerCallbackQuery({ text: "Неизвестная кнопка" });
      } catch (err) {
        console.error("[Router] callback_query error:", err);
        try { await ctx.answerCallbackQuery({ text: "Ошибка" }); } catch {}
      }
    });
  }

  /**
   * Persist current settings to disk.
   */
  private saveSettings(): void {
    const { writeFileSync } = require("fs");
    const { resolve } = require("path");
    const ROOT = resolve(__dirname, "..");
    const path = resolve(ROOT, "config/settings.json");
    writeFileSync(path, JSON.stringify(this.settings, null, 2), "utf-8");
    console.log("[Router] Settings saved");
  }

  private shutdown(): void {
    console.log("[Router] Shutting down...");
    if (this.healthServer) {
      try { this.healthServer.stop(true); } catch {}
    }
    this.memoryManager.stop();
    this.reminderScheduler.stop();
    this.recurringScheduler.stop();
    this.processManager.shutdown();
    if (this.runnerHandle) {
      this.runnerHandle.stop();
    } else {
      this.bot.stop();
    }
    process.exit(0);
  }
}
