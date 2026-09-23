# ensure-whisper.ps1
# ----------------------------------------------------------------------------
# Гарантирует что openai-whisper-asr-webservice работает и отвечает на
# health-эндпоинте. Скрипт идемпотентен и безопасен — если сервис уже жив,
# выходит за миллисекунды.
#
# Шаги:
#   1. HEAD/GET по -Url. Если 200 — выход 0.
#   2. Поиск docker-контейнера:
#        a) если задан -Container — берём его;
#        b) иначе ищем контейнер с именем/image содержащим "whisper".
#   3. docker start <container>.
#   4. Polling -Url каждые 2с до -TimeoutSec.
#   5. Если контейнер не найден — выход 2 с инструкцией.
#   6. Если контейнер найден но сервис не поднялся за TimeoutSec — выход 3.
#
# Вызывается из src/whisper.ts через
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ensure-whisper.ps1
#     -Url http://localhost:9000/docs -TimeoutSec 90 [-Container whisper]
#
# Логи: всё в stdout/stderr — родительский процесс (bun) их перехватывает
# и складывает в bot.out.log/bot.err.log.
# ----------------------------------------------------------------------------

[CmdletBinding()]
param(
    [string]$Url = "http://localhost:9000/docs",
    [int]$TimeoutSec = 90,
    [string]$Container = ""
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

function Test-WhisperHealth {
    param([string]$U)
    try {
        $resp = Invoke-WebRequest -Uri $U -Method Get -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400)
    } catch {
        return $false
    }
}

function Write-Stamp([string]$msg) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ensure-whisper: $msg"
}

# 1) Quick path: уже жив?
if (Test-WhisperHealth -U $Url) {
    Write-Stamp "service already healthy at $Url"
    exit 0
}

Write-Stamp "service not responding at $Url, looking for docker container..."

# 2) Docker доступен?
# Сначала PATH; если нет (сервис nssm стартовал со старым PATH без Docker) —
# пробуем стандартные пути установки Docker Desktop.
$dockerExe = $null
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if ($dockerCmd) {
    $dockerExe = $dockerCmd.Source
} else {
    $candidates = @(
        "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
        "$env:ProgramData\DockerDesktop\version-bin\docker.exe",
        "$env:LOCALAPPDATA\Docker\wsl\docker.exe"
    )
    foreach ($cand in $candidates) {
        if ($cand -and (Test-Path $cand)) {
            $dockerExe = $cand
            Write-Stamp "docker не в PATH, найден по пути: $cand"
            break
        }
    }
}
if (-not $dockerExe) {
    Write-Error "ensure-whisper: docker.exe не найден ни в PATH, ни по стандартным путям Docker Desktop. Установите Docker Desktop."
    exit 4
}

# Проверяем что Docker daemon отвечает (Docker Desktop может быть не запущен).
$dockerInfo = & $dockerExe info --format "{{.ServerVersion}}" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "ensure-whisper: docker daemon не отвечает. Запустите Docker Desktop. ($dockerInfo)"
    exit 5
}

# 3) Найти контейнер
$targetContainer = $Container
if (-not $targetContainer) {
    # Ищем по имени и image среди ВСЕХ контейнеров (включая stopped).
    # Формат: "<name>|<image>|<status>"
    $rows = & $dockerExe ps -a --format "{{.Names}}|{{.Image}}|{{.Status}}" 2>$null
    if ($LASTEXITCODE -eq 0 -and $rows) {
        # Приоритет: точное имя 'whisper' > image asr-webservice > любой whisper-матч.
        # На машине может быть несколько whisper-контейнеров (например whisper-diarize
        # на 9001) — бот использует именно onerahmet/asr-webservice на 9000.
        $fallbackMatch = $null
        foreach ($row in $rows) {
            $parts = $row -split "\|"
            if ($parts.Count -lt 2) { continue }
            $name  = $parts[0]
            $image = $parts[1]
            if ($name -eq "whisper" -or $image -match "asr-webservice") {
                $targetContainer = $name
                Write-Stamp "matched container '$name' (image: $image)"
                break
            }
            if (-not $fallbackMatch -and ($name -match "whisper" -or $image -match "whisper")) {
                $fallbackMatch = $name
            }
        }
        if (-not $targetContainer -and $fallbackMatch) {
            $targetContainer = $fallbackMatch
            Write-Stamp "matched container '$fallbackMatch' (fallback whisper match)"
        }
    }
}

if (-not $targetContainer) {
    Write-Error @"
ensure-whisper: не найден ни один docker-контейнер с whisper в имени/image.
Возможные причины:
  - контейнер ещё не создан. Создайте, например:
      docker run -d --name whisper -p 9000:9000 ^
        -e ASR_MODEL=medium ^
        onerahmet/openai-whisper-asr-webservice:latest
  - контейнер запущен под нестандартным именем — передайте его явно:
      ensure-whisper.ps1 -Container <containerName>
    или пропишите whisper.containerName в config/settings.json.
"@
    exit 2
}

# 4) Стартуем контейнер (idempotent — docker start уже запущенного — no-op).
Write-Stamp "docker start $targetContainer"
$startOut = & $dockerExe start $targetContainer 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "ensure-whisper: docker start '$targetContainer' failed: $startOut"
    exit 6
}

# 5) Ждём health
Write-Stamp "waiting up to ${TimeoutSec}s for $Url..."
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$attempt = 0
while ((Get-Date) -lt $deadline) {
    $attempt++
    Start-Sleep -Seconds 2
    if (Test-WhisperHealth -U $Url) {
        $elapsed = [int]((Get-Date) - ((Get-Date).AddSeconds(-($attempt * 2)))).TotalSeconds
        Write-Stamp "healthy after $($attempt * 2)s (container '$targetContainer' running)"
        exit 0
    }
}

Write-Error "ensure-whisper: container '$targetContainer' started, but $Url не ответил за ${TimeoutSec}s. Возможно, модель ещё грузится — увеличьте startupTimeoutSeconds или проверьте 'docker logs $targetContainer'."
exit 3
