# Changelog

All notable changes to TeleClaude are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-23

### Added

**Sessions and memory**

- Topics are now isolated Claude Code sessions. The router stores the real Claude Code session id (UUID) per topic in `config/topics.json` and passes it as `--resume <session-id>`.
- Per-topic mutex: messages inside one topic run strictly in order, so two `--resume` calls never hit the same session at once. Different topics still run in parallel up to `processes.maxConcurrent`.
- Memory injection on every spawn through `--append-system-prompt` (`VISION.md`, `SOUL.md`, `topic-memory.md`, `main-memory.md` and optional per-topic `contextFiles`), because the appended prompt is not persisted across `--resume`. The block is capped to stay within Windows command-line limits.
- `VISION.md` per topic and the `/vision` command to show or edit the topic goal.
- Checkpoint discipline: the injected rules ask the agent to keep `CHECKPOINT.md` (`STATUS`, `TASK`, `LAST_ACTION`, `NEXT`, `DO_NOT_REDO`, `VERIFY_BEFORE_ACT`) in the project root.
- `templates/TG-RULES.md`: a short generic template of Telegram formatting rules, shown by `/rules`, with a condensed version in every system prompt.

**Runner sidecar**

- `runner/`: a separate process that owns the `claude` spawns. Processes run detached with file-based stdio, job state lives on disk, and the router reads events over SSE with `Last-Event-ID`, so a router restart does not kill running jobs. Includes an idle watchdog and a concurrency limit. Enabled with `runner.enabled`.

**Director** (`src/director.ts`, no LLM calls)

- Scans every mapped project's `CHECKPOINT.md` every 15 minutes and writes `config/director-registry.json`, `config/director-dashboard.json` and an activity log.
- Auto-triggers stale `IN_PROGRESS` topics with guards: allowed chats (`DIRECTOR_ALLOWED_CHATS`), per-tick cap, base and adaptive cooldowns, daily budget per topic, consecutive-trigger cap that resets on human activity, self-trigger blacklist, night window for communication topics, per-account quota pause after rate limits, fast retry after failed runner jobs.
- PEV mode (`EXECUTION_MODE: pev`): plan, execute, verify, with an optional visual verification phase in the browser.
- Dependencies between topics with `BLOCKS` and `BLOCKED_BY`.
- Checkpoint fields `PRIORITY`, `AUTO_MODEL`, `ARCHIVED`, `BLOCKED_AT_NIGHT`, and the `/priority`, `/archive`, `/unarchive` commands.
- Morning summary posted to `DIRECTOR_SUMMARY_TOPIC`.
- Optional dashboard sync over SSH to a static host (`src/dashboard-sync.ts`, `DASHBOARD_SYNC_*` variables), off while `DASHBOARD_SYNC_REMOTE` is unset.
- Topic classification in the optional `config/director-topics.json`.
- Clusters of topics and periodic deep audits are documented as a usage pattern (a dedicated Director topic plus `/loop`), not as built-in code.

**Cross-topic work and scheduling**

- `mcp-router` MCP server with `trigger_topic(topicKey, text)` to start work in another topic and `current_topic()` to get the caller's own topic key.
- `mcp-reminder` MCP server (`schedule_reminder`, `list_reminders`, `cancel_reminder`) and the `/remind`, `/reminders`, `/unremind` commands. Reminders missed while the router was down fire on startup.
- Recurring tasks: `/loop <interval> <text>`, `/loops`, `/unloop`, stored in `config/recurring.json`, intervals from `1m` to `30d`.

**Accounts and models**

- `/account` slots in `config/accounts.json` with types `default`, `token` (`CLAUDE_CODE_OAUTH_TOKEN` from a file), `configDir` (`CLAUDE_CONFIG_DIR`) and `apikey` (`ANTHROPIC_API_KEY` from a file). The active slot applies to new spawns without a restart.
- Rate-limit detection in replies and errors. Director pauses auto-triggers for the affected account until the quota window resets. Switching slots stays manual; there is no automatic slot switching.
- `/model` and `/effort` per topic (`--model`, `--effort`), with alias to exact slug mapping in `MODEL_SLUGS`.
- `ensureModelPrefix`: the router adds a model tag such as `[opus-5.5]` when a reply does not start with one.

**Browser pool**

- Broker (`scripts/browser-pool-broker.ts`, loopback only) that gives each topic its own browser MCP process with an isolated context on a shared, logged-in Chrome over CDP.
- Dedicated Chrome profiles for selected topics (own `user-data-dir` and CDP port, no shared cookies), mapped in `config/browser-dedicated.json`.
- Limits on concurrent browsers, an idle reaper, orphan cleanup, and fallback to the static MCP config on any broker error.

