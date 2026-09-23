# Disable webhook + delete pending updates. Use to roll back to long-poll.
#
# After running this, also remove ROUTER_WEBHOOK_URL/SECRET from
# scripts/start-router.cmd and `nssm restart ClaudeRouter`.

$ErrorActionPreference = "Stop"

$token = $env:CLAUDE_ROUTER_BOT_TOKEN
if (-not $token) {
  $broker = $env:SECRETS_BROKER
  if ($broker -and (Test-Path $broker)) {
    $token = & $broker "telegram.router" 2>$null
    if ($token) { $token = $token.Trim() }
  }
}
if (-not $token) {
  Write-Error "Bot token not resolved."
  exit 1
}

$resp = Invoke-RestMethod "https://api.telegram.org/bot$token/deleteWebhook?drop_pending_updates=false" -Method POST
if ($resp.ok) {
  Write-Host "[wh] deleteWebhook OK: $($resp.description)"
} else {
  Write-Error "deleteWebhook failed: $($resp.description)"
}

$info = Invoke-RestMethod "https://api.telegram.org/bot$token/getWebhookInfo"
Write-Host "url after delete: '$($info.result.url)' (empty = long-poll mode)"
