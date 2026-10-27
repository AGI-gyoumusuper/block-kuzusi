#!/usr/bin/env sh
# フォルダ1 起動入口。既定はモック + ドライラン
cd "$(dirname "$0")"
exec node --disable-warning=ExperimentalWarning src/cli.js serve "$@"
