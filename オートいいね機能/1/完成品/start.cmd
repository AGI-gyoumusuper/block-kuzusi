@echo off
rem フォルダ1 起動入口（Windows）。既定はモック + ドライラン。実 note へ接続するには --adapter=note を付ける
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning src\cli.js serve %*
