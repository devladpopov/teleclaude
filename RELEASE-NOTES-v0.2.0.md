# TeleClaude v0.2.0

## RU

TeleClaude это роутер из Telegram в Claude Code с открытым исходным кодом (MIT). Супергруппа с топиками становится рабочим пространством: каждый топик привязан к своему каталогу проекта и своей сессии Claude Code, а всё работает на вашей машине с вашим текущим входом в Claude Code.

В версии 0.2.0 топик стал настоящей изолированной сессией, появились runner, который переживает рестарты роутера, и Director, который следит за чекпоинтами всех топиков и сам продолжает застрявшую работу. Подробный рассказ об архитектуре: <habr-link>.

### Главное

- **Топик = изолированная сессия.** Реальный id сессии хранится в `config/topics.json` и передаётся через `--resume`. Мьютекс на топик не даёт двум запросам попасть в одну сессию.
- **Память на каждом запуске** через `--append-system-prompt`: `VISION.md`, `SOUL.md`, `topic-memory.md`, `main-memory.md` и `contextFiles`.
- **Runner** (`runner/`): отдельный процесс владеет запусками `claude`, рестарт роутера не обрывает задачи.
- **Director**: скан `CHECKPOINT.md` раз в 15 минут без вызовов LLM, реестр и дашборд, автотриггер с кулдаунами и бюджетами, режим PEV (план, выполнение, проверка), зависимости `BLOCKS` и `BLOCKED_BY`, утренняя сводка, необязательная выгрузка дашборда по SSH.
- **Работа между топиками**: MCP `trigger_topic` и `current_topic`, напоминания `/remind` и `reminder-mcp`, повторяющиеся задачи `/loop`.
- **Аккаунты и модели**: слоты `/account` (`default`, `token`, `configDir`, `apikey`), пауза автотриггеров аккаунта после rate limit, `/model` и `/effort` на топик, тег модели в каждом ответе.
- **Пул браузеров**: свой изолированный браузерный контекст на топик и выделенные профили Chrome для отдельных топиков.
- **Медиа**: голос через локальный Whisper с автозапуском контейнера, видео (транскрипт и кадры ffmpeg), фото, документы.
- **Необязательные интеграции** (по умолчанию выключены): хук базы знаний и экстрактор фактов на Gemini.

### Обновление с 0.1.0

1. Скопируйте новые примеры: `config/accounts.example.json`, `config/director-topics.example.json`, `config/browser-dedicated.example.json` (все по желанию). Сверьте свой `.env` с новым `.env.example`.
2. В `config/settings.json` появились ключи `runner`, `browserPool`, `processes.defaultModel`, `processes.idleTimeoutMinutes`, `processes.heartbeat*`, `whisper.autoStart`. Старые ключи 0.1.0 остаются рабочими.
3. Установите зависимости runner (`cd runner && bun install`) и запустите его отдельным процессом или службой NSSM. Включите `"runner": { "enabled": true }`. Без runner роутер запускает `claude` сам, как раньше.
4. Для пула браузеров: `cd browser-mcp && npm install`. Зависимости зафиксированы: `@modelcontextprotocol/sdk` 1.29.0 и `playwright-core` 1.63.0.
5. Каталоги по умолчанию теперь в `~/.teleclaude/`: память (`TELECLAUDE_MEMORY_DIR`), профили пула (`BROWSER_POOL_PROFILE_ROOT`), профиль Chrome бота (`BOT_BROWSER_PROFILE`). Если у вас другое расположение, задайте переменные.
6. Зарегистрируйте `router-mcp` и `reminder-mcp` в MCP-конфиге для запусков (`TELECLAUDE_MCP_CONFIG`).

**Несовместимые изменения:**

- `--continue` больше не используется. Каждый топик продолжает свою сессию по id через `--resume`. Старые локальные id сессий не являются UUID и игнорируются, поэтому первый запуск в каждом топике после обновления начнёт новую сессию. Файлы памяти при этом сохраняются.
- Роутер и runner по умолчанию слушают только `127.0.0.1`. Если вы обращались к ним с другого хоста, это перестанет работать (см. `ROUTER_BIND_HOST`, `CLAUDE_RUNNER_HOST`).

### Безопасность

- HTTP-сервер роутера слушает `127.0.0.1` (`ROUTER_BIND_HOST`), runner слушает `127.0.0.1` (`CLAUDE_RUNNER_HOST`).
- `/internal/trigger` принимает только loopback-запросы, отклоняет запросы с `cf-connecting-ip` или `x-forwarded-for` (пришедшие через туннель) и может требовать заголовок `x-router-internal-secret`, совпадающий с `ROUTER_INTERNAL_SECRET`. `mcp-router` отправляет его сам.
- Режим webhook проверяет `ROUTER_WEBHOOK_SECRET` в каждом запросе. Бот слушает только `telegram.allowedUsers`.
- Все рабочие `config/*.json`, `.env`, логи и стартовые скрипты с токенами находятся в `.gitignore`.
- Хук базы знаний и экстрактор Gemini по умолчанию выключены. Если их включить, текст сообщений уходит во внешний сервис: на ваш эндпоинт базы знаний или в Google Gemini API.
- Пример настроек передаёт `--dangerously-skip-permissions`. Перед запуском прочитайте раздел Security в README.

