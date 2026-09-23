# Setup Cloudflare tunnel for ClaudeRouter webhook.
#
# PREREQUISITE (run once, interactively, in any PowerShell window):
#   & "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel login
# That opens a browser, you log into Cloudflare, pick the zone, and
# cloudflared writes ~/.cloudflared/cert.pem.
#
# Then run this script (admin, for nssm install):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-cloudflared.ps1
#
# What it does:
#   1. Creates a tunnel named "claude-router" if missing.
#   2. Generates a route DNS for <subdomain>.<zone> pointing at the tunnel.
#   3. Writes ~/.cloudflared/config.yml mapping path /webhook → http://localhost:7885/webhook.
#   4. Generates ROUTER_WEBHOOK_SECRET (64 random hex chars).
#   5. Writes the secret + URL to scripts/start-router.cmd (idempotent).
#   6. Installs cloudflared as a Windows service via nssm (or `cloudflared service install`).
#   7. Prints the final webhook URL -- you then run:
#        powershell -ExecutionPolicy Bypass -File scripts\set-telegram-webhook.ps1
#      to register the webhook with Telegram.

param(
  [string]$TunnelName = "claude-router",
  [string]$Subdomain  = "teleclaude",
  [string]$Zone       = $null,                # if not provided, prompts
  [int]$LocalPort     = 7885
)

# NB: not using ErrorActionPreference=Stop here. cloudflared writes
# version-update warnings to stderr and PowerShell 5.1 + Stop treats
# any native-cmd stderr as a fatal error. We check exit codes
# explicitly where it matters.
$ErrorActionPreference = "Continue"
$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

if (-not (Test-Path $cf)) {
  Write-Error "cloudflared not found at $cf. Install first: winget install Cloudflare.cloudflared"
  exit 1
}

$cfDir = Join-Path $env:USERPROFILE ".cloudflared"
$certPath = Join-Path $cfDir "cert.pem"
if (-not (Test-Path $certPath)) {
  Write-Error "Not authenticated. Run first:`n  & `"$cf`" tunnel login"
  exit 1
}

# 1) Create tunnel (or reuse existing)
$existing = & $cf tunnel list 2>$null | Select-String -Pattern "^\S+\s+$([regex]::Escape($TunnelName))\s"
if ($existing) {
  Write-Host "[setup] tunnel '$TunnelName' already exists, reusing"
} else {
  Write-Host "[setup] creating tunnel '$TunnelName'"
  & $cf tunnel create $TunnelName
}

# Find tunnel UUID + credentials file
$listOut = & $cf tunnel list 2>&1
$line = $listOut | Select-String -Pattern "^\S+\s+$([regex]::Escape($TunnelName))\s" | Select-Object -First 1
if (-not $line) { Write-Error "tunnel create reported success but list shows nothing"; exit 1 }
$tunnelId = ($line.ToString().Trim() -split "\s+")[0]
$credFile = Join-Path $cfDir "$tunnelId.json"
if (-not (Test-Path $credFile)) {
  Write-Error "credential file not found: $credFile"
  exit 1
}
Write-Host "[setup] tunnel UUID: $tunnelId"
Write-Host "[setup] credentials: $credFile"

# 2) DNS route
if (-not $Zone) {
  $Zone = Read-Host "Cloudflare zone (e.g. example.com)"
}
$hostname = "$Subdomain.$Zone"
Write-Host "[setup] routing $hostname -> tunnel $TunnelName"
& $cf tunnel route dns $TunnelName $hostname

# 3) config.yml
$configPath = Join-Path $cfDir "config.yml"
$configBody = @"
tunnel: $tunnelId
credentials-file: $credFile

ingress:
  - hostname: $hostname
    path: /webhook
    service: http://localhost:$LocalPort
  - hostname: $hostname
    path: /health
    service: http://localhost:$LocalPort
  - hostname: $hostname
    path: /heartbeat
    service: http://localhost:$LocalPort
  - hostname: $hostname
    path: /morning-summary
    service: http://localhost:$LocalPort
  - service: http_status:404
"@
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($configPath, $configBody, $utf8)
Write-Host "[setup] wrote $configPath"

# 4) Generate webhook secret
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })

# 5) Patch start-router.cmd to export ROUTER_WEBHOOK_URL + ROUTER_WEBHOOK_SECRET
$startCmd = Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\start-router.cmd"
if (Test-Path $startCmd) {
  $content = Get-Content $startCmd -Raw
  $url = "https://$hostname/webhook"
  if ($content -notmatch "ROUTER_WEBHOOK_URL=") {
    # Insert ROUTER_WEBHOOK_URL/SECRET right after the @echo off line
    $injection = "`r`nset `"ROUTER_WEBHOOK_URL=$url`"`r`nset `"ROUTER_WEBHOOK_SECRET=$secret`""
    $content = $content -replace "(@echo off\r?\n)", "`$1$injection`r`n"
    [System.IO.File]::WriteAllText($startCmd, $content, $utf8)
    Write-Host "[setup] injected ROUTER_WEBHOOK_URL/SECRET into start-router.cmd"
  } else {
    Write-Host "[setup] start-router.cmd already has ROUTER_WEBHOOK_URL -- not overwriting"
  }
} else {
  Write-Warning "start-router.cmd not found -- set env vars manually before nssm restart"
}

# 6) Install as Windows service
Write-Host "[setup] installing cloudflared as Windows service..."
& $cf --config $configPath service install 2>&1 | Out-Host

# 7) Save webhook info
$infoPath = Join-Path $cfDir "claude-router.info.json"
$info = @{
  tunnelId  = $tunnelId
  tunnelName = $TunnelName
  hostname  = $hostname
  webhookUrl = "https://$hostname/webhook"
  secret    = $secret
  createdAt = (Get-Date).ToString("o")
}
$info | ConvertTo-Json -Depth 3 | Set-Content -Path $infoPath -Encoding UTF8 -NoNewline
Write-Host "[setup] saved $infoPath"

Write-Host ""
Write-Host "=== DONE ==="
Write-Host "Tunnel:       $TunnelName ($tunnelId)"
Write-Host "Hostname:     $hostname"
Write-Host "Webhook URL:  https://$hostname/webhook"
Write-Host "Secret:       (saved to $infoPath; also injected into start-router.cmd)"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1) Restart router so it picks up the new env vars:"
Write-Host "       nssm restart ClaudeRouter"
Write-Host "  2) Wait ~10s, then register the webhook with Telegram:"
Write-Host "       powershell -ExecutionPolicy Bypass -File scripts\set-telegram-webhook.ps1"
Write-Host "  3) Verify: getWebhookInfo should show pending_update_count=0"
Write-Host '  4) /health should report mode="webhook"'
