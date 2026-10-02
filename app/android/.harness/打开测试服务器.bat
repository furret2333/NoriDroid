@echo off
cd /d "%~dp0"
title NoriDroid Harness Server
echo ==================================================
echo  NoriDroid harness server
echo  (close this window to stop the server)
echo.
echo  ^>^>^> 摘要自测页 : http://127.0.0.1:8123/sumtest   ^(有「开始测试」按钮^)
echo  App UI     : http://127.0.0.1:8123/assets/web/index.html
echo  Smoke      : http://127.0.0.1:8123/   (title == SMOKE-OK = pass)
echo ==================================================
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8123/sumtest'"
node server.mjs
echo.
echo Server stopped.
pause
