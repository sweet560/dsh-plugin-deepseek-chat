param(
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$HintDir,
    [string]$DshDir
)

# Locate a DSH Desktop installation on this machine without hard-coded paths.
# Outputs KEY=VALUE lines (ANSI / system code page) for the .bat wrappers.
# Exit 0 when both app.asar and a usable node were found, 1 otherwise.

$ErrorActionPreference = 'SilentlyContinue'
$exeName = 'DeepSeek Harness.exe'
$candidates = New-Object System.Collections.Generic.List[string]

function Add-Candidate([string]$path) {
    if ($path) { [void]$candidates.Add($path) }
}

# 0) A directory the user typed in (highest priority).
#     Drag-and-drop into a cmd window usually leaves surrounding quotes.
if ($DshDir) {
    $cleanDir = $DshDir.Trim().Trim('"')
    Add-Candidate (Join-Path $cleanDir $exeName)
}

# 1) Windows uninstall registry entries (HKLM / HKCU / WOW6432Node).
$hives = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($hive in $hives) {
    Get-ItemProperty -Path $hive | Where-Object { $_.DisplayName -like '*DeepSeek Harness*' } | ForEach-Object {
        if ($_.InstallLocation) { Add-Candidate (Join-Path $_.InstallLocation $exeName) }
        if ($_.DisplayIcon) { Add-Candidate (($_.DisplayIcon -split ',\d+$')[0]) }
    }
}

# 2) A running DSH process (most reliable when the app is open).
Get-Process -Name 'DeepSeek Harness' | ForEach-Object { Add-Candidate $_.Path }

# 3) Common install roots.
$roots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs'),
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:LOCALAPPDATA,
    $env:APPDATA
)
foreach ($root in $roots) {
    if ($root) { Add-Candidate (Join-Path (Join-Path $root 'DeepSeek Harness') $exeName) }
}

# 3b) Portable / non-installed builds: scan the first level of every drive.
#     This covers a DSH folder with an arbitrary name at any drive root.
Get-PSDrive -PSProvider FileSystem | ForEach-Object {
    $driveRoot = $_.Root
    foreach ($name in @('DeepSeek Harness', 'DeepSeekHarness')) {
        Add-Candidate (Join-Path (Join-Path $driveRoot $name) $exeName)
    }
    Get-ChildItem -LiteralPath $driveRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Add-Candidate (Join-Path $_.FullName $exeName)
    }
}

# 4) Walk up from the plugin's own folder (plugin may live inside the DSH tree).
if ($HintDir) {
    $dir = [System.IO.Path]::GetFullPath($HintDir)
    for ($i = 0; $i -lt 8 -and $dir; $i++) {
        Add-Candidate (Join-Path $dir $exeName)
        $dir = Split-Path -Parent $dir
    }
}

$appExe = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) {
        $appExe = (Resolve-Path -LiteralPath $c).Path
        break
    }
}
$dshDir = $null
if ($appExe) { $dshDir = Split-Path -Parent $appExe }

# app.asar sits in <install dir>\resources\app.asar
$asar = $null
if ($dshDir) {
    $p = Join-Path $dshDir 'resources\app.asar'
    if (Test-Path -LiteralPath $p -PathType Leaf) { $asar = (Resolve-Path -LiteralPath $p).Path }
}
# Fallback: find resources\app.asar directly while walking up from the plugin folder.
if (-not $asar -and $HintDir) {
    $dir = [System.IO.Path]::GetFullPath($HintDir)
    for ($i = 0; $i -lt 8 -and $dir; $i++) {
        $p = Join-Path $dir 'resources\app.asar'
        if (Test-Path -LiteralPath $p -PathType Leaf) {
            $asar = (Resolve-Path -LiteralPath $p).Path
            $dshDir = $dir
            break
        }
        $dir = Split-Path -Parent $dir
    }
}

# Prefer the node bundled with DSH, so nothing has to be installed on a new PC.
$nodeExe = $null
if ($dshDir) {
    $n = Join-Path $dshDir 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $n -PathType Leaf) { $nodeExe = (Resolve-Path -LiteralPath $n).Path }
}
if (-not $nodeExe) {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $nodeExe = $cmd.Source }
}

# Paths are ASCII; use the system ANSI code page so the .bat wrappers can
# parse the file with for /f regardless of the console code page in use.
try { $enc = [System.Text.Encoding]::GetEncoding(936) }
catch { $enc = [System.Text.Encoding]::Default }
$lines = @(
    ('ASAR=' + $(if ($asar) { $asar } else { '' })),
    ('APP_EXE=' + $(if ($appExe) { $appExe } else { '' })),
    ('NODE_EXE=' + $(if ($nodeExe) { $nodeExe } else { '' })),
    ('DSH_DIR=' + $(if ($dshDir) { $dshDir } else { '' }))
)
[System.IO.File]::WriteAllLines($OutFile, [string[]]$lines, $enc)

if (-not $asar -or -not $nodeExe) { exit 1 }
exit 0
