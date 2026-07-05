# Kalshi Desk — DEPLOYMENT (BUILD v60 · server engine)

The desk now runs **server-side 24/7** — no browser tab required. The dashboard
is a live viewer + remote control.

```
index.html      <- the dashboard (header must say BUILD v60 after deploy)
vercel.json     <- Kalshi proxy + engine cron + 60s function budget
api/
  trade.js      <- signed order placement + portfolio sync
  engine.js     <- NEW: the 24/7 trading engine (scan → gates → enter → settle → learn)
```

## Deploy steps

1. **Replace ALL files in the repo** with the ones in this package
   (`index.html` at root, `trade.js` + `engine.js` inside `api/`, `vercel.json` at root).
2. **Add KV storage** (the engine's memory — bet log, learning stats, price history):
   Vercel dashboard → Storage → Create → **Upstash Redis** (free tier is plenty) →
   Connect to this project. That auto-adds `KV_REST_API_URL` + `KV_REST_API_TOKEN`.
3. Set the other env vars (below), then Redeploy.
4. **Schedule the engine tick — every minute:**
   - Vercel Pro: the cron in `vercel.json` handles it; set a `CRON_SECRET` env var.
   - Vercel Hobby (crons limited to daily): use a free pinger — e.g. cron-job.org —
     hitting `https://YOUR-SITE.vercel.app/api/engine?action=tick&secret=YOUR_TRADE_SECRET`
     every 1 minute. That's the engine's heartbeat.
5. Hard refresh the site (Cmd+Shift+R). Header must say **BUILD v60**, and once the
   heartbeat is running the LIVE TRADING panel shows
   **● SERVER ENGINE 24/7 · safe to close this tab**.

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Value |
|---|---|
| `TRADE_SECRET` | passphrase you invent — typed when arming, used by the pinger |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | auto-added when you connect Upstash Redis |
| `KALSHI_ACCESS_KEY` | your Kalshi API key ID (only needed for LIVE orders) |
| `KALSHI_PRIVATE_KEY` | the key file, base64: `base64 -i key.pem \| tr -d '\n' \| pbcopy` |
| `CRON_SECRET` | (Pro cron only) any string — Vercel sends it with cron requests |
| `TRADING_HALTED` | (optional) set to `true` as a remote kill switch |

Env changes require a Redeploy (Deployments → ⋯ → Redeploy).

## How server mode works

- The engine tick (`/api/engine?action=tick`) runs one full sweep: refresh market
  pool → update price history → settle due bets (real Kalshi results; sim only for
  pasted paper markets) → learning module → 8 gates → enter qualifying bets →
  place/audit live orders. State persists in KV between ticks.
- The dashboard polls engine state every 20s. When the heartbeat is fresh (<5 min)
  it hands the loop to the server: no local betting, ARM/STOP/RESET are routed to
  the engine, and the log/events you see ARE the server's.
- If the engine is unreachable (not deployed, KV missing, pinger down), the
  dashboard falls back to the old browser-side loop automatically and says so.
- ARM once from the dashboard (enter TRADE_SECRET). The armed flag lives in KV,
  so the engine keeps trading live after you close the tab. STOP LIVE disarms
  server-side instantly.

## Desk rules (unchanged, now enforced server-side)

- $25 limit orders, all 8 gates, max 4 open bets, 3 strikes per market.
- SPORTS: 18h watchlist, entries only T−6h → T−45m, 80–94¢ favorites, spread ≤ 4¢,
  no sharp odds moves, $1k+ volume, max 2 held.
- Learning module: calibration extra edge, category/band adjust, 2h category
  cooldown after 3 straight losses, 1h circuit breaker after 5.
- Loser log with full at-entry gate snapshots (server entries tagged `srv`).
- Safety: −$500/day auto-halt, $30/order cap, balance ≥ $26, sync-before-trade,
  `TRADING_HALTED=true` kills orders, STOP LIVE disarms.

- Site password: `20042004`

Not financial advice. The edge is unproven — treat every session as an experiment.
