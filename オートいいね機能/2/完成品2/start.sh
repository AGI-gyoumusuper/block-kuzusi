#!/usr/bin/env sh
cd "$(dirname "$0")"
exec node --disable-warning=ExperimentalWarning src/cli2.js serve "$@"
