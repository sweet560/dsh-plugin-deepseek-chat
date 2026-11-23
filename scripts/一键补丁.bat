@echo off
rem Portable one-click patcher: no hard-coded paths, no Node.js install needed.
rem Locates DSH automatically via find-dsh.ps1 and uses the node bundled with DSH.
rem All script text is ASCII so it works under ANY console code page (936 / 65001).
rem v2: full on-disk logging, robust process-kill wait, auto-restart, no silent flash-exit.
chcp 936 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion
title DSH persistent-partition patch - one click (portable)

set "FINDER=%~dp0find-dsh.ps1"
set "PATCHER=%~dp0patch-dsh-persistent-partition.cjs"
set "PROC=DeepSeek Harness.exe"
set "DSH_OUT=%TEMP%\dsh_find_%RANDOM%.txt"
set "LOG=%TEMP%\dsh_patch_oneshot.log"

rem ---- Start a fresh log that captures EVERY step (survives any crash) ----
if exist "%LOG%" del "%LOG%" >nul 2>&1
call :log "=== one-click patch started ==="
call :log "Log file: %LOG%"

rem ---- Auto-elevate to administrator ----
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    call :log "[*] Not admin, requesting elevation via UAC..."
    echo [*] Administrator rights required. A UAC prompt / second window may appear.
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait"
    call :log "[*] Elevated instance finished, closing launcher."
    endlocal
    exit /b
)
call :log "[OK] Running with administrator rights."

echo ============================================
echo    DSH persistent-partition patch (one click)
echo ============================================
echo.

rem ---- Locate DSH install (auto; manual folder allowed on failure) ----
:do_detect
call :log "[i] Locating DSH installation automatically..."
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
    call :log "[X] Found app.asar but no usable node.exe - abort"
    echo [X] Found app.asar but no usable node.exe.
    echo     Check the DSH bundled runtime, or install Node.js and add it to PATH.
    goto :end
)

call :log "[X] Auto-detection failed - no DSH install found"
echo.
echo [X] Auto-detection failed: no DSH install with app.asar was found.
echo     Open Start menu -^> DeepSeek Harness -^> Open file location to get the
echo     install folder, then drag that folder into this window or paste its
echo     path and press Enter. Leave empty to retry auto-detection.
set "MANUAL_DSH_DIR="
set /p "MANUAL_DSH_DIR=DSH install folder (Q to quit): "
if /I "!MANUAL_DSH_DIR!"=="Q" goto :end
for %%I in (!MANUAL_DSH_DIR!) do set "MANUAL_DSH_DIR=%%~I"
goto :do_detect

:detect_ok
call :log "[OK] DSH_DIR=%DSH_DIR%"
call :log "[OK] ASAR=%ASAR%"
call :log "[OK] NODE_EXE=%NODE_EXE%"
echo [OK] DSH folder : %DSH_DIR%
echo [OK] app.asar   : %ASAR%
echo [OK] node       : %NODE_EXE%
echo.

rem ---- Environment checks ----
if not exist "%PATCHER%" ( call :log "[X] Patcher not found" & echo [X] Patcher not found: %PATCHER% & goto :end )
if not exist "%ASAR%" ( call :log "[X] app.asar not found" & echo [X] app.asar not found: %ASAR% & goto :end )

rem ---- Close DSH ----
tasklist /FI "IMAGENAME eq %PROC%" 2>nul | findstr /I "%PROC%" >nul
if "%errorlevel%"=="0" (
    call :log "[!] DSH is running, will force-close it"
    echo [!] DSH is running; it must be closed before patching.
    echo     This WILL close all DSH windows, including this chat session - normal, not a crash.
    echo     Press any key to force-close, Ctrl+C to cancel...
    pause >nul
    call :log "[*] Sending taskkill /F"
    taskkill /IM "%PROC%" /F >nul 2>&1
    rem Robust wait via subroutine: ping-based sleep works where 'timeout' fails.
    call :wait_proc
    if "!PROC_GONE!"=="0" (
        call :log "[X] Processes still running after 12 retries - abort"
        echo [X] Processes still running; close them in Task Manager and retry.
        goto :end
    )
    call :log "[OK] DSH closed after wait cycles"
    echo [OK] DSH closed.
) else (
    call :log "[OK] DSH is not running - no close needed"
    echo [OK] DSH is not running.
)
echo.

rem ---- dry-run ----
call :log "[1/2] dry-run verification start"
echo [1/2] Verifying with dry-run...
"%NODE_EXE%" "%PATCHER%" "%ASAR%" --dry-run > "%TEMP%\dsh_patch_dry.log" 2>&1
type "%TEMP%\dsh_patch_dry.log"
findstr /C:"0 failed" "%TEMP%\dsh_patch_dry.log" >nul
if not "%errorlevel%"=="0" ( call :log "[X] dry-run failed - aborted" & echo. & echo [X] dry-run failed; aborted, nothing changed. & goto :end )
call :log "[OK] dry-run passed"
echo [OK] dry-run passed.
echo.

rem ---- Apply ----
call :log "[2/2] applying patch"
echo [2/2] Applying patch...
"%NODE_EXE%" "%PATCHER%" "%ASAR%" > "%TEMP%\dsh_patch_run.log" 2>&1
type "%TEMP%\dsh_patch_run.log"
findstr /C:"0 failed" "%TEMP%\dsh_patch_run.log" >nul
if not "%errorlevel%"=="0" ( call :log "[X] patch reported failures" & echo. & echo [X] Patch reported failures; see output above; a .bak restore is possible. & goto :end )
call :log "[OK] patch apply finished"
findstr /C:"already patched" "%TEMP%\dsh_patch_run.log" >nul
if "%errorlevel%"=="0" ( call :log "[i] target already patched" & echo [i] Target is already patched; nothing to do. ) else ( call :log "[OK] patch written" & echo [OK] Patch written. )
echo.

rem ---- Restart ----
if exist "%APP_EXE%" (
    choice /C YN /M "Start DSH now"
    if "!errorlevel!"=="1" ( start "" "%APP_EXE%" & call :log "[OK] DSH restarted" & echo [OK] DSH started. )
) else (
    echo [i] DSH executable not found; patch is unaffected; please start DSH manually.
)

goto :end

rem ---- Subroutine: wait up to 12 cycles for the DSH process to disappear ----
:wait_proc
set "PROC_GONE=1"
set /a TRY=0
:wait_close
set /a TRY+=1
ping -n 3 127.0.0.1 >nul 2>&1
tasklist /FI "IMAGENAME eq %PROC%" 2>nul | findstr /I "%PROC%" >nul
if "!errorlevel!"=="0" if !TRY! LSS 12 goto :wait_close
if "!errorlevel!"=="0" set "PROC_GONE=0"
goto :eof

:log
echo %~1
echo %~1 >>"%LOG%"
goto :eof

:end
call :log "=== one-click patch finished ==="
if exist "%DSH_OUT%" del "%DSH_OUT%" >nul 2>&1
echo.
echo Done. See log: %LOG%
echo Press any key to close this window.
pause >nul
endlocal
exit /b
