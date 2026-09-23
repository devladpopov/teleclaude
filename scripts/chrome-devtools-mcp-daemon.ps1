# Chrome DevTools MCP Daemon
#
# Оборачивает chrome-devtools-mcp (stdio-only) через supergateway
# в SSE HTTP-сервер на порту 8932.
#
# Зачем: chrome-devtools-mcp не поддерживает --port нативно,
# поэтому при stdio-транспорте он умирает вместе с claude -p.
# supergateway проксирует stdio MCP -> SSE HTTP, и сервер живёт
# независимо от жизненного цикла claude.
#
# SSE endpoint: http://localhost:8932/sse
#
# Запускается из launchers\chrome-devtools-mcp.vbs (silent)
# через Scheduled Task ChromeDevToolsMCPDaemon (logon trigger).

$ErrorActionPreference = 'Stop'

$Port        = 8932
$LogDir      = $(if ($env:TELECLAUDE_LOG_DIR) { $env:TELECLAUDE_LOG_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'logs' })
$LogFile     = Join-Path $LogDir 'chrome-devtools-mcp-daemon.log'
$LockFile    = Join-Path $LogDir 'chrome-devtools-mcp-daemon.lock'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# --- single-instance lock ----------------------------------------------------
if (Test-Path $LockFile) {
  $oldPid = Get-Content $LockFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Log "Already running (pid=$oldPid). Exiting."
    exit 0
  }
  Remove-Item $LockFile -ErrorAction SilentlyContinue
}
Set-Content -Path $LockFile -Value $PID -Encoding ASCII

try {
  Write-Log "Starting Chrome DevTools MCP daemon on port $Port (via supergateway)"

  $npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npx) { $npx = (Get-Command npx -ErrorAction SilentlyContinue).Source }
  if (-not $npx) {
    Write-Log "ERROR: npx not found in PATH"
    exit 1
  }

  # Сначала пробуем глобально установленный supergateway, фолбэк на npx
  $sg = (Get-Command supergateway -ErrorAction SilentlyContinue).Source
  $useSg = $false
  if ($sg) {
    $useSg = $true
    Write-Log "Using global supergateway: $sg"
  } else {
    Write-Log "Global supergateway not found, will use npx -y"
  }

  # Loop: если процесс умер — перезапускаем через 5 сек.
  # ВАЖНО: $ErrorActionPreference = 'Continue' внутри цикла,
  # иначе stderr-вывод дочернего процесса (через 2>&1) превращается
  # в PS ErrorRecord и при 'Stop' выбрасывает исключение даже на
  # безобидные banner-строки вроде "chrome-devtools-mcp exposes...".
  while ($true) {
    $ErrorActionPreference = 'Continue'
    $cmd = if ($useSg) { $sg } else { $npx }
    $cmdArgs = if ($useSg) {
      @('--stdio', 'npx -y chrome-devtools-mcp@latest', '--port', $Port)
    } else {
      @('-y', 'supergateway', '--stdio', 'npx -y chrome-devtools-mcp@latest', '--port', $Port)
    }
    Write-Log "spawn: $cmd $($cmdArgs -join ' ')"
    & $cmd @cmdArgs 2>&1 | ForEach-Object {
      $line = $_.ToString()
      Add-Content -Path $LogFile -Value ("[sg] " + $line) -Encoding UTF8
    }
    $ErrorActionPreference = 'Stop'
    Write-Log "process exited (LASTEXITCODE=$LASTEXITCODE), restarting in 5s..."
    Start-Sleep -Seconds 5
  }
} finally {
  Remove-Item $LockFile -ErrorAction SilentlyContinue
}
