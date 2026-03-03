#!/usr/bin/env bash
#
# Prepare a minimal node_modules for VSIX packaging.
#
# Moves the full node_modules aside, creates a stripped version with only
# the runtime-required native modules + their transitive deps.
#
# Usage: bash scripts/prepare-modules.sh

set -euo pipefail

KEEP_PACKAGES=(
  # Native module: DuckDB (NAPI — ABI-stable, no per-Electron builds)
  "@duckdb/node-api"
  "@duckdb/node-bindings"
  # Platform-specific NAPI bindings (optional deps, only the matching one exists)
  "@duckdb/node-bindings-darwin-arm64"
  "@duckdb/node-bindings-darwin-x64"
  "@duckdb/node-bindings-linux-x64"
  "@duckdb/node-bindings-win32-x64"
  # Native module: node-pty
  "node-pty"
  "node-addon-api"
)

echo "=== Preparing minimal node_modules for VSIX ==="

# 1. Back up current node_modules
if [ -d "node_modules_full" ]; then
  echo "  Restoring previous backup first..."
  rm -rf node_modules
  mv node_modules_full node_modules
fi

mv node_modules node_modules_full
mkdir -p node_modules

# 2. Copy only the packages we need
for pkg in "${KEEP_PACKAGES[@]}"; do
  src="node_modules_full/$pkg"
  if [ -d "$src" ]; then
    dest="node_modules/$pkg"
    mkdir -p "$(dirname "$dest")"
    cp -R "$src" "$dest"
    echo "  + $pkg"
  else
    echo "  - $pkg (not on this platform, skipping)"
  fi
done

# 3. Report
echo ""
echo "=== Minimal node_modules ready ==="
du -sh node_modules/
echo ""
echo "Packages:"
ls -d node_modules/*/ node_modules/@*/*/ 2>/dev/null | sed 's|node_modules/||; s|/$||'
