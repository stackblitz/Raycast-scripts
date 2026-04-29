# CX Briefing

Daily / shift briefing for **bolt.new** CX. One self-contained HTML file showing Front queue (open vs new vs assigned), Slack mentions, optional Sentry errors and Linear bugs. Works offline once generated.

---

## 5-minute install (recommended path)

This is the path most CX teammates use: **Claude Desktop generates the report, Node fetches Front data**. No Slack bot token needed — Slack is read inside Claude.

### 1. Get the Front API key from 1Password

The Front API key is shared. Open it in 1Password:

→ **[Front API Key — CX-ET (1Password)](https://start.1password.com/open/i?a=IMDFBCMAOBHCPIKFUQOE4VXPZQ&v=dqhyyyld44do2bvsh267zn7y2e&i=o2pltfoze2uo2a4rxu57c2yeme&h=stackblitz.1password.com)**

Copy the value (it starts with the standard Front token format).

### 2. Clone the repo (if you haven't already)

```bash
git clone https://github.com/jorrit-stack/Raycast-scripts.git
cd Raycast-scripts/cx-briefing
```

If you already have the repo, just `git pull` and `cd cx-briefing`.

### 3. Run the team setup script

```bash
bash team-setup.sh
```

This checks for Node 18+, creates a `.env` from the template, and (optionally) copies `CX Briefing.app` into `~/Applications`.

### 4. Add your Front API key to `.env`

Open `cx-briefing/.env` in your editor and paste the value from step 1:

```env
FRONT_API_KEY=<paste-from-1password>
```

That's the only required key for this path. Save the file.

### 5. Build the macOS app and run it

```bash
bash build-app.sh
```

Builds **CX Briefing.app** in this folder. Double-click it (or use the copy in `~/Applications` if step 3 added one).

The app pastes a prompt into Claude Desktop. After a few seconds, an HTML file (`cx-briefing-output.html`) appears in this folder and macOS opens it in your browser.

### Claude Desktop project setup (one-time)

For the app to work, Claude Desktop needs `cx-briefing/` registered as a **project** so its Write tool can save to disk:

1. Claude Desktop → **Projects** → **New project**.
2. Name it `cx-briefing` (or anything).
3. Add this folder (`/path/to/Raycast-scripts/cx-briefing`) as the project's working directory.
4. The Slack MCP and Front API access come from Claude's existing integrations — no extra config needed.

---

## Alternative: run without Claude Desktop (Slack bot path)

Skip this section if you're using Claude Desktop above. This path is for headless use (cron, CI, scheduled runs without a logged-in Claude session) and needs **two extra keys**.

```bash
# In .env, in addition to FRONT_API_KEY:
ANTHROPIC_API_KEY=sk-ant-...              # for the AI summary
SLACK_BOT_TOKEN=xoxb-...                  # for Slack mentions
```

The Slack bot needs `channels:history`, `channels:read`, `groups:history`, `groups:read`. Invite it to each private channel with `/invite @cx-briefing-bot`. Then:

```bash
bash run-now.sh
# or: npm start
```

Useful flags (see the header of `index.js`):

- `--hours=8` — shorter lookback window
- `--no-slack-api --slack-json=/path/to/slack.json` — skip the bot and read Slack from a JSON dump (e.g. an MCP export)

---

## Optional integrations

All optional. Add to `.env` only if you want the matching section in the report.

| Section | Env var(s) | Where to get the token |
|---|---|---|
| Sentry errors | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG=stackblitz` | sentry.io → Settings → Account → API → Auth Tokens. Scopes: `org:read`, `project:read`, `event:read`. |
| Linear CX bug radar | `LINEAR_API_KEY=lin_api_…`, `LINEAR_TEAM_IDS=…` | linear.app → Settings → API. Read access is enough. Optional `LINEAR_LABEL_NAMES=Bug,CX` and `LINEAR_CREATOR_EMAIL=cx@…` to narrow. |
| Query / dashboard buttons | `QUERY_NEW_URL`, `QUERY_DASHBOARD_URL`, `QUERY_TICKET_ANALYZER_URL` | Already filled with sensible defaults in `.env.example`. |

---

## Scheduling a recurring run

Three options:

- **Raycast**: schedule `run-now.sh` from the Raycast scheduler (recommended for desktop sessions).
- **launchd**: `launchd/cx-briefing.plist` is a starting template; copy to `~/Library/LaunchAgents/` and `launchctl load` it.
- **cron**: `crontab -e` and add a line like `0 9 * * 1-5 cd /path/to/cx-briefing && bash run-now.sh`.

All three need the same `.env` to be readable from the chosen scheduler's environment.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| HTML file shows "Front not connected — add FRONT_API_KEY" | `.env` missing or `FRONT_API_KEY` empty. Re-check step 4 above. |
| `CX Briefing.app` opens but no HTML appears | Claude Desktop's project isn't pointing at this folder. Re-do the project-setup step above. |
| `bash team-setup.sh` says "Node.js v18+ required" | Install Node 18+ from nodejs.org or via Homebrew (`brew install node`). |
| Slack section shows "no Slack data" in the alternative path | Bot token missing or bot isn't invited to the channels. Run with `--no-slack-api` to skip Slack entirely. |
| Want to run in the alternative path but don't have Anthropic key | Reach out to whoever owns CX tooling — there's a shared key in 1Password. |

---

## Related tooling

The Raycast scripts in the parent repo (`Raycast-scripts/`) reuse this same `cx-briefing/.env` for `FRONT_API_KEY`. Specifically:

- `front-grab-context.sh` — grabs the active Front conversation's customer messages to clipboard
- `front-add-note.sh` — posts an internal note to a Front contact
- `bolt-admin.sh` token-allocation flow — optional auto-log to Front

If you've set up `cx-briefing` correctly, those Raycast scripts work with no extra config.

For the **Search Front Conversations** Raycast list view (in `bolt-admin-tools/`), the Front key goes into Raycast preferences instead — same value, different storage. Ask in your CX channel if you want it set up.

---

## Why HTML instead of a real app?

For now, **zero-hosting** is the goal: no deploy, no auth wall, works offline. Anyone can open the file from disk or `/tmp` and it just works.

A full **CX Operations** app (auth, audit trail, saved runs, scheduled emails) is in the plan — see `CX_OPERATIONS_APP_PLAN.md` in the parent repo. Until that lands, HTML is the intended delivery format. Print to PDF from the browser if you need a snapshot to attach to a ticket or share externally.
