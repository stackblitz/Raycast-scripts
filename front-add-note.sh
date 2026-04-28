#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Add Note to Front Contact
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🗒
# @raycast.argument1 { "type": "text", "placeholder": "Note text (required)" }
# @raycast.argument2 { "type": "text", "placeholder": "Conversation URL, cnv_/crd_ ID, or email (default: active tab)", "optional": true }

# Documentation:
# @raycast.description Post a note to a Front contact's profile via API. Used standalone (replaces /tr or /ta typing) or wired into bolt-admin to log token allocations automatically. Notes attach to the contact, so they persist across all of that customer's conversations.
# @raycast.author jorrit_harmamny
# @raycast.authorURL https://raycast.com/jorrit_harmamny

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/front-api.sh
source "$SCRIPT_DIR/lib/front-api.sh"

NOTE_TEXT="${1:-}"
TARGET_HINT="${2:-}"

if [[ -z "$NOTE_TEXT" ]]; then
  echo "❌ Note text is required."
  exit 1
fi

# Resolve target → contact id. Sources, in order:
#   1. Explicit arg ($TARGET_HINT) — URL / cnv / crd / email
#   2. Active Chrome tab URL
target=""
if [[ -n "$TARGET_HINT" ]]; then
  target="$TARGET_HINT"
fi
if [[ -z "$target" ]]; then
  target=$(front_active_chrome_url || true)
fi

if [[ -z "$target" ]]; then
  echo "❌ Could not determine target. Pass a URL, conversation/contact ID, or email — or open Front in Chrome."
  exit 1
fi

contact_id=$(front_resolve_contact_id "$target" || true)
if [[ -z "$contact_id" ]]; then
  echo "❌ Could not resolve a Front contact from: $target"
  exit 1
fi

# Resolve the human teammate to credit as author. Front rejects api/bot
# teammates here, so this must be a real `tea_xxx` for type=user.
author_id=$(front_author_id || true)
if [[ -z "$author_id" || ! "$author_id" =~ ^tea_ ]]; then
  echo "❌ Could not resolve author teammate. Set FRONT_AUTHOR_ID or FRONT_AUTHOR_EMAIL in cx-briefing/.env."
  exit 1
fi

payload=$(NOTE="$NOTE_TEXT" AUTHOR="$author_id" python3 -c '
import json, os
print(json.dumps({"author_id": os.environ["AUTHOR"], "body": os.environ["NOTE"]}))
')

response=$(front_curl POST "/contacts/$contact_id/notes" --data "$payload")

# Front returns the note object on success (no top-level id field for contact
# notes — quirky but documented). Treat presence of `body` echoed back as
# success, otherwise surface the `_error` payload.
ok=$(printf '%s' "$response" | python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
except Exception:
    print("BADJSON")
    sys.exit()
if data.get("_error"):
    err = data["_error"]
    print("ERR:" + (err.get("message") or json.dumps(err))[:200])
elif data.get("body") is not None:
    print("OK")
else:
    print("ERR:Unexpected response shape")
')

case "$ok" in
  OK)
    echo "✅ Note added to contact $contact_id (author $author_id)"
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
