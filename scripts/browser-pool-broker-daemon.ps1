# Browser Pool Broker — супервизор (mirrors playwright-mcp-daemon.ps1).
#
# Гоняет `bun run scripts/browser-pool-broker.ts` в цикле, перезапуская
# при падении. Сам брокер слушает http://127.0.0.1:8930 и лениво поднимает
# изолированный Chrome+@playwright/mcp на каждый топик. См. шапку
# browser-pool-broker.ts.
#
# Запускается из launchers\browser-pool-broker.vbs (silent)
# через Scheduled Task BrowserPoolBroker (logon trigger).
# Health подхватывает mcp-health-watchdog.ps1 (порт 8930).

$ErrorActionPreference = 'Stop'

$RepoDir  = (Split-Path -Parent $PSScriptRoot)
$Script   = Join-Path $RepoDir 'scripts\browser-pool-broker.ts'
$LogDir   = $(if ($env:TELECLAUDE_LOG_DIR) { $env:TELECLAUDE_LOG_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'logs' })
$LogFile  = Join-Path $LogDir 'browser-pool-broker-daemon.log'
$LockFile = Join-Path $LogDir 'browser-pool-broker-daemon.lock'
$BunPath  = (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# --- single-instance lock (супервизора) ---------------------------------
if (Test-Path $LockFile) {
  $oldPid = Get-Content $LockFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Log "Supervisor already running (pid=$oldPid). Exiting."
    exit 0
  }
  Remove-Item $LockFile -ErrorAction SilentlyContinue
}
Set-Content -Path $LockFile -Value $PID -Encoding ASCII

if (-not (Test-Path $BunPath)) {
  $BunPath = (Get-Command bun -ErrorAction SilentlyContinue).Source
}
if (-not $BunPath) { Write-Log "ERROR: bun not found"; Remove-Item $LockFile -ErrorAction SilentlyContinue; exit 1 }

try {
  while ($true) {
    Write-Log "spawn: $BunPath run $Script"
    $ErrorActionPreference = 'Continue'
    & $BunPath run $Script 2>&1 | ForEach-Object {
      Add-Content -Path $LogFile -Value ("[bun] " + $_.ToString()) -Encoding UTF8
    }
    $ErrorActionPreference = 'Stop'
    Write-Log "broker exited (LASTEXITCODE=$LASTEXITCODE), restarting in 5s..."
    Start-Sleep -Seconds 5
  }
} finally {
  Remove-Item $LockFile -ErrorAction SilentlyContinue
}