**Media**

- Whisper voice transcription with on-demand start of the Docker container (`whisper.autoStart`, `scripts/ensure-whisper.ps1`). Transcripts are saved in the project.
- Video: audio track through Whisper plus evenly spaced frames through ffmpeg.
- Photos: the largest size is downloaded and passed to the agent by path.
- Documents: downloaded and passed by path, with an optional installer for PDF, DOCX, XLSX and PPTX skills.

**Optional integrations** (both off by default)

- Knowledge base hook (`config/kb.local.json`). When enabled, it sends the text of every incoming message to your own endpoint.
- Realtime extractor. Created only when `GEMINI_API_KEY` is set. When enabled, it sends message text to the Google Gemini API and saves extracted facts into memory.

**Operations and output**

- Per-block streaming to Telegram, fence-aware splitting of long messages, heartbeat status edits during long tool runs.
- Single-instance lock (`.router.pid`), `/health` endpoint, optional webhook mode, recovery of orphaned "thinking..." messages after a crash.
- New commands: `/cancel`, `/killall`, `/alive`, `/topics`, `/pause`, `/resume`, `/quiet`, `/mode`, `/rules`, `/project`, `/whoami`, `/uptime`, `/version`, `/runner`, `/logs`.
- Windows helper scripts: `doctor.ps1`, `mcp-health-watchdog.ps1`, `playwright-mcp-daemon.ps1`, `setup-cloudflared.ps1`, `set-telegram-webhook.ps1`.

### Changed

- Session continuity no longer uses `--continue`. Each topic resumes its own session by id, so sessions from different topics cannot mix. Old non-UUID session ids are ignored and the topic starts a fresh session.
- Optional configuration moved to environment variables (see `.env.example`) and to new `config/*.example.json` files: `accounts`, `director-topics`, `browser-dedicated`. All runtime `config/*.json` files are gitignored.
- `config/settings.json` gained new keys: `processes.defaultModel`, `processes.idleTimeoutMinutes`, `processes.heartbeatAfterSeconds`, `processes.heartbeatIntervalSeconds`, `runner`, `browserPool`, `whisper.autoStart`, `whisper.startupTimeoutSeconds`, `whisper.healthTimeoutMs`. Keys from 0.1.0 remain valid.
- Default data directories live under `~/.teleclaude/`: shared memory `~/.teleclaude/memory` (`TELECLAUDE_MEMORY_DIR`), browser pool profiles `~/.teleclaude/browser-pool` (`BROWSER_POOL_PROFILE_ROOT`), bot browser profile `~/.teleclaude/browser-profile` (`BOT_BROWSER_PROFILE`).
- `browser-mcp` depends only on pinned `@modelcontextprotocol/sdk` 1.29.0 and `playwright-core` 1.63.0.

### Removed

- `--continue` based session handling.

### Security

- The router HTTP server binds to `127.0.0.1` by default (`ROUTER_BIND_HOST`).
- The runner binds to `127.0.0.1` (`CLAUDE_RUNNER_HOST`), since it accepts jobs without authentication.
- `/internal/trigger` accepts only loopback peers, rejects requests carrying `cf-connecting-ip` or `x-forwarded-for` (traffic that came through a tunnel or proxy), and optionally requires the `x-router-internal-secret` header to match `ROUTER_INTERNAL_SECRET`. `mcp-router` sends the header automatically when the variable is set.
- Webhook mode checks `ROUTER_WEBHOOK_SECRET` on every request.
- Only `telegram.allowedUsers` are obeyed; messages from other users and from bots are ignored.
- `ANTHROPIC_API_KEY` is removed from the child environment unless the active slot is of type `apikey`.
- Secrets and runtime configs (`.env`, `config/*.json`, logs, start scripts with tokens) are gitignored.
- Optional integrations that send message text to external services (knowledge base hook, Gemini extractor) are off by default and documented as such.

## [0.1.0] - 2026-04-05

Initial release.

### Added

- Router that maps each topic of a Telegram supergroup to its own project directory and Claude Code process.
- Session continuity with `--continue`.
- Three-level memory: `SOUL.md`, `main-memory.md`, `topic-memory.md`, with a memory manager for periodic cleanup and deduplication.
- Context compactor that saves key decisions to memory when the context grows.
- Optional voice transcription through a local Whisper server.
- Project factory that creates a project directory from `templates/` for new topics.
- Bot commands: `/help`, `/status`, `/ttl`, `/name`, `/compact`, `/reset`, `/kill`, `/memory`.

[0.2.0]: https://github.com/devladpopov/teleclaude/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devladpopov/teleclaude/releases/tag/v0.1.0
