@echo off
chcp 65001 >nul
title 场A上新监控面板
cd /d %~dp0
echo.
echo  ============================================
echo   场A上新监控面板 启动中...
echo   浏览器将自动打开 http://localhost:3210
echo   关闭本窗口 = 停止面板服务
echo  ============================================
echo.
node server.js
pause
