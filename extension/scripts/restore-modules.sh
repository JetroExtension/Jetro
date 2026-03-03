#!/usr/bin/env bash
#
# Restore the full node_modules after VSIX packaging.
#
# Usage: bash scripts/restore-modules.sh

set -euo pipefail

if [ -d "node_modules_full" ]; then
  rm -rf node_modules
  mv node_modules_full node_modules
  echo "=== Full node_modules restored ==="
else
  echo "=== No backup found (node_modules_full doesn't exist) ==="
fi
