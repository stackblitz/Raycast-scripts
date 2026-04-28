#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title bolt-admin
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🤖
# @raycast.argument1 { "type": "text", "placeholder": "UserID or Email" }

# Documentation:
# @raycast.description Look up user in StackBlitz admin (by ID or email), then copy User ID and offer rate limits / token reset. For Sites, Bolt DB, Snapshots, etc. use bolt-admin-hub.
# @raycast.author jorrit_harmamny
# @raycast.authorURL https://raycast.com/jorrit_harmamny
#
# Note: User lookup lives at stackblitz.com/admin; rate limits and product admin at bolt.new. Use bolt-admin-hub.sh for one menu to all admin sections (Sites, Static Hosting, Bolt DB, Token Usage, Snapshots, Netlify).

input="$1"

if [[ "$input" =~ ^[0-9]+$ ]]; then
  # If input is only digits, treat as ID
  url="https://stackblitz.com/admin/users?q%5Bid_eq%5D=${input}&commit=Filter&order=id_desc"
else
  # Otherwise, treat as email
  encoded=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$input")
  url="https://stackblitz.com/admin/users?q%5Bby_email_address%5D=${encoded}&commit=Filter&order=id_desc"
fi

open "$url"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
COPY_USER_ID_SCRIPT="$SCRIPT_DIR/copy-user-id-from-browser.sh"

# Wait for search results to load, then navigate the browser to the profile page
# so copy-user-id-from-browser.sh can read the user ID directly from /admin/users/username
sleep 2

BROWSERS=("Arc" "Google Chrome" "Brave Browser" "Microsoft Edge" "Chromium" "Dia")

navigate_to_profile() {
  local app_name="$1"
  /usr/bin/osascript - "$app_name" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  try
    using terms from application "Google Chrome"
      tell application appName
        if (count of windows) is 0 then error "No windows"
        set theTab to active tab of front window
        -- Find first profile link inside the results table (skips the header
        -- link to the logged-in admin's own profile)
        set profileURL to execute theTab javascript "
          try {
            const scope = document.querySelector('#index_table_users tbody') || document.querySelector('#index_table_users') || document.querySelector('table.index_table') || document;
            const link = Array.from(scope.querySelectorAll('a[href]'))
              .find(function(a) {
                return /\\/admin\\/users\\/(?!new(?:[^a-z]|$))(?!new_)[^?#\\/]+$/.test(a.href);
              });
            link ? link.href : '';
          } catch(e) { ''; }
        "
        if profileURL is missing value then set profileURL to ""
        if profileURL is "" then error "No profile link found"
        -- Navigate the tab to the profile page
        set URL of theTab to profileURL
        return "OK:" & profileURL
      end tell
    end using terms from
  on error errMsg
    return "ERROR: " & errMsg
  end try
end run
APPLESCRIPT
}

profile_url=""
for app in "${BROWSERS[@]}"; do
  result=$(navigate_to_profile "$app") || true
  if [[ "$result" == OK:* ]]; then
    profile_url="${result#OK:}"
    echo "Navigated to profile: $profile_url"
    break
  fi
done

if [[ -z "$profile_url" ]]; then
  echo "Could not find user profile link on search results page." >&2
fi

# Wait for profile page to load, then extract the user ID
sleep 2

if [[ -x "$COPY_USER_ID_SCRIPT" ]]; then
  attempts=0
  max_attempts=3
  while (( attempts < max_attempts )); do
    "$COPY_USER_ID_SCRIPT"
    status=$?
    if (( status == 0 )); then
      exit 0
    fi
    (( attempts++ ))
    if (( attempts < max_attempts )); then
      sleep 1.5
    fi
  done
  echo "copy-user-id-from-browser.sh failed after $max_attempts attempts" >&2
  exit 1
else
  echo "Warning: copy-user-id-from-browser.sh not found at $COPY_USER_ID_SCRIPT" >&2
fi