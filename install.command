#!/bin/sh
set -eu
fmv_install_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$fmv_install_root"
exec node scripts/install-local.mjs "$@"
