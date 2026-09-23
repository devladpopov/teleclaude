# setup-document-skills.ps1
#
# One-time bootstrap for document-processing skills used by the local
# Claude Code runner inside claude-topic-router.
#
# What it does:
#   1. Extracts scripts/.skills-payload/claude-skills.tar.gz (pdf/docx/xlsx/pptx)
#      into $env:USERPROFILE\.claude\skills\ as user-level skills.
#   2. Installs the Python dependencies that the skills' SKILL.md files
#      rely on (pypdf, pdfplumber, python-docx, openpyxl, python-pptx,
#      reportlab, markitdown, mammoth).
#   3. Verifies `python`, `tar`, and the target skills directory are in place.
#
# Run once:
#   pwsh -ExecutionPolicy Bypass -File scripts\setup-document-skills.ps1
#
# Safe to re-run: extraction overwrites existing skill folders, pip upgrades.

$ErrorActionPreference = "Stop"
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot   = Split-Path -Parent $PSScriptRoot
$payload    = Join-Path $repoRoot "scripts\.skills-payload\claude-skills.tar.gz"
$skillsRoot = Join-Path $env:USERPROFILE ".claude\skills"

Write-Host "[setup-document-skills] repo root: $repoRoot"
Write-Host "[setup-document-skills] payload  : $payload"
Write-Host "[setup-document-skills] target   : $skillsRoot"

if (-not (Test-Path $payload)) {
    Write-Error "Payload not found at $payload. Ask the Cowork agent to regenerate it."
    exit 1
}

# --- 1. Ensure target dir ---
if (-not (Test-Path $skillsRoot)) {
    New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null
    Write-Host "[setup-document-skills] created $skillsRoot"
}

# --- 2. Extract tarball (Windows 10+ has bsdtar via 'tar') ---
Write-Host "[setup-document-skills] extracting skills..."
tar -xzf $payload -C $skillsRoot
if ($LASTEXITCODE -ne 0) {
    Write-Error "tar -xzf failed with exit code $LASTEXITCODE"
    exit 1
}

foreach ($s in @("pdf", "docx", "xlsx", "pptx")) {
    $skillMd = Join-Path $skillsRoot "$s\SKILL.md"
    if (Test-Path $skillMd) {
        Write-Host "  [ok] $s  ->  $skillMd"
    } else {
        Write-Warning "  [MISS] $s SKILL.md not found at $skillMd"
    }
}

# --- 3. Python deps ---
Write-Host "[setup-document-skills] installing Python deps..."
$pythonCmd = $null
foreach ($cand in @("python", "py")) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $pythonCmd = $cand; break }
}
if (-not $pythonCmd) {
    Write-Warning "Python not found in PATH. Skipping deps. Install Python 3.11+ and rerun."
} else {
    Write-Host "  using: $pythonCmd"
    & $pythonCmd -m pip install --user --upgrade `
        pypdf `
        pdfplumber `
        pymupdf `
        python-docx `
        openpyxl `
        python-pptx `
        reportlab `
        markitdown `
        mammoth
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "pip install returned $LASTEXITCODE. Re-run or install manually."
    }
}

Write-Host ""
Write-Host "[setup-document-skills] done."
Write-Host "Skills available to 'claude -p' via user-level discovery at:"
Write-Host "  $skillsRoot"
Write-Host ""
Write-Host "Restart the router (pm2 / watchdog / start-router.cmd) to pick up changes."
