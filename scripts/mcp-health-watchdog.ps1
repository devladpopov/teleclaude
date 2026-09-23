# MCP Health Watchdog
#
# Раз в 5 минут (Scheduled Task MCPHealthWatchdog) проверяет,
# что SSE/HTTP MCP-демоны живы и слушают:
#   - Playwright MCP   :8931 (IPv4)
#   - Chrome DevTools  :8932 (IPv4)
#   - Chrome CDP       :9222 (IPv4) — backing для Playwright
#
# Если любой порт не отвечает — дёргаем соответствующую Scheduled Task
# (PlaywrightMCPDaemon / ChromeDevToolsMCPDaemon). Демон-скрипт
# имеет single-instance lock, поэтому повторный запуск при живом
# демоне — no-op.
#
# Молчаливый режим: ничего не пишет в лог, когда всё ок.
# Если что-то перезапущено — пишет строку в .logs/mcp-watchdog.log.
#
# Запускается через launchers\mcp-health-watchdog.vbs
# чтобы избежать мигания PowerShell-окна.

$ErrorActionPreference = 'Continue'

$LogDir  = $(if ($env:TELECLAUDE_LOG_DIR) { $env:TELECLAUDE_LOG_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'logs' })
$LogFile = Join-Path $LogDir 'mcp-watchdog.log'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
  # Проверяем конкретно IPv4 127.0.0.1, потому что Claude CLI
  # (node.js) ходит в localhost через IPv4 first. Если слушается
  # только на [::1], клиент молча не видит MCP.
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok  = $iar.AsyncWaitHandle.WaitOne(1500, $false)
    if ($ok -and $tcp.Connected) { return $true }
    return $false
  } catch { return $false }
  finally { try { $tcp.Close() } catch {} }
}

function Kick-Task($TaskName, $Reason) {
  try {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Log "RESTART $TaskName ($Reason)"
  } catch {
    Write-Log "FAIL Start-ScheduledTask $TaskName : $($_.Exception.Message)"
  }
}

# --- Playwright + CDP --------------------------------------------------------
# Chrome CDP :9222 и Playwright MCP :8931 управляются одной задачей
# PlaywrightMCPDaemon. Если любой из портов лежит — дёргаем её.
$playPort = Test-Port 8931
$cdpPort  = Test-Port 9222

if (-not $playPort -or -not $cdpPort) {
  # Вычищаем залипший lock на случай если супервизор умер молча
  Remove-Item (Join-Path $LogDir 'playwright-mcp-daemon.lock') `
    -Force -ErrorAction SilentlyContinue

  $reason = @()
  if (-not $playPort) { $reason += 'port 8931 down' }
  if (-not $cdpPort)  { $reason += 'port 9222 down' }
  Kick-Task 'PlaywrightMCPDaemon' ($reason -join '; ')
}

# --- chrome-devtools MCP -----------------------------------------------------
if (-not (Test-Port 8932)) {
  Remove-Item (Join-Path $LogDir 'chrome-devtools-mcp-daemon.lock') `
    -Force -ErrorAction SilentlyContinue
  Kick-Task 'ChromeDevToolsMCPDaemon' 'port 8932 down'
}

# --- Browser Pool Broker (режим "окно на топик") -----------------------------
# Если порт :8930 лежит — поднимаем брокер тем же VBS-лаунчером (через Startup
# или launchers). Single-instance lock'и сами разруливают дубли.
if (-not (Test-Port 8930)) {
  $bpVbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\browser-pool-broker.vbs'
  if (-not (Test-Path $bpVbs)) { $bpVbs = (Join-Path (Split-Path -Parent $PSScriptRoot) 'launchers\browser-pool-broker.vbs') }
  try {
    Start-Process 'wscript.exe' -ArgumentList "`"$bpVbs`""
    Write-Log "RESTART BrowserPoolBroker (port 8930 down) via $bpVbs"
  } catch {
    Write-Log "FAIL launch BrowserPoolBroker: $($_.Exception.Message)"
  }
}
