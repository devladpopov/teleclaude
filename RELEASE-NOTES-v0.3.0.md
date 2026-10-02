# TeleClaude v0.3.0 (draft)

## RU

TeleClaude это рабочее пространство в Telegram для AI-агентов с открытым исходным кодом (MIT): каждый топик это отдельный проект со своей памятью, а всё работает на вашей машине.

В версии 0.3.0 модель стала заменяемой частью. Кроме Claude Code топик может работать через OpenCode с любой OpenAI-совместимой моделью: DeepSeek, Qwen и другими. Память, чекпоинты, Director и работа между топиками остаются теми же, а смена провайдера это одна команда.

### Главное

- **Провайдеры.** `config/providers.json` и команда `/provider` с кнопками. Смена действует со следующего сообщения, без рестарта.
- **Сессии по исполнителям.** Топик можно перевести на DeepSeek и обратно, оба диалога продолжатся.
- **Та же память и те же инструменты.** Память и правила приходят в OpenCode файлом инструкций, MCP-серверы (напоминания, `trigger_topic`, браузер) подключаются автоматически.
- **Честный префикс.** Каждый ответ подписан реальным провайдером и моделью, например `[deepseek:deepseek-chat]`.
- **Лимиты отдельно по провайдерам.** При 429 Director ставит на паузу только топики этого провайдера. Сам TeleClaude провайдера не меняет.
- **Ключи.** Ключ провайдера читается из файла вне репозитория и попадает только в окружение своей задачи. Секреты роутера в задачи других провайдеров не передаются, runner не хранит окружение задач на диске.
- **Режимы авторизации Claude.** Рекомендуется API-ключ; ваш собственный вход в Claude Code допустим для личного использования.

### Обновление с 0.2.0

1. Установите OpenCode (`npm i -g opencode-ai`) или укажите путь в `processes.opencodePath`.
2. Скопируйте `config/providers.example.json` в `config/providers.json`, оставьте нужных провайдеров, положите ключи в `~/.teleclaude/secrets/`.
3. `runner.enabled: true` обязателен для провайдеров кроме Claude. Без `config/providers.json` всё работает как в 0.2.0.
4. Перезапустите runner и роутер.

## EN

TeleClaude is an open-source (MIT) Telegram workspace for AI agents: every topic is a project with its own memory, and everything runs on your machine.

In 0.3.0 the model becomes a replaceable part. Besides Claude Code, a topic can run on OpenCode with any OpenAI-compatible model: DeepSeek, Qwen and others. Memory, checkpoints, Director and cross-topic work stay the same, and changing the provider is one command.

### Highlights

- **Providers.** `config/providers.json` and the `/provider` command with buttons. Applies from the next message, no restart.
- **Sessions per executor.** Move a topic to DeepSeek and back, both conversations continue.
- **Same memory, same tools.** Memory and rules reach OpenCode as an instructions file; MCP servers (reminders, `trigger_topic`, browser) are connected automatically.
- **Honest prefix.** Every reply names the real provider and model, for example `[deepseek:deepseek-chat]`.
- **Limits per provider.** On a 429, Director pauses only that provider's topics. TeleClaude never changes the provider by itself.
- **Keys.** A provider key is read from a file outside the repo and goes only into its own job's environment. Router secrets are not passed to jobs on other providers, and the runner keeps no job environment on disk.
- **Claude authentication modes.** An API key is recommended; your own Claude Code login is fine for personal use.

### Upgrading from 0.2.0

1. Install OpenCode (`npm i -g opencode-ai`) or set `processes.opencodePath`.
2. Copy `config/providers.example.json` to `config/providers.json`, keep the providers you need, put keys into `~/.teleclaude/secrets/`.
3. `runner.enabled: true` is required for providers other than Claude. Without `config/providers.json` everything works as in 0.2.0.
4. Restart the runner and the router.

Full list of changes: [CHANGELOG.md](CHANGELOG.md).
