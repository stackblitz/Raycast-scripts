# CX Briefing

Shift briefing for **bolt.new** CX: Front queue, optional Slack/Sentry, optional AI summary. Output is usually **one HTML file** you open in a browser.

## Is HTML the “right” format?

**For this repo, yes.** The goal is a **zero-hosting** dashboard: no deploy, no login, works offline after generation. Claude Desktop and `node index.js` both produce **self-contained HTML** (CSS inline) so anyone can open it from disk or `/tmp`.

Later, the **CX Operations app** (see `CX_OPERATIONS_APP_PLAN.md` in the parent `Raycast-scripts` repo) will replace “open a file” with an **internal web app** (auth, audit, saved runs). Until then, HTML is the intended delivery format. Optional: print to PDF from the browser if you need a snapshot to attach.

---

## How to run it (pick one)

### A. **Fast path — Node** (Slack API + Front + Sentry in `.env`)

Best when the Slack **bot token** works and you want a dashboard without Claude Desktop.

```bash
cd /path/to/cx-briefing
cp .env.example .env   # once; then fill keys (see team-setup)
bash run-now.sh
# or: npm start
```

Opens a generated HTML file in your default browser.

Useful flags (see `index.js` header comment):

- `--hours=8` — shorter window  
- `--no-slack-api --slack-json=/path/to/slack.json` — Slack from Claude / MCP export instead of the API  
- `npm run slack-json-stub` — empty JSON shape for that flow  

### B. **CX Briefing.app** (Claude Desktop + Slack MCP)

Best when Slack should be read **inside Claude** (MCP), not via the bot.

1. **One-time:** `bash build-app.sh` (builds `CX Briefing.app` next to this folder).  
2. **Secrets:** `.env` with at least `FRONT_API_KEY` (Front summary is fetched by Node before Claude runs). Slack comes from Claude’s Slack integration.  
3. **Claude Desktop:** Add this **`cx-briefing` folder as a project** so the Write tool can save to `cx-briefing-output.html` here (sandbox often blocks `$HOME`).  
4. **Run:** Double-click **CX Briefing.app**. It pastes a prompt into Claude; when the HTML file appears in the project folder, macOS opens it in the browser.

If the page does not auto-open, open `cx-briefing/cx-briefing-output.html` manually from the same folder you built the app from.

### C. **Team setup**

```bash
bash team-setup.sh
```

Covers `.env` expectations and shared keys (run once per machine or after onboarding).

---

## What other CX agents need

| Need | Action |
|------|--------|
| Keys | Get `.env` from your lead / 1Password; never commit `.env`. |
| Slack in browser | Use **A** with `SLACK_BOT_TOKEN` and channels the bot is invited to. |
| Slack only via Claude | Use **B**, or **A** with `--slack-json=…` (see `.cursor/skills/cx-briefing-claude-desktop/SKILL.md`). |
| Query / internal tools | Set `QUERY_NEW_URL`, `QUERY_DASHBOARD_URL`, `QUERY_TICKET_ANALYZER_URL` in `.env` (defaults exist in `.env.example`). |
| Scheduled run | Use Raycast, `launchd/cx-briefing.plist`, or cron calling `run-now.sh` with the same flags you use by hand. |

Questions or broken flows: ping whoever owns **CX tooling** in your team or open a thread in your usual eng/CX channel with **which path (A or B)** you used and any error text.