Полный список изменений: [CHANGELOG.md](CHANGELOG.md). Статья на Хабре: <habr-link>.

## EN

TeleClaude is an open-source (MIT) router from Telegram to Claude Code. It turns a supergroup with topics into a workspace: each topic maps to its own project directory and its own Claude Code session, and everything runs on your machine with your existing Claude Code login.

Version 0.2.0 makes every topic a real isolated session, adds a runner that survives router restarts, and adds Director, which watches the checkpoints of all topics and resumes stalled work on its own. The full story of the architecture (in Russian): <habr-link>.

### Highlights

- **Topic = isolated session.** The real session id is stored in `config/topics.json` and passed as `--resume`. A per-topic mutex keeps two requests from hitting the same session.
- **Memory on every spawn** through `--append-system-prompt`: `VISION.md`, `SOUL.md`, `topic-memory.md`, `main-memory.md` and `contextFiles`.
- **Runner sidecar** (`runner/`): a separate process owns the `claude` spawns, so a router restart does not kill running jobs.
- **Director**: a `CHECKPOINT.md` scan every 15 minutes with no LLM calls, registry and dashboard, auto-trigger with cooldowns and budgets, PEV mode (plan, execute, verify), `BLOCKS` and `BLOCKED_BY` dependencies, morning summary, optional dashboard upload over SSH.
- **Cross-topic work**: `trigger_topic` and `current_topic` MCP tools, `/remind` and `reminder-mcp` reminders, `/loop` recurring tasks.
- **Accounts and models**: `/account` slots (`default`, `token`, `configDir`, `apikey`), per-account pause of auto-triggers after a rate limit, `/model` and `/effort` per topic, a model tag on every reply.
- **Browser pool**: an isolated browser context per topic, plus dedicated Chrome profiles for selected topics.
- **Media**: voice through local Whisper with container auto-start, video (transcript plus ffmpeg frames), photos, documents.
- **Optional integrations** (off by default): knowledge base hook and a Gemini fact extractor.

### Upgrading from 0.1.0

1. Copy the new examples: `config/accounts.example.json`, `config/director-topics.example.json`, `config/browser-dedicated.example.json` (all optional). Compare your `.env` with the new `.env.example`.
2. `config/settings.json` has new keys: `runner`, `browserPool`, `processes.defaultModel`, `processes.idleTimeoutMinutes`, `processes.heartbeat*`, `whisper.autoStart`. The 0.1.0 keys remain valid.
3. Install the runner dependencies (`cd runner && bun install`) and run it as a separate process or NSSM service. Set `"runner": { "enabled": true }`. Without the runner, the router spawns `claude` directly, as before.
4. For the browser pool: `cd browser-mcp && npm install`. Dependencies are pinned: `@modelcontextprotocol/sdk` 1.29.0 and `playwright-core` 1.63.0.
5. Default directories now live under `~/.teleclaude/`: memory (`TELECLAUDE_MEMORY_DIR`), pool profiles (`BROWSER_POOL_PROFILE_ROOT`), bot Chrome profile (`BOT_BROWSER_PROFILE`). Set these variables if your data lives elsewhere.
6. Register `router-mcp` and `reminder-mcp` in the MCP config for spawns (`TELECLAUDE_MCP_CONFIG`).

**Breaking changes:**

- `--continue` is no longer used. Each topic resumes its own session by id with `--resume`. Old local session ids are not UUIDs and are ignored, so the first run in each topic after the upgrade starts a new session. Memory files are kept.
- The router and the runner listen on `127.0.0.1` by default. Access from another host stops working unless you change `ROUTER_BIND_HOST` or `CLAUDE_RUNNER_HOST`.

### Security

- The router HTTP server binds to `127.0.0.1` (`ROUTER_BIND_HOST`), the runner binds to `127.0.0.1` (`CLAUDE_RUNNER_HOST`).
- `/internal/trigger` accepts only loopback peers, rejects requests with `cf-connecting-ip` or `x-forwarded-for` (traffic from a tunnel), and can require an `x-router-internal-secret` header matching `ROUTER_INTERNAL_SECRET`. `mcp-router` sends it automatically.
- Webhook mode checks `ROUTER_WEBHOOK_SECRET` on every request. The bot obeys only `telegram.allowedUsers`.
- All runtime `config/*.json`, `.env`, logs and start scripts with tokens are gitignored.
- The knowledge base hook and the Gemini extractor are off by default. When enabled, message text goes to an external service: your knowledge base endpoint or the Google Gemini API.
- The example settings pass `--dangerously-skip-permissions`. Read the Security section of the README before you run it.

Full list of changes: [CHANGELOG.md](CHANGELOG.md). Habr article: <habr-link>.
