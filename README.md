<h1 align="center">TeleClaude</h1>

<p align="center">
  <strong>A Telegram forum where every topic is its own Claude Code agent.</strong><br>
  Isolated sessions, persistent memory, a crash-proof runner and an autonomous Director. Everything runs on your own machine.
</p>

<p align="center">
  <a href="README.ru.md">Русская версия</a> ·
  <a href="LICENSE">MIT License</a> ·
  Runtime: Bun · Platform: Windows-first
</p>

---

TeleClaude turns a Telegram supergroup with topics (forum mode) into a multi-project workspace for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Each topic maps to its own project directory and its own Claude Code session. You write or dictate into a topic, and a `claude -p` process starts in that project with its memory and rules loaded. It works with files, the shell, the browser and MCP servers, then replies in the same topic.

You own the data. Project memory, checkpoints, rules, session history and browser profiles are plain files on your disk. The model is a replaceable part: changing the provider or the authentication mode is one setting, and work continues from the same `CHECKPOINT.md`. See [Terms of use](#terms-of-use) for how to authenticate.

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Bot commands](#bot-commands)
- [Director](#director)
- [Cross-topic work, reminders and loops](#cross-topic-work-reminders-and-loops)
- [Browser pool](#browser-pool)
- [Media: voice, video, photos, documents](#media-voice-video-photos-documents)
- [Running as Windows services](#running-as-windows-services)
- [Security](#security)
- [Terms of use](#terms-of-use)
- [Roadmap](#roadmap)
- [License](#license)

## How it works

```
Telegram supergroup (forum mode)
|
+-- Topic "Backend API"   -> claude -p --resume <id>  (cwd: ~/Projects/backend-api/)
+-- Topic "Landing page"  -> claude -p --resume <id>  (cwd: ~/Projects/landing-page/)
+-- Topic "DevOps"        -> claude -p --resume <id>  (cwd: ~/Projects/devops/)
+-- New topic             -> project directory is created from templates/
```

One topic is one isolated session:

- **Own working directory.** A new topic gets a project folder created from `templates/` (`CLAUDE.md`, `SOUL.md`, `VISION.md`, `topic-memory.md`, a link or copy of `main-memory.md`).
- **Real session continuity.** The router stores the real Claude Code session id (UUID) per topic in `config/topics.json` and passes it as `--resume <session-id>`. It never uses `--continue`, so sessions from different topics cannot mix.
- **Per-topic mutex.** Messages inside one topic run strictly in order, so two `--resume` calls never hit the same session at once. Different topics run in parallel, up to `processes.maxConcurrent`.
- **Memory injection on every spawn.** `--append-system-prompt` is not persisted across `--resume`, so the router rebuilds it on every call: `VISION.md`, `SOUL.md`, `topic-memory.md`, `main-memory.md` and optional `contextFiles` from the shared memory directory. The block is capped at about 6.5K characters to stay within Windows command-line limits.
- **Checkpoint discipline.** The injected rules tell the agent to keep `CHECKPOINT.md` in the project root (`STATUS`, `TASK`, `LAST_ACTION`, `NEXT`, `DO_NOT_REDO`, `VERIFY_BEFORE_ACT`) and to read it first after context compaction. That file is also what Director reads.

## Features

| Area | What you get |
|------|--------------|
| Topic routing | One topic = one project directory and one Claude Code session with `--resume` |
| Memory | `VISION.md` + `SOUL.md` + `topic-memory.md` + `main-memory.md` injected on every spawn, plus a shared long-term memory directory |
| Runner sidecar | A separate process owns the `claude` spawns, so restarting the router does not kill running jobs |
| Director | Periodic scan of every topic's `CHECKPOINT.md`, registry and dashboard JSON, auto-trigger of stale topics with cooldowns, plan-execute-verify mode, dependencies, morning summary |
| Cross-topic delegation | `trigger_topic` MCP tool: an agent in one topic can hand work to another topic |
| Authentication | `/account` modes: `apikey` (recommended), or your own Claude Code login (`default`, `token`, `configDir`). Change provider or auth mode without a restart |
| Models | `/model` and `/effort` per topic; every reply carries a model tag such as `[opus-5.5]` |
| Scheduling | `/loop` recurring tasks, `/remind` reminders, `reminder-mcp` so the agent can schedule its own follow-ups |
| Browser pool | Per-topic browser context via a broker, plus dedicated Chrome profiles for selected topics |
| Media | Voice and audio via local Whisper, video (audio transcript + ffmpeg frames), photos, documents |
| Knowledge base hook | Optional, off by default. When enabled, sends the text of every message to your own knowledge base endpoint |
| Realtime extractor | Optional, off by default. When `GEMINI_API_KEY` is set, sends message text to the Google Gemini API and saves extracted facts into memory |
| Output | Per-block streaming to Telegram, fence-aware splitting of long messages, heartbeat status for long tool runs |
| Operations | Single-instance lock, `/health` endpoint, optional webhook mode, recovery of orphaned "thinking..." messages after a crash |

## Architecture

```
                 +----------------------+
                 |  Telegram Bot API    |
                 +----------+-----------+
                            | long-poll, or webhook (/webhook + secret token)
+---------------------------v-----------------------------------------------+
| Router (Bun + grammY)                                 HTTP 127.0.0.1:7885 |
|  - allowedUsers gate, group modes (active / mention-only)                 |
|  - topic -> project mapping (config/topics.json)                          |
|  - system prompt builder: VISION + SOUL + topic-memory + main-memory      |
|  - commands: /model /effort /account /loop /remind /vision ...            |
|  - media: Whisper, ffmpeg frames, photo/document download                 |
|  - Director (tick every 15 min, 0 tokens) + morning summary               |
|  - /internal/trigger  <-- mcp-router (trigger_topic)                      |
|  - reminders.json     <-- mcp-reminder (schedule_reminder)                |
|  - optional, off by default: KB hook, Gemini extractor, dashboard sync    |
+---------------------------+-----------------------------------------------+
                            | HTTP + SSE (localhost)
+---------------------------v-----------------------------------------------+
| Runner sidecar (runner/, default :7878)                                   |
|  - owns claude processes, spawned detached with file-based stdio          |
|  - job state on disk, SSE with Last-Event-ID, survives router restarts    |
|  - idle watchdog, maxConcurrent limit                                     |
+---------------------------+-----------------------------------------------+
                            | claude -p --resume <id> --model <slug> --effort <level>
                            |          --append-system-prompt <memory> --mcp-config <file>
+---------------------------v-----------------------------------------------+
| Claude Code CLI, one process per active topic, cwd = project directory    |
|  MCP: router-mcp, reminder-mcp, playwright (per-topic via browser pool)   |
+---------------------------------------------------------------------------+
```

If `runner.enabled` is `false`, the router spawns `claude` directly. This is simpler, but a router restart then kills running jobs.

## Requirements

- Windows 10/11. The code and scripts are Windows-first: PowerShell helpers, `taskkill`, `curl.exe`, NSSM services, Scheduled Tasks. Other platforms are not tested.
- [Bun](https://github.com/oven-sh/bun), a recent 1.x release.
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), a recent version with `--effort` support, configured with an Anthropic API key (recommended) or signed in with your own Claude account for personal use. See [Terms of use](#terms-of-use).
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and a supergroup with topics enabled. Add the bot as an administrator.
- Optional: Node.js (for the browser pool), Chrome, Docker with [whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice) on `localhost:9000`, ffmpeg in `PATH`.

TeleClaude does not need an Anthropic API key by default. It starts Claude Code with your existing login, the same way you use it in a terminal.

## Quick start

**1. Install**

```bash
git clone https://github.com/devladpopov/teleclaude.git
cd teleclaude
bun install
cd runner && bun install && cd ..
```

**2. Configure**

```bash
cp .env.example .env                                   # TELEGRAM_BOT_TOKEN
cp config/settings.example.json config/settings.json   # allowedUsers, projectsRoot
cp config/topics.example.json   config/topics.json     # filled in by the bot
cp config/accounts.example.json config/accounts.json   # optional, authentication modes
cp templates/SOUL.example.md        templates/SOUL.md
cp templates/main-memory.example.md templates/main-memory.md
```

Put your Telegram user id into `telegram.allowedUsers` and an absolute folder into `projectsRoot`. Edit `SOUL.md` (personality and rules) and `main-memory.md` (facts shared by all topics). `templates/TG-RULES.md` is a short generic template of Telegram formatting rules (style, absolute file paths, tables, text for copying). The bot shows it on `/rules`, and a condensed version is built into every system prompt; adjust it to taste.

**3. Start the runner and the router** (two terminals)

```bash
cd runner && bun run src/index.ts     # sidecar, needs "runner": { "enabled": true }
bun run start                         # router
```

**4. Talk to it.** Add the bot to the supergroup and write in any topic. The router creates a project directory for the topic and replies there. New groups are registered in `mention-only` mode; switch a group to `active` with `/mode active`.

## Configuration

All runtime files in `config/*.json` (settings, topics, accounts, `kb.local.json`, `director-topics.json`, `browser-dedicated.json`, reminders, recurring tasks, Director state) are gitignored. Only the `*.example.json` files are committed.

### config/settings.json

| Key | Description | Default |
|-----|-------------|---------|
| `telegram.allowedUsers` | Telegram user ids the bot obeys. Everyone else is ignored | `[]` |
| `processes.claudePath` | Path to the Claude Code CLI | `claude` |
| `processes.defaultFlags` | Extra flags for every spawn | `["--dangerously-skip-permissions"]` |
| `processes.defaultModel` | Model alias when a topic has no override | none |
| `processes.maxConcurrent` | Parallel Claude processes | `5` |
| `processes.ttlMinutes` | Idle time before a topic's process state is cleaned up | `30` |
| `processes.idleTimeoutMinutes` | Kill a spawn that emits no stream events for N minutes | optional |
| `processes.heartbeatAfterSeconds` / `heartbeatIntervalSeconds` | Status message edits with the current tool during long silent runs | optional |
| `runner.enabled` / `runner.port` | Use the runner sidecar | `false` / `7878` |
| `browserPool.enabled` / `brokerUrl` | Per-topic browsers through the broker | `false` / `http://127.0.0.1:8930` |
| `compaction.enabled` | Ask the agent to fold context into `topic-memory.md` after about 15 messages or 30K characters | `true` |
| `memory.enabled` / `deduplication` / `revisionIntervalMinutes` | Periodic cleanup and dedup of memory files | `true` / `true` / `60` |
| `whisper.enabled` / `url` / `language` | Voice transcription | `false` / `http://localhost:9000/asr` / `ru` |
| `whisper.autoStart` / `containerName` | Start the Whisper Docker container on demand via `scripts/ensure-whisper.ps1` | `true` / auto-detect |
| `projectsRoot` | Root folder for topic projects | required |
| `templatesDir` | Templates for new projects | `./templates` |

`runtime.paused` is written by `/pause` and `/resume`, so a pause survives restarts.

### config/topics.json

Filled in by the bot. Keys are `chatId:threadId` (`chatId:general` for the General topic):

```json
{
  "groups": {
    "-1001234567890": { "name": "My workspace", "enabled": true, "mode": "active" }
  },
  "topics": {
    "-1001234567890:42": {
      "name": "Backend API",
      "project": "C:/path/to/Projects/backend-api",
      "sessionId": "3f2c1a9e-0000-4000-8000-000000000000",
      "model": "sonnet",
      "effort": "high",
      "memory": ["VISION.md", "SOUL.md", "main-memory.md", "topic-memory.md"],
      "contextFiles": ["services/servers.md"],
      "created": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

`contextFiles` are paths relative to the shared memory directory (`TELECLAUDE_MEMORY_DIR`) that get injected into this topic's prompt.

### config/accounts.json

Authentication modes for `/account`. The active mode is applied to every new spawn; running processes finish with the previous one. Use only your own credentials, see [Terms of use](#terms-of-use).

```json
{
  "active": "api",
  "accounts": {
    "api":      { "type": "apikey",  "keyFile": "C:/path/to/secrets/anthropic.key" },
    "personal": { "type": "default", "description": "my own Claude Code login on this machine" }
  }
}
```

| Type | What the router sets for the spawn |
|------|------------------------------------|
| `default` | Nothing. The CLI uses its own login |
| `token` | `CLAUDE_CODE_OAUTH_TOKEN` from `tokenFile`: your own long-lived token from `claude setup-token`, for your personal use only |
| `configDir` | `CLAUDE_CONFIG_DIR`, a separate CLI config directory with its own credentials |
| `apikey` | `ANTHROPIC_API_KEY` from `keyFile`. For all other types this variable is removed from the child environment |

The mode exists so you can move between providers and authentication methods, for example from a personal login to an API key, without losing anything: the session id, memory and checkpoints live on disk, so the topic keeps its history. When the provider returns a rate limit, the router detects it and Director pauses auto-triggers until the window resets. There is no switching to other accounts to get around limits, and there will not be.

### config/director-topics.json (optional)

Classifies topics by name for Director. `ignored` topics are not scanned. `communication` topics are not auto-triggered at night. `operations` topics are shown as infrastructure work.

```json
{
  "ignored": ["Sandbox"],
  "communication": ["Outreach", "Help desk"],
  "operations": ["Servers", "Monitoring"]
}
```

### config/kb.local.json (optional)

The knowledge base hook is optional and off by default: it stays disabled while this file does not exist. When you enable it, **the text of every incoming message is sent to an external service**, the endpoint you configure (your own knowledge base). Each message goes out fire-and-forget as `POST {baseUrl}/api/ingest` with a bearer token. Failures are logged and never block the chat. Any service that accepts this payload works (`msg_id`, `chat_id`, `thread_id`, `sender`, `date`, `text`, `msg_type`).

```json
{ "baseUrl": "http://127.0.0.1:8400", "token": "change-me" }
```

### Realtime extractor (optional)

The realtime extractor is optional and off by default. It is created only when `GEMINI_API_KEY` is set. When enabled, **message text is sent to the Google Gemini API**, which decides whether a message contains a fact, decision, contact or deadline worth keeping. Extracted facts are written into `topic-memory.md` or the shared memory directory. It runs in the background with a per-topic cooldown and never blocks the chat. Leave `GEMINI_API_KEY` unset if your messages must not leave your machine.

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | yes | Bot token. Read from `.env` or the process environment |
| `GEMINI_API_KEY` | no | Enables the optional realtime extractor (off by default). When set, message text is sent to the Google Gemini API |
| `DIRECTOR_ALLOWED_CHATS` | no | Comma-separated chat ids where Director may auto-trigger topics. Other chats are read-only on the dashboard |
| `DIRECTOR_SUMMARY_TOPIC` | no | `chatId:threadId` for the morning summary, for example `-1001234567890:42` |
| `DASHBOARD_SYNC_REMOTE` | no | `user@host` for uploading the Director dashboard JSON to static hosting over SSH. Upload is disabled when unset |
| `DASHBOARD_SYNC_SSH_KEY` | no | SSH private key path for that upload. Default `~/.ssh/id_ed25519` |
| `DASHBOARD_SYNC_DIR` | no | Remote directory for the dashboard files. Default `~/public_html/hub/` |
| `DASHBOARD_SYNC_DISABLED` | no | Set to `1` to turn the upload off |
| `GIT_BASH_PATH` | no | `bash.exe` used to run the `cat \| ssh` upload pipeline. Defaults to the standard Git for Windows path |
| `TELECLAUDE_MEMORY_DIR` | no | Shared long-term memory directory. Default `~/.teleclaude/memory` |
| `TELECLAUDE_MCP_CONFIG` | no | Static MCP config passed to every spawn. Default `~/.claude/spawn-mcp-config.json` |
| `ROUTER_WEBHOOK_URL` / `ROUTER_WEBHOOK_SECRET` | no | Webhook mode instead of long-polling. The secret is checked on every request |
| `ROUTER_HEALTH_PORT` | no | Router HTTP port (`/health`, `/webhook`, `/internal/trigger`). Default `7885` |
| `ROUTER_BIND_HOST` | no | Interface the router HTTP server binds to. Default `127.0.0.1` |
| `ROUTER_INTERNAL_SECRET` | no | Shared secret for `/internal/trigger`. When set, requests must carry it in the `x-router-internal-secret` header. `mcp-router` sends it automatically when the same variable is in its environment (spawns inherit the router environment) |
| `CLAUDE_RUNNER_PORT` / `CLAUDE_RUNNER_MAX_CONCURRENT` | no | Runner port and concurrency. Defaults `7878` and `15` |
| `CLAUDE_RUNNER_HOST` | no | Interface the runner binds to. Default `127.0.0.1` |
| `BROWSER_POOL_PROFILE_ROOT` | no | Browser pool profile directory. Default `~/.teleclaude/browser-pool` |
| `BROWSER_POOL_DEDICATED` | no | Map of topics to dedicated Chrome profiles. Default `config/browser-dedicated.json` |
| `BOT_BROWSER_PROFILE` | no | Profile of the shared, logged-in bot Chrome started by `scripts/playwright-mcp-daemon.ps1`. Default `~/.teleclaude/browser-profile` |

### MCP servers for spawned sessions

In print mode, `claude -p` does not load your global MCP servers. The router passes one file with `--mcp-config` (`TELECLAUDE_MCP_CONFIG`). Register the bundled servers there:

```json
{
  "mcpServers": {
    "router-mcp":   { "command": "bun", "args": ["run", "C:/path/to/teleclaude/mcp-router/server.ts"] },
    "reminder-mcp": { "command": "bun", "args": ["run", "C:/path/to/teleclaude/mcp-reminder/server.ts"] },
    "playwright":   { "type": "http", "url": "http://127.0.0.1:8931/mcp" }
  }
}
```

The router injects `TOPIC_CHAT_ID`, `TOPIC_THREAD_ID` and `REMINDERS_JSON_PATH` into each spawn, so these servers know which topic they serve.

## Bot commands

| Command | Description |
|---------|-------------|
| `/help` | Command reference with section buttons |
| `/status`, `/topics`, `/alive` | Active processes, settings, what the current process is doing |
| `/model [alias]` | Model for this topic (buttons without an argument, `default` removes the override) |
| `/effort [low\|medium\|high\|max]` | Thinking effort for this topic (`claude --effort`) |
| `/account [mode]` | Active authentication mode or provider |
| `/cancel`, `/kill`, `/killall` | Stop this topic's process, or all of them |
| `/reset` | Start a new session in this topic. Memory files stay |
| `/compact`, `/memory` | Force context compaction, show memory stats |
| `/vision [text \| --append text]` | Show or edit the topic goal in `VISION.md` |
| `/loop <interval> <text>`, `/loops [all]`, `/unloop <id>` | Recurring tasks |
| `/remind <when> [text]`, `/reminders [all]`, `/unremind <id>` | Reminders (`1h`, `30m`, `tomorrow at 9`, ISO dates) |
| `/priority high\|normal\|low`, `/archive`, `/unarchive` | Director controls for this topic |
| `/pause [reason]`, `/resume`, `/quiet <min>` | Pause the bot, mute a topic |
| `/name <name>`, `/mode active\|mention-only`, `/ttl [N]` | Rename a topic, set group mode, set TTL |
| `/rules`, `/project`, `/whoami`, `/uptime`, `/version`, `/runner`, `/logs [N]` | Info and diagnostics |

**Model tag.** The system prompt tells the agent its exact model slug and asks it to start every reply with a tag such as `[opus-5.5]`. Long resumed sessions sometimes lose that rule, so the router adds the tag itself when a reply does not start with `[` (`ensureModelPrefix`). Aliases map to exact slugs in `MODEL_SLUGS` in `src/config.ts`; update that map when a new model is released.

## Director

Director is a module inside the router (`src/director.ts`). It needs no LLM calls. Every 15 minutes it:

1. Reads `CHECKPOINT.md` from every mapped project and parses status, progress, subtasks and `NEXT`.
2. Writes `config/director-registry.json` and `config/director-dashboard.json`, plus an activity log in `director-events.json`. Optionally it uploads them to static hosting over SSH (`src/dashboard-sync.ts`, `DASHBOARD_SYNC_*` variables).
3. Picks stale `IN_PROGRESS` topics and auto-triggers them: a short notice in the topic, then a normal spawn with "continue from `NEXT`".

Guards against runaway loops:

- only chats listed in `DIRECTOR_ALLOWED_CHATS`;
- a per-tick trigger cap, a 2-hour base cooldown (30 minutes for `PRIORITY: high`), adaptive doubling when a trigger produced no progress (up to 24 hours), and a daily budget per topic;
- a consecutive-trigger cap that resets when a human writes in the topic;
- a hard blacklist, so the Director topic never triggers itself;
- a night window (22:00 to 08:00 UK time) for `communication` topics, overridable with `BLOCKED_AT_NIGHT`;
- rate-limit pause: after a rate-limit reply, auto-triggers wait until the window resets;
- fast retry (5 minutes) when the runner reports that the last job failed, timed out or went silent.

Checkpoint fields Director understands:

```
STATUS: IN_PROGRESS            # IN_PROGRESS | COMPLETED | STALLED | AWAITING_USER | DEFERRED
TASK: Migrate billing webhooks
PROGRESS: 60
NEXT: Write integration tests for the retry path
PRIORITY: high                 # high | normal | low
AUTO_MODEL: opus               # model for auto-triggers (default: sonnet)
EXECUTION_MODE: pev            # simple | pev
BLOCKED_BY: -1001234567890:42  # waits until that topic is COMPLETED
BLOCKS: -1001234567890:43      # dependents are woken up when this one completes
ARCHIVED: false
DO_NOT_REDO:
  - migration 0042 already applied
VERIFY_BEFORE_ACT: git log -1
```

**PEV mode** (`EXECUTION_MODE: pev`) runs a three-phase cycle: Opus writes a plan file, Sonnet (or `AUTO_MODEL`) executes it, Opus verifies. Failed verification loops back to execution with feedback. With `VISUAL_VERIFY: true` and `VISUAL_URL`, an extra phase opens the page in the browser and fixes rendering issues (up to 3 iterations).

**Morning summary.** Once a day at about 08:00 UK time, Director posts a summary of topic states to `DIRECTOR_SUMMARY_TOPIC`: active topics, topics completed in the last day, topics awaiting the user and triggers deferred by rate limits.

**Deeper audits** are ordinary agent work. A common setup is a dedicated Director topic with a recurring task such as `/loop 4h audit all checkpoints and report`. Grouping topics into clusters with goals and KPIs is also something you do in that topic's own markdown files. It is a usage pattern, not built-in code.

## Cross-topic work, reminders and loops

- **`trigger_topic(topicKey, text)`** (`mcp-router`) lets an agent start a spawn in another topic. A plain bot message to another topic would be ignored by the `allowedUsers` gate, so the tool calls the router's loopback `/internal/trigger` endpoint. It uses the same path as Director. `current_topic()` returns the caller's own `topicKey`.
- **`/loop 6h <text>`** stores a recurring task in `config/recurring.json`. Intervals go from `1m` to `30d`. Each run spawns Claude in that topic with the text.
- **Reminders.** `/remind` and the `reminder-mcp` tools (`schedule_reminder`, `list_reminders`, `cancel_reminder`) write to `config/reminders.json`. The router fires them. A reminder can post a plain message or run Claude in the topic. Reminders created while the router is down fire when it comes back.
- **Reminders in plain text.** A message that starts with "напомни ..." or "remind me ..." becomes `/remind`. A message that starts with a time phrase ("через 2 часа ...", "в 9 ...", "завтра ...", "in 2h ...") becomes a scheduled Claude run (`/remind --do`): it is not answered now, it runs at that time. Start the message with something else if you want an immediate answer.

## Browser pool

Without the pool, every topic shares one Chrome and they fight over the active tab. With `browserPool.enabled`, the runner asks the broker (`scripts/browser-pool-broker.ts`, `127.0.0.1:8930`) for a browser for each job and writes a per-topic MCP config, replacing only the `playwright` URL.

- Default: each topic gets its own browser MCP process (`browser-mcp/server.mjs`) with its own isolated context on a shared, logged-in Chrome (CDP), with cookies copied from that profile. Tabs are separated, and logins still work.
- Dedicated profiles: selected topics can get their own Chrome with a separate `user-data-dir` and CDP port, and no shared cookies. This keeps the logins of different projects in separate browser profiles.
- Limits: 16 concurrent topic browsers, 60-minute idle reaper, cleanup of orphaned processes after an unclean exit.
- Any broker error falls back to the static MCP config, so the pool cannot break normal chat.

Install the browser MCP dependencies once with `cd browser-mcp && npm install`. It depends only on two pinned packages: `@modelcontextprotocol/sdk` 1.29.0 and `playwright-core` 1.63.0. Dedicated profiles are mapped in `config/browser-dedicated.json` (copy `config/browser-dedicated.example.json`). The profile root defaults to `~/.teleclaude/browser-pool` (`BROWSER_POOL_PROFILE_ROOT`), and the shared bot Chrome profile to `~/.teleclaude/browser-profile` (`BOT_BROWSER_PROFILE`). Ports and the Chrome path are constants at the top of the broker file; adjust them for your machine. More details are in `scripts/README-browser-pool.md`. Chrome started from a service runs in an invisible session, so run the browser daemons as Scheduled Tasks at logon if you need to see the window, for example to log in once.

## Media: voice, video, photos, documents

| Input | Pipeline |
|-------|----------|
| Voice, audio, video notes, audio documents | Sent to local Whisper. The transcript is saved to `<project>/transcripts/` and passed to the agent as text. `ensure-whisper.ps1` starts the container if it is down |
| Video | Audio track through Whisper plus evenly spaced frames through ffmpeg (`src/video-frames.ts`), which the agent reads as images. Without ffmpeg the agent still gets the file and the transcript |
| Photo | The largest size is downloaded to `.tmp/` and the agent opens it with the Read tool |
| Document | Downloaded to `.tmp/` and passed by path. `scripts/setup-document-skills.ps1` can install PDF, DOCX, XLSX and PPTX skills (the payload is not in git) |

## Running as Windows services

The router and the runner are designed to run as Windows services under NSSM (the Non-Sucking Service Manager). The helper scripts assume the service name `ClaudeRouter`:

```powershell
nssm install ClaudeRouter "C:\path\to\bun.exe" "run src/index.ts"
nssm set ClaudeRouter AppDirectory "C:\path\to\teleclaude"
nssm set ClaudeRouter AppEnvironmentExtra "DIRECTOR_ALLOWED_CHATS=-1001234567890"

nssm install ClaudeRunner "C:\path\to\bun.exe" "run src/index.ts"
nssm set ClaudeRunner AppDirectory "C:\path\to\teleclaude\runner"
```

Useful helpers in `scripts/`: `doctor.ps1` (health check with exit codes), `mcp-health-watchdog.ps1`, `playwright-mcp-daemon.ps1`, `setup-cloudflared.ps1` and `set-telegram-webhook.ps1` for webhook mode through a tunnel. The router writes a `.router.pid` single-instance lock and exits if another instance is alive, which avoids Telegram 409 conflicts.

## Security

TeleClaude gives an AI agent a shell on your machine. Read this section before you run it.

- **Whitelist.** Only messages from `telegram.allowedUsers` are processed. Messages from other users, and from bots (including TeleClaude itself), are ignored.
- **`--dangerously-skip-permissions`.** The example settings pass this flag, because nobody is at the terminal to approve tool calls. The agent can then read, write and run anything your Windows user can. Use a dedicated user account or machine, keep backups, and put your rules (what needs explicit confirmation: payments, deletions, publishing) into `SOUL.md` and a global `~/.claude/CLAUDE.md`. Prompt rules reduce risk; they do not remove it. Remove the flag if you want the CLI's own permission checks, but most tool calls will then fail in unattended mode.
- **Secrets never in the repo.** `.env`, `config/settings.json`, `config/topics.json`, `config/accounts.json`, `config/kb.local.json`, reminders, logs and start scripts with tokens are gitignored. Account tokens and API keys are read from files you point to, and are not stored in `accounts.json`.
- **Environment hygiene.** `ANTHROPIC_API_KEY` is stripped from the child environment unless the active mode is `apikey`.
- **Local ports.** The router (`7885`) binds to `127.0.0.1` by default (`ROUTER_BIND_HOST`), the runner (`7878`) binds to `127.0.0.1` (`CLAUDE_RUNNER_HOST`), and the browser broker (`8930`) listens on `127.0.0.1` only. The runner accepts jobs without authentication, so keep it on loopback. `/internal/trigger` can start a spawn in any topic, so it accepts only loopback peers, rejects any request that carries `cf-connecting-ip` or `x-forwarded-for` (that is, anything that came through a tunnel or proxy), and, when `ROUTER_INTERNAL_SECRET` is set, requires the matching `x-router-internal-secret` header. As defense in depth, also block inbound connections to these ports in Windows Firewall. In webhook mode, publish only `/webhook` through your tunnel and set `ROUTER_WEBHOOK_SECRET`.
- **Privacy of optional integrations.** Both are off by default. The knowledge base hook (`config/kb.local.json`) sends the text of every message to the endpoint you configure. The realtime extractor (`GEMINI_API_KEY`) sends message text to the Google Gemini API. Without them, message text leaves your machine only through Telegram itself and through Claude Code.
- **Director scope.** Auto-triggers are limited to `DIRECTOR_ALLOWED_CHATS` and rate-limited as described above.

## Terms of use

TeleClaude is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the unmodified Claude Code CLI, and every request goes from your machine under your own credentials, so the provider's terms apply to you directly:

- Anthropic: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (Free, Pro, Max), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (API, Team, Enterprise), [Usage Policy](https://www.anthropic.com/legal/aup).
- Any other model provider you connect: its own terms of service.

What this means in practice:

- **Recommended: an API key** from the [Claude Console](https://platform.claude.com/) or a supported cloud provider (`apikey` mode). This is the authentication Anthropic intends for tools and automation built on top of Claude.
- **Subscription sign-in** (`default`, `token`, `configDir` modes) is only for your own personal use of Claude Code on your own machine, at your own risk. Pro and Max usage limits assume ordinary individual use, and unattended automation such as Director auto-triggers can go beyond that.
- **One person, own credentials.** Never share, pool, rotate, resell or lend accounts or tokens. If you set up TeleClaude for someone else, they sign in with their own account or their own API key; you never collect or store their credentials.
- **Limits are respected, not bypassed.** When a provider returns a rate limit, TeleClaude pauses and waits for the window to reset. It does not switch to other accounts to get around limits.

## Roadmap

- A second executor besides Claude Code, so the model provider is fully replaceable: an open CLI agent (for example OpenCode or Qwen Code) with any OpenAI-compatible API, including DeepSeek, Qwen, GigaChat and YandexGPT. Memory, checkpoints and Director stay the same.

## License

MIT. Copyright (c) Vladislav Popov. See [LICENSE](LICENSE).

Maintained by [@devladpopov](https://github.com/devladpopov).
