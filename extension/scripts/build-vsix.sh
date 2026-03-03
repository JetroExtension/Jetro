#!/usr/bin/env bash
#
# Build a .vsix package from source.
#
# Prerequisites:
#   - Node.js 18+
#   - npm install (in extension/ and mcp-server/ dirs)
#
# Output: extension/jetro-{version}.vsix
#
# Usage: cd extension && bash scripts/build-vsix.sh

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(require('./package.json').version)")

echo "=== Building Jetro v${VERSION} ==="
echo ""

echo "=== Step 1: Build all bundles ==="
npm run package

echo ""
echo "=== Step 2: Create minimal node_modules ==="
bash scripts/prepare-modules.sh

echo ""
echo "=== Step 3: Package VSIX ==="
# Temporarily set prepublish to no-op (already built)
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
pkg.scripts._originalPrepublish = pkg.scripts['vscode:prepublish'];
pkg.scripts['vscode:prepublish'] = 'echo Already built';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

npx @vscode/vsce package --allow-missing-repository

# Restore package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
if (pkg.scripts._originalPrepublish) {
  pkg.scripts['vscode:prepublish'] = pkg.scripts._originalPrepublish;
  delete pkg.scripts._originalPrepublish;
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
}
"

echo ""
echo "=== Step 4: Restore full node_modules ==="
bash scripts/restore-modules.sh

echo ""
echo "=== Done ==="
echo ""
ls -lh "jetro-${VERSION}.vsix"
echo ""
echo "Install locally:"
echo "  code --install-extension jetro-${VERSION}.vsix"
