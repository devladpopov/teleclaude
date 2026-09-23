# Register the Telegram webhook with the Bot API.
#
# Reads ~/.cloudflared/claude-router.info.json (written by setup-cloudflared.ps1)
# for the URL + secret, and the bot token from sops vault via get-secret.ps1
# (script path in $env:SECRETS_BROKER). Falls back to BOT_TOKEN env if no broker.
#
# Run AFTER cloudflared service is up and ClaudeRouter has been restarted
# with ROUTER_WEBHOOK_URL/SECRET in its env.

$ErrorActionPreference = "Stop"

$infoPath = Join-Path $env:USERPROFILE ".cloudflared\claude-router.info.json"
if (-not (Test-Path $infoPath)) {
  Write-Error "info file not found: $infoPath. Run setup-cloudflared.ps1 first."
  exit 1
}

$info = Get-Content $infoPath -Raw | ConvertFrom-Json
$webhookUrl = $info.webhookUrl
$secret = $info.secret

# Resolve bot token. Prefer secrets broker; fall back to env.
# Broker uses dot-notation keys (telegram.router for the router bot).
$token = $env:CLAUDE_ROUTER_BOT_TOKEN
if (-not $token) {
  $broker = $env:SECRETS_BROKER
  if ($broker -and (Test-Path $broker)) {
    try {
      $token = & $broker "telegram.router" 2>$null
      if ($token) { $token = $token.Trim() }
    } catch {
      Write-Warning "secrets broker failed: $($_.Exception.Message)"
    }
  }
}
if (-not $token) {
  Write-Error "Bot token not resolved. Set env CLAUDE_ROUTER_BOT_TOKEN or check secrets broker (key: telegram.router)."
  exit 1
}

# Sanity: ping our own /health to confirm router is up and in webhook mode.
Write-Host "[wh] checking /health on http://127.0.0.1:7885 ..."
try {
  $h = Invoke-RestMethod "http://127.0.0.1:7885/health"
  Write-Host "[wh] router mode: $($h.mode), pid=$($h.pid)"
  if ($h.mode -ne "webhook") {
    Write-Warning "router /health says mode=$($h.mode), expected 'webhook'. Is ROUTER_WEBHOOK_URL set in start-router.cmd? Did you restart the service?"
  }
} catch {
  Write-Warning "/health unreachable: $($_.Exception.Message). Continuing anyway."
}

# Sanity: ping the public webhook URL to confirm tunnel routes correctly.
# A POST without secret should get 403 (or 200 if no secret configured); GET should 404.
Write-Host "[wh] checking tunnel: GET $webhookUrl"
try {
  $r = Invoke-WebRequest $webhookUrl -Method GET -UseBasicParsing -ErrorAction Stop
  Write-Host "[wh] tunnel reachable, status=$($r.StatusCode)"
} catch {
  $sc = $_.Exception.Response.StatusCode.value__
  if ($sc -eq 404 -or $sc -eq 405) {
    Write-Host "[wh] tunnel reachable (status=$sc as expected for GET)"
  } else {
    Write-Warning "tunnel GET returned $sc -- may not be routing correctly"
  }
}

# Set the webhook
$body = @{
  url = $webhookUrl
  secret_token = $secret
  allowed_updates = @("message","edited_message","callback_query")
  drop_pending_updates = $false
  max_connections = 40
} | ConvertTo-Json -Compress

Write-Host "[wh] setWebhook -> $webhookUrl"
$resp = Invoke-RestMethod "https://api.telegram.org/bot$token/setWebhook" `
  -Method POST -Body $body -ContentType "application/json"

if ($resp.ok) {
  Write-Host "[wh] OK: $($resp.description)"
} else {
  Write-Error "setWebhook failed: $($resp.description)"
  exit 1
}

# Verify
Start-Sleep -Seconds 2
$info2 = Invoke-RestMethod "https://api.telegram.org/bot$token/getWebhookInfo"
Write-Host ""
Write-Host "=== getWebhookInfo ==="
Write-Host "url:                    $($info2.result.url)"
Write-Host "has_custom_certificate: $($info2.result.has_custom_certificate)"
Write-Host "pending_update_count:   $($info2.result.pending_update_count)"
Write-Host "ip_address:             $($info2.result.ip_address)"
Write-Host "last_error_date:        $($info2.result.last_error_date)"
Write-Host "last_error_message:     $($info2.result.last_error_message)"
Write-Host "max_connections:        $($info2.result.max_connections)"
Write-Host ""
Write-Host "If pending_update_count is large and stays large -- Telegram is failing"
Write-Host "to deliver. Check cloudflared service log + ClaudeRouter log."
