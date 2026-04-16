#!/bin/bash
# CX Briefing — first-time setup for a new team member
# Run once: bash team-setup.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "⚡ CX Briefing — Team Setup"
echo "────────────────────────────"

# ── Check Node.js ──────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found."
  echo "    Install it from https://nodejs.org (v18+), then re-run this script."
  exit 1
fi
NODE_VER=$(node --version)
echo "✓  Node.js $NODE_VER"

# ── Check Node version ─────────────────────────────────────────
MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
if [[ "$MAJOR" -lt 18 ]]; then
  echo "❌  Node.js v18+ required (you have $NODE_VER). Please upgrade."
  exit 1
fi

# ── Create .env if missing ─────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  echo "✓  .env already exists — skipping"
else
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  echo "✓  Created .env from .env.example"
  echo ""
  echo "  👉  Open $ENV_FILE and fill in:"
  echo "      ANTHROPIC_API_KEY  — your Claude API key"
  echo "      FRONT_API_KEY      — shared team Front key"
  echo "      (Slack + Sentry optional — add later)"
  echo ""
fi

# ── Make run script executable ─────────────────────────────────
chmod +x "$SCRIPT_DIR/run-now.sh" 2>/dev/null || true
chmod +x "$SCRIPT_DIR/CX Briefing.app/Contents/MacOS/run" 2>/dev/null || true
echo "✓  App permissions set"

# ── Offer to add to Dock / Applications ───────────────────────
APP_SRC="$SCRIPT_DIR/CX Briefing.app"
APP_DEST="$HOME/Applications/CX Briefing.app"

echo ""
read -r -p "  Add 'CX Briefing.app' to ~/Applications for easy access? [y/N] " ADD_APP
if [[ "${ADD_APP:-n}" =~ ^[Yy]$ ]]; then
  cp -R "$APP_SRC" "$APP_DEST"
  echo "✓  Added to ~/Applications"
  echo "  → You can drag it to your Dock from there"
fi

echo ""
echo "────────────────────────────"
echo "✅  Setup complete!"
echo ""
echo "  To run the briefing:"
echo "  • Double-click 'CX Briefing.app'   (after filling in .env)"
echo "  • Or: bash run-now.sh"
echo "  • Or: type /cx-briefing in Claude Code (uses Slack via MCP)"
echo ""
