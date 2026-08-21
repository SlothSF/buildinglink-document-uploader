@echo off
cd /d "%~dp0"

echo ===============================================================
echo   BuildingLink Document Upload
echo ===============================================================
echo.
echo   TWO WAYS TO RUN:
echo.
echo     [TEST MODE]  node upload.js
echo                  Processes ONE of each file type, then stops
echo                  for your review. Safe default - nothing runs
echo                  by accident.
echo.
echo     [FULL MODE]  node upload.js --all
echo                  Processes ALL files in the folder to completion.
echo.
echo ===============================================================
echo.
echo   Launching TEST MODE (node upload.js)...
echo   For FULL MODE, close this and run:  node upload.js --all
echo.

node upload.js
pause
