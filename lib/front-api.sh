#!/bin/bash
# Front API helpers shared by front-*.sh scripts.
#
# Source this from a bash script:
#   source "$(cd "$(dirname "$0")" && pwd)/lib/front-api.sh"
#
# Then call:
#   front_api_key                  → echoes FRONT_API_KEY (errors if missing)
#   front_active_chrome_url        → echoes URL of active Chrome tab (or empty)
#   front_extract_cnv "<url>"      → echoes cnv_xxx if present in url, else empty
#   front_curl <method> <path> ... → curl wrapper that auto-injects auth + base URL
#
# This file deliberately does NOT enable `set -euo pipefail` so the calling
# script can choose its own error mode without interference.

# Repo root = parent of this lib/ directory. Fall back to $0 when BASH_SOURCE
# is unset (e.g. when sourced from a non-bash shell during dry-run testing).
FRONT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
FRONT_REPO_ROOT="$(cd "$FRONT_LIB_DIR/.." && pwd)"
FRONT_ENV_FILE="$FRONT_REPO_ROOT/cx-briefing/.env"
FRONT_API_BASE="https://api2.frontapp.com"

front_api_key() {
  if [[ ! -f "$FRONT_ENV_FILE" ]]; then
    echo "front-api: missing env file at $FRONT_ENV_FILE" >&2
    return 1
  fi
  # Strip optional surrounding quotes; first match wins so duplicates don't matter.
  local raw
  raw=$(grep -E '^FRONT_API_KEY=' "$FRONT_ENV_FILE" | head -n1 | sed 's/^FRONT_API_KEY=//' | sed 's/^["'\'']//; s/["'\'']$//')
  if [[ -z "$raw" ]]; then
    echo "front-api: FRONT_API_KEY not set in $FRONT_ENV_FILE" >&2
    return 1
  fi
  printf '%s' "$raw"
}

# Browsers we'll try, in priority order. Mirrors the bolt-admin scripts.
FRONT_BROWSERS=("Google Chrome" "Brave Browser" "Microsoft Edge" "Arc" "Chromium" "Dia")

front_active_chrome_url() {
  local app
  for app in "${FRONT_BROWSERS[@]}"; do
    local url
    url=$(/usr/bin/osascript - "$app" 2>/dev/null <<'APPLESCRIPT' || true
on run argv
  set appName to item 1 of argv
  try
    using terms from application "Google Chrome"
      tell application appName
        if (count of windows) is 0 then error "no windows"
        return URL of active tab of front window
      end tell
    end using terms from
  on error
    return ""
  end try
end run
APPLESCRIPT
)
    if [[ -n "$url" && "$url" != "ERROR"* ]]; then
      printf '%s' "$url"
      return 0
    fi
  done
  return 1
}

# Extract a Front conversation resource ID (cnv_xxxxxx) from any string.
# Front URLs look like:
#   https://app.frontapp.com/inboxes/teams/<team>/inbox/<inbox>/cnv_xxxxx
#   https://app.frontapp.com/open/cnv_xxxxx
#   https://app.frontapp.com/conversations/cnv_xxxxx
front_extract_cnv() {
  local s="$1"
  if [[ "$s" =~ (cnv_[A-Za-z0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

# Wrapper around curl that injects auth + base URL.
# Usage: front_curl GET "/conversations/cnv_xxx/messages?limit=10"
#        front_curl POST "/contacts/crd_xxx/notes" --data '{"body":"hi","author_id":"tea_xxx"}'
front_curl() {
  local method="$1"; shift
  local path="$1"; shift
  local key
  key=$(front_api_key) || return 1
  local url="$FRONT_API_BASE$path"
  curl -sS -X "$method" \
    -H "Authorization: Bearer $key" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    "$@" \
    "$url"
}

# Read an env var from cx-briefing/.env without exporting the whole file.
front_env_var() {
  local name="$1"
  if [[ ! -f "$FRONT_ENV_FILE" ]]; then return 1; fi
  grep -E "^${name}=" "$FRONT_ENV_FILE" | head -n1 | sed "s/^${name}=//; s/^[\"']//; s/[\"']$//"
}

# Resolve the teammate id to use as `author_id` on contact notes.
# Resolution order:
#   1. FRONT_AUTHOR_ID in cx-briefing/.env (explicit, cheapest)
#   2. FRONT_AUTHOR_EMAIL in cx-briefing/.env → look up via /teammates
#   3. macOS full name (`id -F`) → first name → firstname@stackblitz.com
#   4. ${USER}@stackblitz.com (final fallback)
# Front rejects bot/api-type teammates as note authors, so this MUST be a
# human teammate (type: user).
front_author_id() {
  local cached
  cached=$(front_env_var FRONT_AUTHOR_ID 2>/dev/null || true)
  if [[ -n "$cached" && "$cached" =~ ^tea_ ]]; then
    printf '%s' "$cached"
    return 0
  fi
  local email
  email=$(front_env_var FRONT_AUTHOR_EMAIL 2>/dev/null || true)
  if [[ -z "$email" ]]; then
    # Try macOS full name → first word, lowercased.
    local first
    first=$(id -F 2>/dev/null | awk '{print tolower($1)}')
    if [[ -n "$first" && "$first" =~ ^[a-z]+$ ]]; then
      email="${first}@stackblitz.com"
    else
      email="${USER}@stackblitz.com"
    fi
  fi
  # Note: env vars on `cmd1 | cmd2` only apply to cmd1, so set TARGET_EMAIL
  # on the python invocation (the consumer of the pipe).
  front_curl GET "/teammates?limit=200" | TARGET_EMAIL="$email" python3 -c '
import json, os, sys
target = (os.environ.get("TARGET_EMAIL") or "").lower()
data = json.loads(sys.stdin.read())
for t in (data.get("_results") or []):
    if (t.get("email") or "").lower() == target:
        print(t.get("id") or "")
        sys.exit()
'
}

# Classify a string as Front input. Echoes one of:
#   crd:crd_xxxxx  cnv:cnv_xxxxx  email:foo@bar.com
front_classify_input() {
  local s="$1"
  if [[ "$s" =~ (crd_[A-Za-z0-9]+) ]]; then
    printf 'crd:%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$s" =~ (cnv_[A-Za-z0-9]+) ]]; then
    printf 'cnv:%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$s" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    printf 'email:%s' "$s"
    return 0
  fi
  return 1
}

# Given a Front URL/cnv/crd/email, resolve to a contact id (crd_xxx).
front_resolve_contact_id() {
  local input="$1"
  local kind
  kind=$(front_classify_input "$input") || return 1
  case "$kind" in
    crd:*)
      printf '%s' "${kind#crd:}"
      ;;
    cnv:*)
      local cnv="${kind#cnv:}"
      front_curl GET "/conversations/$cnv" | python3 -c '
import json, re, sys
data = json.loads(sys.stdin.read())
link = ((data.get("recipient") or {}).get("_links") or {}).get("related", {}).get("contact", "")
m = re.search(r"(crd_[A-Za-z0-9]+)", link or "")
print(m.group(1) if m else "")
'
      ;;
    email:*)
      local email="${kind#email:}"
      local enc
      enc=$(python3 -c 'import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$email")
      front_curl GET "/contacts/alt:email:$enc" | python3 -c '
import json, sys
data = json.loads(sys.stdin.read())
print(data.get("id") or "")
'
      ;;
  esac
}
