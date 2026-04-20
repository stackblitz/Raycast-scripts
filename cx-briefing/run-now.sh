#!/usr/bin/env bash
# Run the CX briefing immediately, loading keys from .env
# Usage: bash run-now.sh [--hours=8] [--slack-json=…] [--serve] [--serve=4080]
#   --serve  → http://127.0.0.1:3751/ with “Fetch again” in the dashboard header (Ctrl+C to stop)
#   --hours=48 --search=keyword   # custom time + substring (Front subject / Slack text / Sentry title)
#   --scope=slack --search=refund # Slack-only slice
#   --scope=linear                # Linear bugs only (LINEAR_API_KEY + LINEAR_TEAM_IDS)

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
