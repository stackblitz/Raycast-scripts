#!/usr/bin/env bash
# Run the CX briefing immediately, loading keys from .env
# Usage: bash run-now.sh [--hours=8]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌  No .env found. Copy .env.example → .env and fill in your keys."
  exit 1
fi

# Load .env
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

echo "⚡ Running CX Briefing..."
node "$SCRIPT_DIR/index.js" "$@"
