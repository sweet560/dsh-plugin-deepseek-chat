@echo off
rem Portable rollback: no hard-coded paths, no Node.js install needed.
rem Locates DSH automatically and restores the newest app.asar.bak-* backup.
rem All script text is ASCII so it works under ANY console code page (936 / 65001).
chcp 936 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion
title DSH persistent-partition patch - rollback (portable)

set "FINDER=%~dp0find-dsh.ps1"
set "PATCHER=%~dp0patch-dsh-persistent-partition.cjs"
set "PROC=DeepSeek Harness.exe"
set "DSH_OUT=%TEMP%\dsh_find_%RANDOM%.txt"

rem ---- Auto-elevate to administrator ----
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [*] Administrator rights required, requesting elevation...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ============================================
echo    DSH persistent-partition patch - rollback
echo ============================================
echo.

rem ---- Locate DSH install (auto; manual folder allowed on failure) ----
:do_detect
echo [i] Locating DSH installation automatically...
if exist "%DSH_OUT%" del "%DSH_OUT%" >nul 2>&1
if defined MANUAL_DSH_DIR (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%FINDER%" -OutFile "%DSH_OUT%" -HintDir "%~dp0." -DshDir "!MANUAL_DSH_DIR!"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%FINDER%" -OutFile "%DSH_OUT%" -HintDir "%~dp0."
)
set "DETECT_ERR=!errorlevel!"
if exist "%DSH_OUT%" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%DSH_OUT%") do set "%%A=%%B"
)
if "!DETECT_ERR!"=="0" if defined ASAR if defined NODE_EXE goto :detect_ok

if defined ASAR (
    echo [X] Found app.asar but no usable node.exe.
    echo     Check the DSH bundled runtime, or install Node.js and add it to PATH.
    goto :end
)
echo.
echo [X] Auto-detection failed: no DSH install with app.asar was found.
echo     Open Start menu -^> DeepSeek Harness -^> Open file location to get the
echo     install folder, then drag that folder into this window (or paste its
echo     path) and press Enter. Leave empty to retry auto-detection.
set "MANUAL_DSH_DIR="
set /p "MANUAL_DSH_DIR=DSH install folder (Q to quit): "
if /I "!MANUAL_DSH_DIR!"=="Q" goto :end
for %%I in (!MANUAL_DSH_DIR!) do set "MANUAL_DSH_DIR=%%~I"
goto :do_detect

:detect_ok
echo [OK] DSH folder : %DSH_DIR%
echo [OK] app.asar   : %ASAR%
echo [OK] node       : %NODE_EXE%
echo.

rem ---- Derive folder and file name from ASAR so nothing is typed twice ----
for %%A in ("%ASAR%") do (
    set "ASAR_DIR=%%~dpA"
    set "ASAR_NAME=%%~nxA"
)

rem ---- Environment checks ----
if not exist "%PATCHER%" ( echo [X] Patcher not found: %PATCHER% & echo     Keep this .bat beside the patcher in the scripts folder. & goto :end )
if not exist "%ASAR%" ( echo [X] app.asar not found: %ASAR% & goto :end )

rem ---- Find newest backup (created by the one-click patcher) ----
set "BAK="
for /f "delims=" %%F in ('dir /b /o-d "%ASAR_DIR%%ASAR_NAME%.bak-*" 2^>nul') do (
    if not defined BAK set "BAK=%ASAR_DIR%%%F"
)
if not defined BAK ( echo [X] No backup found (%ASAR_NAME%.bak-*); cannot roll back. & goto :end )

echo [i] Will restore from this newest backup:
echo     %BAK%
for %%A in ("%BAK%") do echo     Size: %%~zA bytes   Modified: %%~tA
echo.
echo [!] This restores app.asar to its pre-patch state; the no-relogin effect is lost.
choice /C YN /M "Confirm rollback"
if "!errorlevel!"=="2" ( echo [i] Cancelled, nothing changed. & goto :end )
echo.

rem ---- Close DSH (copy fails while app.asar is locked) ----
tasklist /FI "IMAGENAME eq %PROC%" 2>nul | findstr /I "%PROC%" >nul
if "%errorlevel%"=="0" (
    echo [!] DSH is running; it must be closed before rollback (unsaved data lost).
    echo     Press any key to force-close, Ctrl+C to cancel...
    pause >nul
    taskkill /IM "%PROC%" /F >nul 2>&1
    timeout /t 2 /nobreak >nul
    tasklist /FI "IMAGENAME eq %PROC%" 2>nul | findstr /I "%PROC%" >nul
    if "!errorlevel!"=="0" ( echo [X] Processes still running; close them in Task Manager and retry. & goto :end )
    echo [OK] DSH closed.
) else (
    echo [OK] DSH is not running.
)
echo.

rem ---- Keep a copy of the current state so a failed rollback can be undone ----
set "KEEP=%ASAR%.pre-rollback"
copy /Y "%ASAR%" "%KEEP%" >nul
if errorlevel 1 ( echo [X] Cannot back up current app.asar; aborted, nothing changed. & goto :end )
echo [OK] Current state saved: %KEEP%
echo.

rem ---- Restore ----
echo [1/2] Overwriting app.asar with the backup...
copy /Y "%BAK%" "%ASAR%" >nul
if errorlevel 1 (
    echo [X] Copy failed, restoring the saved state...
    copy /Y "%KEEP%" "%ASAR%" >nul
    echo [i] Reverted; app.asar is unchanged.
    goto :end
)
echo [OK] Overwritten.

rem ---- Verify via the patcher's dry-run (full ASAR integrity) ----
echo [2/2] Verifying restored app.asar...
"%NODE_EXE%" "%PATCHER%" "%ASAR%" --dry-run > "%TEMP%\dsh_rollback_verify.log" 2>&1
type "%TEMP%\dsh_rollback_verify.log"
findstr /C:"0 failed" "%TEMP%\dsh_rollback_verify.log" >nul
if not "%errorlevel%"=="0" (
    echo.
    echo [X] Verification failed, restoring the saved state...
    copy /Y "%KEEP%" "%ASAR%" >nul
    echo [i] Reverted; app.asar is unchanged. Check the backup file.
    goto :end
)
echo [OK] Verified: ASAR integrity 0 failed, back to pre-patch state.
echo.
echo [i] Backup %BAK% is kept; saved state %KEEP% can be deleted manually
echo     once verified (each is about 209MB).
echo.

rem ---- Restart ----
if exist "%APP_EXE%" (
    choice /C YN /M "Start DSH now"
    if "!errorlevel!"=="1" ( start "" "%APP_EXE%" & echo [OK] DSH started. )
) else (
    echo [i] DSH executable not found (rollback is unaffected); please start DSH manually.
)

:end
if exist "%DSH_OUT%" del "%DSH_OUT%" >nul 2>&1
echo.
echo Done. Press any key to close this window.
pause >nul
endlocal
