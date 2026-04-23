#!/usr/bin/env bash
# Build the dashboard and rsync to a remote host.
#
# Reads DEPLOY_HOST and DEPLOY_PATH from .env at the repo root.
# See .env.example.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

: "${DEPLOY_HOST:?DEPLOY_HOST is not set. Copy .env.example to .env and fill it in.}"
: "${DEPLOY_PATH:?DEPLOY_PATH is not set. Copy .env.example to .env and fill it in.}"

echo "→ Building..."
npm run build

echo "→ Uploading to ${DEPLOY_HOST}:${DEPLOY_PATH}"
rsync -az --delete build/ "${DEPLOY_HOST}:${DEPLOY_PATH}"

echo "✓ Deployed."
