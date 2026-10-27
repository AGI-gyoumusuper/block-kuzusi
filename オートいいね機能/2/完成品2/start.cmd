@echo off
rem フォルダ2 起動入口（Windows）。既定はモック + ドライラン、フォロー返し OFF
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning src\cli2.js serve %*
