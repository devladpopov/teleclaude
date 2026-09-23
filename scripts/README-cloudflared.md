# Cloudflared webhook setup for ClaudeRouter

Замена long-poll на webhook через Cloudflare Tunnel. Эффект:
никаких больше 409 Conflict от Telegram, никаких ECONNRESET
на getUpdates, мгновенная доставка апдейтов.

Архитектура:

```
Telegram ──HTTPS POST──> teleclaude.<zone> ──cloudflared──>
  └──> 127.0.0.1:7885/webhook ──> Bun.serve ──> bot.handleUpdate()
```

## Один раз: cloudflared login (интерактивно)

cloudflared уже установлен (winget). Логинимся в Cloudflare:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel login
```

Откроется браузер. Авторизуйся в своём Cloudflare-аккаунте,
выбери зону (например `example.com`). После этого
`%USERPROFILE%\.cloudflared\cert.pem` будет создан.

## Один раз: создать тоннель + Windows-сервис

```powershell
cd C:\path\to\teleclaude
powershell -ExecutionPolicy Bypass -File scripts\setup-cloudflared.ps1 -Zone example.com
```

Если хочешь другое имя/субдомен:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-cloudflared.ps1 `
  -TunnelName claude-router `
  -Subdomain teleclaude `
  -Zone example.com
```

Скрипт сам:
- создаст тоннель `claude-router`
- настроит DNS-route `teleclaude.example.com` → тоннель
- запишет `~/.cloudflared/config.yml` с ingress'ом на :7885/webhook
- сгенерирует случайный 64-hex `ROUTER_WEBHOOK_SECRET`
- впишет `ROUTER_WEBHOOK_URL` + `ROUTER_WEBHOOK_SECRET` в
  `scripts/start-router.cmd`
- установит `cloudflared` как Windows-сервис

После этого:

```powershell
nssm restart ClaudeRouter
# подождать 10 сек
Invoke-RestMethod http://127.0.0.1:7885/health | Select mode,pid
# должно быть mode=webhook
```

## Один раз: зарегистрировать webhook в Telegram

```powershell
powershell -ExecutionPolicy Bypass -File scripts\set-telegram-webhook.ps1
```

Скрипт:
- читает URL+secret из `~/.cloudflared/claude-router.info.json`
- берёт токен бота из секрет-брокера (или env `CLAUDE_ROUTER_BOT_TOKEN`)
- проверяет что роутер в webhook-режиме (через /health)
- проверяет что тоннель реагирует
- зовёт `setWebhook` у Telegram'а
- печатает `getWebhookInfo` для верификации

## Откат на long-poll

Если что-то сломалось — откат за 30 сек:

```powershell
# 1) Удалить вебхук в Telegram
powershell -ExecutionPolicy Bypass -File scripts\unset-telegram-webhook.ps1

# 2) Убрать ROUTER_WEBHOOK_URL из start-router.cmd
# (вручную, или просто закомментировать `set "ROUTER_WEBHOOK_URL=..."`)

# 3) Перезапустить роутер
nssm restart ClaudeRouter
```

После этого роутер снова поднимет `@grammyjs/runner` long-poll loop.

## Диагностика

Webhook не доставляется?

```powershell
# Бот думает, что webhook где?
$token = $env:CLAUDE_ROUTER_BOT_TOKEN
Invoke-RestMethod "https://api.telegram.org/bot$token/getWebhookInfo" |
  Select -Expand result | fl url,pending_update_count,last_error_date,last_error_message

# Cloudflared жив?
Get-Service cloudflared | ft Name,Status,StartType
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel info claude-router

# Тест прямой доставки в /webhook (без Telegram)
$secret = (Get-Content $env:USERPROFILE\.cloudflared\claude-router.info.json | ConvertFrom-Json).secret
Invoke-RestMethod "http://127.0.0.1:7885/webhook" `
  -Method POST `
  -Headers @{"x-telegram-bot-api-secret-token"=$secret} `
  -Body '{"update_id":1}' -ContentType "application/json"
```

## Файлы

- `scripts\setup-cloudflared.ps1` — основной setup-скрипт
- `scripts\set-telegram-webhook.ps1` — registerWebhook
- `scripts\unset-telegram-webhook.ps1` — откат
- `~/.cloudflared/config.yml` — ingress-конфиг (создаётся скриптом)
- `~/.cloudflared/claude-router.info.json` — UUID, hostname, secret
- `~/.cloudflared/<uuid>.json` — credentials (создаётся `tunnel create`)
