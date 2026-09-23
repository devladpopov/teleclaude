# Director infrastructure doctor.
# ----------------------------------------------------------------------------
# Validates everything that should be true for the system to be considered
# healthy. Returns:
#   exit 0 -- all green
#   exit 1 -- warnings (non-critical, but worth knowing)
#   exit 2 -- critical issues (router/runner down, malformed state files)
#
# Usage:
#   scripts\doctor.cmd            (silent mode, exit code only)
#   scripts\doctor.ps1 -Verbose   (full output)
#
# Run by:
#   - the owner manually after a deploy
#   - watchdog.ps1 after a successful restart (smoke test)
#   - pre-commit hook (planned)
# ----------------------------------------------------------------------------

[CmdletBinding()]
param(
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$exitCode = 0
$warnings = @()
$errors = @()

function Write-Doctor {
  param([string]$Level, [string]$Msg)
  if ($Quiet) { return }
  $color = switch ($Level) {
    'OK'   { 'Green' }
    'WARN' { 'Yellow' }
    'FAIL' { 'Red' }
    default { 'White' }
  }
  $tag = "[$Level]".PadRight(8)
  Write-Host $tag -NoNewline -ForegroundColor $color
  Write-Host " $Msg"
}

function Check-JsonFile {
  param([string]$RelPath, [int]$MinBytes, [string[]]$RequiredKeys = @(), [switch]$AllowNdjson)
  $full = Join-Path $ProjectRoot $RelPath
  if (-not (Test-Path $full)) {
    Write-Doctor 'FAIL' "$RelPath -- does not exist"
    $script:errors += "$RelPath missing"
    return
  }
  $size = (Get-Item $full).Length
  if ($size -lt $MinBytes) {
    Write-Doctor 'FAIL' "$RelPath -- $size bytes (< $MinBytes minimum). Possible corruption."
    $script:errors += "$RelPath truncated ($size B)"
    return
  }
  $raw = $null
  try {
    $raw = [System.IO.File]::ReadAllText($full)
  } catch {
    Write-Doctor 'FAIL' "$RelPath -- read failed: $($_.Exception.Message)"
    $script:errors += "$RelPath unreadable"
    return
  }
  # NDJSON path -- try parsing first non-empty line.
  if ($AllowNdjson) {
    $firstLine = ($raw -split "`r?`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
    if ($null -ne $firstLine -and $firstLine.TrimStart().StartsWith('{') -and -not $firstLine.Contains('"events":')) {
      try {
        $null = $firstLine | ConvertFrom-Json
        Write-Doctor 'OK' "$RelPath -- $size bytes, NDJSON, first line parses"
        return
      } catch {
        Write-Doctor 'FAIL' "$RelPath -- NDJSON first line parse failed: $($_.Exception.Message)"
        $script:errors += "$RelPath malformed NDJSON"
        return
      }
    }
    # else fall through to JSON parsing
  }
  $parsed = $null
  try {
    $parsed = $raw | ConvertFrom-Json
  } catch {
    Write-Doctor 'FAIL' "$RelPath -- JSON parse failed: $($_.Exception.Message)"
    $script:errors += "$RelPath malformed JSON"
    return
  }
  foreach ($key in $RequiredKeys) {
    if (-not $parsed.PSObject.Properties.Name -contains $key) {
      Write-Doctor 'WARN' "$RelPath -- missing key '$key'"
      $script:warnings += "$RelPath missing key $key"
    }
  }
  Write-Doctor 'OK' "$RelPath -- $size bytes, JSON parses, has $(if ($RequiredKeys.Count -gt 0) { $RequiredKeys -join ', ' } else { 'no required keys to check' })"
}

# ─── Section 1: state-critical files ────────────────────────────────
Write-Doctor 'INFO' '── State files ──'
Check-JsonFile -RelPath 'config/topics.json'              -MinBytes 5000  -RequiredKeys @('groups','topics')
Check-JsonFile -RelPath 'config/director-registry.json'   -MinBytes 10000 -RequiredKeys @('topics','generatedAt')
Check-JsonFile -RelPath 'config/director-dashboard.json'  -MinBytes 5000  -RequiredKeys @('topics','lastScan')
Check-JsonFile -RelPath 'config/director-events.json'     -MinBytes 1     -AllowNdjson
Check-JsonFile -RelPath 'config/settings.json'            -MinBytes 100   -RequiredKeys @('processes')
Check-JsonFile -RelPath 'config/accounts.json'            -MinBytes 100

# ─── Section 2: process health ──────────────────────────────────────
Write-Doctor 'INFO' '── Processes ──'
$pidFile = Join-Path $ProjectRoot '.router.pid'
if (Test-Path $pidFile) {
  $pidVal = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1) -as [int]
  if ($pidVal -and (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) {
    Write-Doctor 'OK' "Router process alive: PID $pidVal"
  } else {
    Write-Doctor 'FAIL' "Router PID $pidVal in .router.pid but process is DEAD"
    $errors += 'router DEAD'
  }
} else {
  Write-Doctor 'WARN' '.router.pid missing (router never started?)'
  $warnings += 'no .router.pid'
}

# Runner /health
try {
  $runnerHealth = Invoke-RestMethod -Uri 'http://localhost:7884/health' -TimeoutSec 5 -ErrorAction Stop
  if ($runnerHealth.ok) {
    $upMin = [math]::Round($runnerHealth.uptime / 60000)
    Write-Doctor 'OK' "Runner /health on :7884 -- uptime ${upMin}m, totalJobs=$($runnerHealth.totalJobs), activeJobs=$($runnerHealth.activeJobs)"
  } else {
    Write-Doctor 'WARN' "Runner /health responded but ok=false"
    $warnings += 'runner ok=false'
  }
} catch {
  Write-Doctor 'FAIL' "Runner /health on :7884 -- unreachable: $($_.Exception.Message)"
  $errors += 'runner unreachable'
}

# Router /health (Layer 3 -- may not be live until that ships)
try {
  $routerHealth = Invoke-RestMethod -Uri 'http://localhost:7885/health' -TimeoutSec 5 -ErrorAction Stop
  if ($routerHealth.ok) {
    $tickAge = if ($routerHealth.lastTickAt) {
      "${([math]::Round(((Get-Date).ToUniversalTime() - [DateTime]::Parse($routerHealth.lastTickAt).ToUniversalTime()).TotalMinutes))}m ago"
    } else { 'never' }
    Write-Doctor 'OK' "Router /health on :7885 -- lastTick $tickAge, tickCount=$($routerHealth.tickCount), totalTopics=$($routerHealth.totalTopics)"
  } else {
    Write-Doctor 'WARN' "Router /health on :7885 responded but ok=false"
    $warnings += 'router /health ok=false'
  }
} catch {
  Write-Doctor 'WARN' "Router /health on :7885 -- not yet implemented or unreachable"
  $warnings += 'router /health unreachable'
}

# ─── Section 3: log freshness ───────────────────────────────────────
Write-Doctor 'INFO' '── Log freshness ──'
$botLog = Join-Path $ProjectRoot 'bot.out.log'
if (Test-Path $botLog) {
  $ageMin = [math]::Round(((Get-Date) - (Get-Item $botLog).LastWriteTime).TotalMinutes)
  if ($ageMin -lt 30) {
    Write-Doctor 'OK' "bot.out.log -- ${ageMin}m old"
  } elseif ($ageMin -lt 60) {
    Write-Doctor 'WARN' "bot.out.log -- ${ageMin}m old (no recent activity?)"
    $warnings += "bot.out.log stale ${ageMin}m"
  } else {
    Write-Doctor 'FAIL' "bot.out.log -- ${ageMin}m old (router silent for too long)"
    $errors += "bot.out.log stale ${ageMin}m"
  }
}

# Last "Scan complete" line
$scanLine = Get-Content $botLog -ErrorAction SilentlyContinue | Select-String 'Scan complete' | Select-Object -Last 1
if ($scanLine) {
  Write-Doctor 'OK' "Last Director scan logged: $($scanLine.Line.Trim() | Select-Object -First 1)"
} else {
  Write-Doctor 'WARN' 'No "Scan complete" line found in bot.out.log'
  $warnings += 'no scan log'
}

# ─── Section 4: file backups ────────────────────────────────────────
Write-Doctor 'INFO' '── Backup chain (.bak.N from safe-fs) ──'
foreach ($f in @('config/topics.json', 'config/director-registry.json')) {
  $haveBaks = @()
  for ($k = 1; $k -le 3; $k++) {
    $b = Join-Path $ProjectRoot "$f.bak.$k"
    if (Test-Path $b) { $haveBaks += "bak.$k=$([math]::Round((Get-Item $b).Length / 1024))KB" }
  }
  if ($haveBaks.Count -eq 0) {
    Write-Doctor 'WARN' "$f -- no rotated backups yet (will appear after first safe-fs write)"
  } else {
    Write-Doctor 'OK' "$f -- rotated backups: $($haveBaks -join ', ')"
  }
}

# ─── Summary ────────────────────────────────────────────────────────
Write-Doctor 'INFO' '── Summary ──'
if ($errors.Count -gt 0) {
  Write-Doctor 'FAIL' "$($errors.Count) critical issue(s):"
  foreach ($e in $errors) { Write-Doctor 'FAIL' "  • $e" }
  $exitCode = 2
}
if ($warnings.Count -gt 0) {
  if ($Quiet) { } else {
    Write-Doctor 'WARN' "$($warnings.Count) warning(s):"
    foreach ($w in $warnings) { Write-Doctor 'WARN' "  • $w" }
  }
  if ($exitCode -lt 1) { $exitCode = 1 }
}
if ($exitCode -eq 0) {
  Write-Doctor 'OK' 'All checks green.'
}

exit $exitCode
