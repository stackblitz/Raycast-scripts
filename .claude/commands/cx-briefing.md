Gather a CX daily briefing using the Slack MCP + Front API, then open an HTML dashboard.

You will act as the data collector and orchestrator. Follow these steps precisely:

---

## Step 1 — Determine lookback window

Check if the user specified a number of hours (e.g. "last 8 hours", "--hours=24"). Default to 16 hours.
Note the cutoff as: `new Date(Date.now() - HOURS * 3600 * 1000).toISOString()`

---

## Step 2 — Collect Slack data via MCP

Use the `slack_read_channel` tool to read each of the following channels.
For each channel, read as many recent messages as the tool allows and filter to messages after the cutoff.
If a channel is inaccessible, note it but continue.

Channels to read (in priority order):
1. `bolt-bugs` — critical priority
2. `cx-core` — high priority  
3. `cx-team` — high priority
4. `product-releases` — high priority
5. `announcements` — high priority
6. `bolt-eng-support` — medium priority
7. `ext-parahelp-stackblitz` — medium priority
8. `general` — low priority

---

## Step 3 — Format Slack data as JSON

After reading all channels, build a JSON object in this exact shape and write it to `/tmp/cx-slack-mcp.json`:

```json
{
  "bolt-bugs": {
    "priority": "critical",
    "messages": [
      { "time": "<ISO timestamp>", "text": "<message text, max 700 chars>", "reactions": 0, "replies": 0 }
    ]
  },
  "cx-core": {
    "priority": "high",
    "messages": []
  }
}
```

Include all 8 channels as keys, even if messages is empty. Write this file using the Write tool.

---

## Step 4 — Run the briefing script

Run this bash command (adjust hours if the user specified a custom window):

```bash
FRONT_API_KEY="$(grep FRONT_API_KEY /Users/jorritharmamny/Documents/Raycast-scripts/cx-briefing/.env 2>/dev/null | cut -d= -f2-)" \
ANTHROPIC_API_KEY="$(grep ANTHROPIC_API_KEY /Users/jorritharmamny/Documents/Raycast-scripts/cx-briefing/.env 2>/dev/null | cut -d= -f2-)" \
node /Users/jorritharmamny/Documents/Raycast-scripts/cx-briefing/index.js --hours=16 --slack-json=/tmp/cx-slack-mcp.json
```

If the user specified custom hours, replace `--hours=16` accordingly.

---

## Step 5 — Report back

Tell the user:
- How many messages were collected per channel
- Which channels had no activity or were inaccessible
- That the briefing dashboard has been opened in their browser

If the script fails, show the error and suggest checking `.env` for missing API keys.
