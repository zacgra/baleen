#!/usr/bin/env bash
set -euo pipefail

echo "=== Compile ==="
bun run compile

echo "=== Lint ==="
bun run lint

echo "=== VS Code Integration Tests ==="
bun run test
