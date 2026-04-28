#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Add Internal Note to Front
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🗒
# @raycast.argument1 { "type": "text", "placeholder": "Note text (required)" }
# @raycast.argument2 { "type": "text", "placeholder": "Conversation ID or URL (default: active tab)", "optional": true }

# Documentation:
# @raycast.description Post an internal comment to the current Front conversation via API. Used standalone (replaces /tr or /ta typing) or wired into bolt-admin to log token reset / allocation results automatically.
# @raycast.author jorrit_harmamny
# @raycast.authorURL https://raycast.com/jorrit_harmamny

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/front-api.sh
source "$SCRIPT_DIR/lib/front-api.sh"

NOTE_TEXT="${1:-}"
CNV_HINT="${2:-}"

if [[ -z "$NOTE_TEXT" ]]; then
  echo "❌ Note text is required."
  exit 1
fi

# Resolve conversation id: explicit arg → extract from arg if URL → active tab.
cnv_id=""
if [[ -n "$CNV_HINT" ]]; then
  if [[ "$CNV_HINT" =~ ^cnv_[A-Za-z0-9]+$ ]]; then
    cnv_id="$CNV_HINT"
  else
    cnv_id=$(front_extract_cnv "$CNV_HINT" || true)
  fi
fi

if [[ -z "$cnv_id" ]]; then
  active_url=$(front_active_chrome_url || true)
  if [[ -n "${active_url:-}" ]]; then
    cnv_id=$(front_extract_cnv "$active_url" || true)
  fi
fi

if [[ -z "$cnv_id" ]]; then
  echo "❌ Could not determine conversation. Pass an ID/URL or open Front in Chrome."
  exit 1
fi

# POST the comment with NO author_id. For company-level API tokens (the
# common case), Front rejects `author_id: cmp_xxx` with 400 — looking up a
# real teammate id requires the `teammates:read` scope which the briefing
# token deliberately omits. Omitting author_id makes Front auto-attribute
# to the token's implicit `tea_xxx` teammate, which lands the comment on
# the conversation thread correctly.
payload=$(NOTE="$NOTE_TEXT" python3 -c '
import json, os, sys
print(json.dumps({"body": os.environ["NOTE"]}))
')

response=$(front_curl POST "/conversations/$cnv_id/comments" --data "$payload")

# Successful POST returns the comment object with an id. Errors return a JSON
# object with `_error` / status.
ok=$(printf '%s' "$response" | python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
except Exception:
    print("BADJSON")
    sys.exit()
if data.get("id"):
    print("OK")
else:
    print("ERR:" + json.dumps(data)[:200])
')

case "$ok" in
  OK)
    echo "✅ Note posted to $cnv_id"
    ;;
  ERR:*)
    echo "❌ Front API error: ${ok#ERR:}"
    exit 1
    ;;
  *)
    echo "❌ Unexpected response. Raw: $(printf '%s' "$response" | head -c 200)"
    exit 1
    ;;
esac
