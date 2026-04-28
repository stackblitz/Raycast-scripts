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
#        front_curl POST "/conversations/cnv_xxx/comments" --data '{"body":"hi"}'
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
