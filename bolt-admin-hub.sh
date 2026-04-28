#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Bolt Admin Hub
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🤖
# @raycast.argument1 { "type": "text", "placeholder": "User ID, Project ID, or Email (optional)", "optional": true }
# @raycast.argument2 { "type": "text", "placeholder": "Action (optional, else menu)", "optional": true }

# Documentation:
# @raycast.description Open bolt.new/StackBlitz admin sections: dashboard, users, rate limits, sites, Bolt DB, token usage, snapshots, Netlify. Pass ID or pick from menu.
# @raycast.author Jorrit Harmamny

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ID="${1:-}"
ACTION="${2:-}"

# Base URLs (StackBlitz admin = backend; bolt.new = product)
STACKBLITZ_ADMIN="https://stackblitz.com/admin"
BOLT_NEW="https://bolt.new"
BOLT_ADMIN="${BOLT_NEW}/admin"

# If no action given, show menu
if [[ -z "$ACTION" ]]; then
  CHOICE=$(/usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events" to activate
set theList to {"Admin dashboard (bolt.new/admin)", "Admin users (by ID/email)", "Rate limits (user ID)", "Token reset (user ID)", "Sites and Deployments", "Static Hosting Sites", "Import ZIP", "Bolt DB", "Token Usage", "Snapshots", "Netlify Partner Accounts", "Project Restore", "Collaboration Migrations", "Org rate limits"}
set choiceResult to choose from list theList with title "Bolt Admin Hub" with prompt "Choose section" OK button name "Open" cancel button name "Cancel" default items {"Admin dashboard (bolt.new/admin)"}
if choiceResult is false then
  return ""
end if
return (item 1 of choiceResult) as text
APPLESCRIPT
  ) || true
  CHOICE=$(printf '%s' "$CHOICE" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

  if [[ -z "$CHOICE" ]]; then
    echo "Cancelled."
    exit 0
  fi

  case "$CHOICE" in
    *"Admin dashboard"*)     ACTION="dashboard" ;;
    *"Admin users"*)         ACTION="users" ;;
    *"Rate limits"*)         ACTION="rate-limits" ;;
    *"Token reset"*)         ACTION="token-reset" ;;
    *"Sites and Deployments"*) ACTION="sites" ;;
    *"Static Hosting"*)      ACTION="static-hosting" ;;
    *"Import ZIP"*)         ACTION="import-zip" ;;
    *"Bolt DB"*)            ACTION="bolt-db" ;;
    *"Token Usage"*)        ACTION="token-usage" ;;
    *"Snapshots"*)          ACTION="snapshots" ;;
    *"Netlify Partner"*)    ACTION="netlify" ;;
    *"Project Restore"*)    ACTION="project-restore" ;;
    *"Collaboration Migrations"*) ACTION="collaboration-migrations" ;;
    *"Org rate limits"*)    ACTION="org-rate-limits" ;;
    *)                      ACTION="dashboard" ;;
  esac
fi

# Resolve URL for chosen action (optional ID)
open_url() {
  local url="$1"
  if [[ -n "$url" ]]; then
    open "$url"
    echo "Opened: $url"
  else
    echo "No URL for action: $ACTION"
    exit 1
  fi
}

