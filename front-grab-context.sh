#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Grab Front Conversation Context
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 📝
# @raycast.argument1 { "type": "text", "placeholder": "Number of recent messages (default 5)", "optional": true }

# Documentation:
# @raycast.description Pull the most recent customer message(s) from the active Front conversation in Chrome and copy to the clipboard. Eliminates the manual "copy email content first" step before Reply with AI.
# @raycast.author jorrit_harmamny
# @raycast.authorURL https://raycast.com/jorrit_harmamny

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/front-api.sh
source "$SCRIPT_DIR/lib/front-api.sh"

LIMIT_INPUT="${1:-5}"
if ! [[ "$LIMIT_INPUT" =~ ^[1-9][0-9]?$ ]]; then
  LIMIT_INPUT=5
fi

active_url=$(front_active_chrome_url || true)
if [[ -z "${active_url:-}" ]]; then
  echo "❌ No browser window found. Open a Front conversation in Chrome first."
  exit 1
fi

cnv_id=$(front_extract_cnv "$active_url" || true)
if [[ -z "${cnv_id:-}" ]]; then
  echo "❌ No Front conversation in active tab."
  echo "URL: $active_url"
  exit 1
fi

# Fetch the most recent N messages. Front returns newest first by default; we
# request a few extra so we have headroom to filter to inbound only.
fetch_count=$(( LIMIT_INPUT * 3 ))
if (( fetch_count > 50 )); then fetch_count=50; fi

response=$(front_curl GET "/conversations/$cnv_id/messages?limit=$fetch_count")
if [[ -z "$response" ]] || ! printf '%s' "$response" | python3 -c 'import json,sys;json.loads(sys.stdin.read())' 2>/dev/null; then
  echo "❌ Front API returned no/invalid JSON for $cnv_id"
  printf '%s' "$response" | head -c 200 >&2
  exit 1
fi

formatted=$(printf '%s' "$response" | LIMIT="$LIMIT_INPUT" CNV="$cnv_id" python3 - <<'PY'
import html
import json
import os
import re
import sys

data = json.loads(sys.stdin.read())
messages = data.get('_results') or []
limit = int(os.environ.get('LIMIT', '5'))

# Front returns the conversation thread; keep only inbound (customer) messages
# in display order (oldest → newest among the kept ones).
inbound = [m for m in messages if m.get('is_inbound')]
if not inbound:
    print('NO_INBOUND', file=sys.stderr)
    sys.exit(0)

inbound.sort(key=lambda m: m.get('created_at') or 0)
selected = inbound[-limit:]


def strip_html(s: str) -> str:
    if not s:
        return ''
    # Drop common block tags first so we get paragraph breaks, then drop the rest.
    s = re.sub(r'</(p|div|br|li|h[1-6])\s*/?>', '\n', s, flags=re.IGNORECASE)
    s = re.sub(r'<br\s*/?>', '\n', s, flags=re.IGNORECASE)
    s = re.sub(r'<[^>]+>', '', s)
    return html.unescape(s).strip()


parts = []
for m in selected:
    sender = (m.get('author') or {}).get('email') or (m.get('author') or {}).get('username') or 'unknown'
    body = m.get('text') or strip_html(m.get('body') or '')
    body = re.sub(r'\n{3,}', '\n\n', body or '').strip()
    parts.append(f'--- from {sender} ---\n{body}')

print('\n\n'.join(parts))
PY
) || true

if [[ -z "$formatted" ]]; then
  echo "❌ No inbound messages in conversation $cnv_id"
  exit 1
fi

printf '%s' "$formatted" | pbcopy

# Echo a short summary so Raycast shows a HUD with the result.
chars=$(printf '%s' "$formatted" | wc -c | tr -d ' ')
echo "📋 Copied $chars chars from $cnv_id"
