# Browser Pool — изоляция вкладок по топикам

## Зачем

Раньше все топики супергруппы делили один bot-Chrome (CDP `:9222`) через один
стоковый `@playwright/mcp` (`:8931`). В CDP-режиме `@playwright/mcp` цепляется
к **дефолтному browser context** реального Chrome → все топики попадали в один
набор вкладок и дрались за активную вкладку (`bringToFront` глобальный).

Пул даёт **каждому топику свой изолированный браузер**:
отдельный Chrome (свой `--remote-debugging-port` + свой `--user-data-dir`) и
отдельный стоковый `@playwright/mcp` (свой порт, `--cdp-endpoint` на Chrome
этого топика). Стоковый MCP не меняется — изоляция за счёт физически разных
браузеров.

Почему CDP-split, а не стоковый persistent: в persistent-режиме MCP закрывает
браузер по концу сессии, а каждый `claude -p` = новая сессия → вкладки бы
пропадали между сообщениями. CDP-split (Chrome отдельно) сохраняет вкладки.

## Что добавлено / изменено

Новые файлы (additive):

- `scripts/browser-pool-broker.ts` — брокер. HTTP `:8930`, лениво поднимает
  Chrome+MCP на топик, idle-reaper, лимит параллельных браузеров (LRU-evict).
- `scripts/browser-pool-broker-daemon.ps1` — супервизор (перезапуск при падении).
- `src/browser-pool-client.ts` — мост: на job просит у брокера браузер топика
  и пишет per-topic mcp-config (подменяет только `playwright.url`).
- `launchers/browser-pool-broker.vbs` — тихий лаунчер.

Изменённые файлы (минимально, безопасно):

- `src/runner-client.ts` — вычисляет `mcpConfigPath`: per-topic при включённом
  флаге, иначе статичный (текущее поведение). Любая ошибка → откат на статичный.
- `scripts/mcp-health-watchdog.ps1` — проверяет `:8930`, но **только** если
  Scheduled Task `BrowserPoolBroker` существует. Пока не создана — no-op.

Поведение по умолчанию **не меняется**: фича выключена, пока в `settings.json`
нет `browserPool.enabled: true`.

## Включение

1. В `config/settings.json` добавить:

   ```json
   "browserPool": {
     "enabled": true,
     "brokerUrl": "http://127.0.0.1:8930"
   }
   ```

2. Создать Scheduled Task (от твоего пользователя, не от Cowork —
   Cowork PowerShell не elevated):

   ```powershell
   $action  = New-ScheduledTaskAction -Execute 'wscript.exe' `
     -Argument '"C:\path\to\launchers\browser-pool-broker.vbs"'
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   Register-ScheduledTask -TaskName 'BrowserPoolBroker' -Action $action `
     -Trigger $trigger -RunLevel Limited -Force
   Start-ScheduledTask -TaskName 'BrowserPoolBroker'
   ```

3. Перезапустить роутер (это твой шаг — сервисы под nssm, Claude их не трогает):

   ```powershell
   nssm restart ClaudeRouter
   ```

## Локальный тест (до боевого включения)

Брокер можно проверить отдельно, не трогая роутер:

```powershell
cd C:\path\to\teleclaude
bun run scripts/browser-pool-broker.ts        # запустить в отдельном окне

# в другом окне:
curl -s -X POST http://127.0.0.1:8930/alloc -H "Content-Type: application/json" -d "{\"topicKey\":\"-100123:11\"}"
curl -s -X POST http://127.0.0.1:8930/alloc -H "Content-Type: application/json" -d "{\"topicKey\":\"-100123:22\"}"
curl -s http://127.0.0.1:8930/health
```

Ожидаемо: два разных топика получают **разные** `mcpPort`/`cdpPort`, в `/health`
видно две записи, и на экране поднимаются два отдельных окна Chrome. Повторный
`/alloc` того же топика отдаёт тот же порт (идемпотентность).

Боевая проверка после включения: в двух топиках супергруппы одновременно
попросить через playwright что-то сделать — каждый работает в своём окне,
активная вкладка не перехватывается.

## Откат

`settings.json` → `browserPool.enabled: false`, затем `nssm restart ClaudeRouter`.
Опционально остановить задачу: `Stop-ScheduledTask BrowserPoolBroker`.
Роутер сразу вернётся к статичному `spawn-mcp-config.json`.

## Параметры (в шапке `browser-pool-broker.ts`)

- `MAX_BROWSERS = 4` — лимит параллельных браузеров.
- `IDLE_MINUTES = 20` — простаивающие топики гасятся. `user-data-dir` на топик
  персистентный → cookies/логины переживают reaping.
- Порты: брокер `8930`, cdp-пул `9300+`, mcp-пул `8940+` (не пересекаются с
  существующими `8931/8932/9222`).

## Известные ограничения / follow-up

- **chrome-devtools MCP (`:8932`) пока общий** — он по-прежнему смотрит на
  старый Chrome `:9222`. Если агенты пользуются `chrome-devtools`-тулзами, там
  конфликт сохранится. Лечится тем же приёмом: добавить в per-topic mcp-config
  подмену `chrome-devtools.url` на per-topic инстанс (брокер уже знает cdpPort
  топика — можно поднять chrome-devtools-mcp через supergateway на свой порт).
  Заведено как следующий шаг; сейчас вне области (запрос был про playwright).
- Холодный старт топика ~2-5с (бут Chrome) на первом `/alloc` — дальше быстро.