# Prompt for a Project ID or slug. Returns the entered value on stdout
# (URL-encoded so a slug with spaces/symbols works).
prompt_project_id() {
  local title="$1"
  local default="${2:-}"
  local val
  val=$(/usr/bin/osascript -e 'tell application "System Events" to activate' \
    -e "display dialog \"Enter Project ID or slug:\" with title \"${title}\" default answer \"${default}\" buttons {\"Cancel\", \"OK\"} default button \"OK\" cancel button \"Cancel\"" \
    -e 'return text returned of result' 2>/dev/null) || true
  val=$(printf '%s' "$val" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [[ -z "$val" ]]; then
    return 1
  fi
  python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$val"
}

case "$ACTION" in
  dashboard)
    open_url "$BOLT_ADMIN"
    ;;
  users)
    if [[ -n "$ID" ]]; then
      if [[ "$ID" =~ ^[0-9]+$ ]]; then
        open_url "https://stackblitz.com/admin/users?q%5Bid_eq%5D=${ID}&commit=Filter&order=id_desc"
      else
        enc=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$ID")
        open_url "https://stackblitz.com/admin/users?q%5Bby_email_address%5D=${enc}&commit=Filter&order=id_desc"
      fi
    else
      open_url "https://stackblitz.com/admin/users?commit=Filter&order=id_desc"
    fi
    ;;
  rate-limits)
    if [[ -z "$ID" ]]; then
      ID=$(pbpaste | tr -d '\n' | grep -Eo '^\d{4,}$' || true)
    fi
    if [[ -z "$ID" || ! "$ID" =~ ^[0-9]+$ ]]; then
      echo "Provide User ID as argument or copy it to clipboard."
      exit 1
    fi
    open_url "${BOLT_NEW}/api/rate-limits/${ID}"
    ;;
  token-reset)
    if [[ -z "$ID" ]]; then
      ID=$(pbpaste | tr -d '\n' | grep -Eo '^\d{4,}$' || true)
    fi
    if [[ -z "$ID" || ! "$ID" =~ ^[0-9]+$ ]]; then
      echo "Provide User ID as argument or copy it to clipboard."
      exit 1
    fi
    reset_choice=$(/usr/bin/osascript -e "display dialog \"Reset tokens for user ${ID}\" with title \"Token Reset\" buttons {\"Cancel\", \"Monthly\", \"All\"} default button \"Monthly\" cancel button \"Cancel\"" -e 'return button returned of result') || true
    case "$reset_choice" in
      Monthly) open_url "${BOLT_NEW}/api/rate-limits/reset/${ID}/month" ;;
      All)     open_url "${BOLT_NEW}/api/rate-limits/reset/${ID}/all" ;;
      *)       echo "Cancelled." ;;
    esac
    ;;
  sites)
    # https://bolt.new/admin/sites?userId=<userId>&page=1
    if [[ -n "$ID" && "$ID" =~ ^[0-9]+$ ]]; then
      open_url "${BOLT_ADMIN}/sites?userId=${ID}&page=1"
    else
      open_url "${BOLT_ADMIN}/sites"
    fi
    ;;
  static-hosting)
    # https://bolt.new/admin/static-hosting?userId=<userId>&page=1
    if [[ -n "$ID" && "$ID" =~ ^[0-9]+$ ]]; then
      open_url "${BOLT_ADMIN}/static-hosting?userId=${ID}&page=1"
    else
      open_url "${BOLT_ADMIN}/static-hosting"
    fi
    ;;
  import-zip)
    # https://bolt.new/admin/import-zip — Upload ZIP to create project (no ID in URL)
    open_url "${BOLT_ADMIN}/import-zip"
    ;;
  bolt-db)
    # https://bolt.new/admin/bolt-db?projectId=<projectId-or-slug> — needs project ID/slug
    project_id=""
    if [[ -n "$ID" && ! "$ID" =~ @ ]]; then
      project_id=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$ID")
    else
      project_id=$(prompt_project_id "Bolt DB") || { echo "Cancelled."; exit 0; }
    fi
    open_url "${BOLT_ADMIN}/bolt-db?projectId=${project_id}"
    ;;
  token-usage)
    # https://bolt.new/admin/token-usage?userId=<userId>&organizationId=&projectId=&traceId=
    if [[ -n "$ID" && "$ID" =~ ^[0-9]+$ ]]; then
      open_url "${BOLT_ADMIN}/token-usage?userId=${ID}&organizationId=&projectId=&traceId="
    else
      open_url "${BOLT_ADMIN}/token-usage"
    fi
    ;;
  snapshots)
    # https://bolt.new/admin/snapshots?projectId=&userId=<userId>
    if [[ -n "$ID" && "$ID" =~ ^[0-9]+$ ]]; then
      open_url "${BOLT_ADMIN}/snapshots?projectId=&userId=${ID}"
    else
      open_url "${BOLT_ADMIN}/snapshots"
    fi
    ;;
  netlify)
    # https://bolt.new/admin/netlify-partner-accounts?userId=<userId>
    if [[ -n "$ID" && "$ID" =~ ^[0-9]+$ ]]; then
      open_url "${BOLT_ADMIN}/netlify-partner-accounts?userId=${ID}"
    else
      open_url "${BOLT_ADMIN}/netlify-partner-accounts"
    fi
    ;;
  project-restore)
    # https://bolt.new/admin/project-restore?projectId=<projectId-or-slug>
    project_id=""
    if [[ -n "$ID" && ! "$ID" =~ @ ]]; then
      project_id=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$ID")
    else
      project_id=$(prompt_project_id "Project Restore") || { echo "Cancelled."; exit 0; }
    fi
    open_url "${BOLT_ADMIN}/project-restore?projectId=${project_id}"
    ;;
  collaboration-migrations)
    # https://bolt.new/admin/collaboration-migrations?userId=<userId>&page=1
    if [[ -n "$ID" && "$ID" =~ ^[0-9]+$ ]]; then
      open_url "${BOLT_ADMIN}/collaboration-migrations?userId=${ID}&page=1"
    else
      open_url "${BOLT_ADMIN}/collaboration-migrations"
    fi
    ;;
  org-rate-limits)
    # Delegate to org-rate-limits.sh (browser org extraction + prompt); avoids fragile clipboard-only org guessing.
    if [[ -z "$ID" ]]; then
      ID=$(pbpaste | tr -d '\n' | grep -Eo '^\d{4,}$' | head -n1 || true)
    fi
    if [[ -z "$ID" || ! "$ID" =~ ^[0-9]+$ ]]; then
      echo "Provide User ID as argument or copy it to clipboard; or run org-rate-limits.sh <UserID> [OrgID]."
      open_url "${STACKBLITZ_ADMIN}/organizations"
    elif [[ -x "$SCRIPT_DIR/org-rate-limits.sh" ]]; then
      exec "$SCRIPT_DIR/org-rate-limits.sh" "$ID"
    else
      echo "org-rate-limits.sh not found or not executable at $SCRIPT_DIR" >&2
      open_url "${STACKBLITZ_ADMIN}/organizations"
    fi
    ;;
  *)
    open_url "$BOLT_ADMIN"
    ;;
esac
