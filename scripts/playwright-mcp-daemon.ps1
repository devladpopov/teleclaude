# Playwright MCP Daemon (CDP architecture)
#
# Архитектура: Chrome и Playwright MCP — ОТДЕЛЬНЫЕ процессы.
#
# 1. Chrome запускается с --remote-debugging-port=9222
#    и --user-data-dir (отдельный профиль для бота).
#    Chrome живёт независимо от MCP — вкладки, cookies, формы
#    сохраняются даже когда ни один MCP-клиент не подключён.
#
# 2. Playwright MCP демон подключается к Chrome через CDP
#    (--cdp-endpoint) и слушает SSE на порту 8931.
#    Каждый claude -p подключается к демону по SSE, демон
#    проксирует команды в Chrome через CDP.
#
# Зачем: при прямом управлении браузером Playwright MCP
# закрывает его при завершении MCP-сессии. При CDP-архитектуре
# Chrome — отдельный процесс, и Playwright не может его убить.
# Вкладка с формой логина живёт между сообщениями в Telegram.
#
# Запускается из launchers\playwright-mcp.vbs (silent)
# через Scheduled Task PlaywrightMCPDaemon (logon trigger).

$ErrorActionPreference = 'Stop'

$Port           = 8931
$CdpPort        = 9222
$UserDataDir    = $(if ($env:BOT_BROWSER_PROFILE) { $env:BOT_BROWSER_PROFILE } else { Join-Path $env:USERPROFILE '.teleclaude\browser-profile' })
$LogDir         = $(if ($env:TELECLAUDE_LOG_DIR) { $env:TELECLAUDE_LOG_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'logs' })
$LogFile        = Join-Path $LogDir 'playwright-mcp-daemon.log'
$LockFile       = Join-Path $LogDir 'playwright-mcp-daemon.lock'
$ChromePath     = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# --- single-instance lock -----------------------------------------------
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
  $npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npx) { $npx = (Get-Command npx -ErrorAction SilentlyContinue).Source }
  if (-not $npx) { Write-Log "ERROR: npx not found"; exit 1 }

  Write-Log "Starting Playwright MCP daemon (CDP architecture)"
  Write-Log "  Chrome: $ChromePath --remote-debugging-port=$CdpPort --user-data-dir=$UserDataDir"
  Write-Log "  MCP SSE: port $Port -> cdp-endpoint http://localhost:$CdpPort"

  # ---- Step 1: Ensure BOT-Chrome is running with CDP -----------------
  # Раньше функция просто проверяла "слушает ли кто-то порт 9222". Это
  # ломалось когда основной Chrome пользователя автоматически стартовал
  # с флагом --remote-debugging-port=9222 (auto-restore, ярлык, etc):
  # daemon видел "о, Chrome уже есть", не запускал свой, и Playwright
  # подключался к основному Chrome пользователя — бот навигировал в его
  # рабочих вкладках. Теперь проверка строгая: ищем chrome.exe ИМЕННО
  # с нашим --user-data-dir. Если такого нет — стартуем свой.
  function Ensure-Chrome {
    $botChromeRunning = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like "*--remote-debugging-port=$CdpPort*" -and
        $_.CommandLine -like "*--user-data-dir=$UserDataDir*"
      } | Select -First 1

    if ($botChromeRunning) {
      Write-Log "Bot-Chrome already running (pid=$($botChromeRunning.ProcessId), profile=$UserDataDir)"
      return
    }

    # Если кто-то ДРУГОЙ держит наш порт (например основной Chrome пользователя
    # с тем же --remote-debugging-port=9222 без --user-data-dir) —
    # ругаемся, но не пытаемся убить чужой процесс. Пользователь должен сам
    # перезапустить свой Chrome без CDP-флага. Мы при этом не можем
    # запустить свой, потому что порт занят. Логируем и выходим из
    # Ensure-Chrome — Playwright всё равно попробует подключиться к
    # тому что есть; функционально это деградация, но не катастрофа.
    $portTaken = netstat -an | Select-String ":$CdpPort\s+.*LISTENING"
    if ($portTaken) {
      Write-Log "WARN: port $CdpPort taken by another process (likely the user's main Chrome with --remote-debugging-port). Bot-Chrome NOT started. Close that Chrome to fix."
      return
    }

    Write-Log "Launching bot-Chrome with --remote-debugging-port=$CdpPort --user-data-dir=$UserDataDir"
    Start-Process -FilePath $ChromePath -ArgumentList @(
      "--remote-debugging-port=$CdpPort",
      "--user-data-dir=$UserDataDir",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--window-position=100,100",
      "--window-size=1280,800",
      "about:blank"
    ) -WindowStyle Normal

    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      $cdpListening = netstat -an | Select-String ":$CdpPort\s+.*LISTENING"
      if ($cdpListening) {
        Write-Log "Bot-Chrome CDP ready on :$CdpPort (waited ${i}s)"
        return
      }
    }
    Write-Log "WARN: Bot-Chrome CDP port $CdpPort not detected after 30s"
  }

  # ---- Step 2: Loop Playwright MCP daemon ----------------------------
  while ($true) {
    Ensure-Chrome

    # --host 127.0.0.1 обязателен: по умолчанию @playwright/mcp биндится
    # только на [::1] (IPv6), и Claude CLI (IPv4-first) молча не видит MCP.
    #
    # --allowed-hosts обязателен: при --host 127.0.0.1 MCP кладёт в
    # allowedHosts нормализованный "localhost:$Port" (через normalizeLoopback
    # в installHttpTransport в playwright-core/lib/tools/utils/mcp/http.js).
    # Запрос от Claude CLI с Host: 127.0.0.1:$Port отбивается 403
    # "Access is only allowed at localhost:$Port". Явно перечисляем оба
    # ожидаемых Host-header варианта. Звёздочку "*" не используем, потому
    # что PowerShell 5.1 её теряет при передаче в cmd.exe/npx.cmd.
    $allowed = "127.0.0.1:$Port,localhost:$Port"
    Write-Log "spawn: $npx -y @playwright/mcp@latest --host 127.0.0.1 --port $Port --cdp-endpoint http://127.0.0.1:$CdpPort --allowed-hosts $allowed"
    $ErrorActionPreference = 'Continue'
    & $npx -y '@playwright/mcp@latest' --host 127.0.0.1 --port $Port --cdp-endpoint "http://127.0.0.1:$CdpPort" --allowed-hosts $allowed 2>&1 |
      ForEach-Object {
        $line = $_.ToString()
        Add-Content -Path $LogFile -Value ("[npx] " + $line) -Encoding UTF8
      }
    $ErrorActionPreference = 'Stop'
    Write-Log "npx exited (LASTEXITCODE=$LASTEXITCODE), restarting in 5s..."
    Start-Sleep -Seconds 5
  }
} finally {
  Remove-Item $LockFile -ErrorAction SilentlyContinue
}
