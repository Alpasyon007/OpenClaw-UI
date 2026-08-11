#!/bin/bash
set -euo pipefail

# Resolve to repo root (one level up from commands/)
cd "$(dirname "$0")/.."

usage() {
  cat <<'USAGE'
OpenClaw UI Bootstrap

Usage:
  ./commands/bootstrap.command

Sets up the environment and builds the renderer. Packaging the full app
(renderer + shim + sidecar + C++ shell) is `npm run dist`, which needs CMake
and a C++ toolchain.

Options:
  -h, --help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo
      usage
      exit 1
      ;;
  esac
  shift
done

echo "OpenClaw UI Bootstrap"
echo "====================="
echo

echo "Step 1/3: Environment setup"
if ! ./commands/setup.command; then
  if [[ -d "node_modules" ]]; then
    echo
    echo "Setup checks failed, but existing dependencies were found."
    echo "Continuing with build using current environment..."
  else
    echo
    echo "Setup failed and no existing dependencies were found."
    echo "Please fix setup issues, then rerun bootstrap."
    exit 1
  fi
fi

echo
echo "Step 2/3: Build"
npm run build

echo
echo "Step 3/3: Doctor check"
npm run doctor || true

echo
echo "Bootstrap complete."
echo "Run: npm run dist    (renderer + shim + sidecar + C++ shell -> release/)"
