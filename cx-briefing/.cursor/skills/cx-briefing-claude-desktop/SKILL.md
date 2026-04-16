---
name: cx-briefing-claude-desktop
description: >-
  Runs the cx-briefing dashboard using Claude Desktop Slack MCP instead of the
  Slack REST bot. Covers --slack-json, --no-slack-api, Query.new links, and
  optional scheduling when the user hits Slack MCP limits from Node.
---

# CX Briefing + Claude Desktop (Slack MCP)

## Why Node does not use Claude Desktop MCP

`node index.js` is a plain **Node** process. It cannot attach to **Claude Desktop’s** MCP servers (Slack, etc.). MCP tools only run inside the Claude Desktop (or Claude Code) host. If Slack via API (`SLACK_BOT_TOKEN`) is flaky or unwanted, use the **file bridge** below.

## Recommended workflow (Slack from MCP → HTML from Node)

1. **Stub shape** (once, to create a file to fill):

   ```bash
   cd /path/to/cx-briefing
   npm run slack-json-stub > ~/cx-slack-channels.json
   ```

2. In **Claude Desktop** (with Slack MCP enabled), ask Claude to read the briefing channels and **return JSON** matching that file: top-level keys are channel names (`bolt-bugs`, `cx-core`, …); each value has `priority` and `messages` (array of `{ time, text, reactions, replies }` in ISO time like the API path).

3. **Merge** Claude’s output into `~/cx-slack-channels.json` (or save Claude’s file as a new path).

4. **Run the briefing** (Front + Sentry from `.env`, Slack from file):

   ```bash
   node index.js --no-slack-api --slack-json="$HOME/cx-slack-channels.json"
   ```

   Omit `--no-slack-api` if you are not setting `SLACK_BOT_TOKEN` in `.env`.

## Query.new in the dashboard

The HTML header **Launch** row includes **Query.new** (`https://query.new/` by default), then **Query dashboard** and **Ticket analyzer** (utility URLs). Override with `.env`:

- `QUERY_NEW_URL` — set to `false` or `off` to hide the Query.new chip only.
- `QUERY_DASHBOARD_URL`, `QUERY_TICKET_ANALYZER_URL` — internal deep links.

## Clickable Front tickets

Front rows use `https://app.frontapp.com/open/<conversation_id>`. Override base with `FRONT_APP_BASE_URL` if your org uses a different Front web host.

## Claude Desktop–only briefing (no Node Slack at all)

Use the macOS **CX Briefing.app** from `build-app.sh`: it fetches **Front** via Node, opens Claude Desktop, and pastes a prompt so Claude reads Slack via **its** MCP and writes HTML. That path does not use `--slack-json`; it relies on Claude doing the Write tool step.

## Scheduling

To run the Node dashboard on a timer, use **launchd** (see `launchd/cx-briefing.plist` in this repo) or Raycast **schedule** / cron calling `bash run-now.sh` with the same flags you use manually (`--slack-json=…` when needed).
