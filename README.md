# Kalshi Paper Desk — Deploy

A single-file, real-time paper-trading dashboard. No build step, no server, no dependencies.

## Deploy to GitHub Pages (~5 min)

1. Create a new GitHub repository (public is fine), e.g. `kalshi-paper-desk`.
2. Upload `index.html` to the repo root.
3. Repo **Settings → Pages → Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: **main**, folder **/ (root)** → Save.
4. Wait ~1 minute, then open `https://<your-username>.github.io/kalshi-paper-desk/`.

## What to expect

- Badge top-left shows the data source:
  - `● LIVE · KALSHI` — Kalshi API connected directly (best case)
  - `● LIVE · KALSHI VIA RELAY` — Kalshi via a public CORS relay (works, can be slow)
  - `● LIVE · POLYMARKET` — fallback to Polymarket's real markets
  - `FEED OFFLINE — RETRYING` — no feed reachable; retries every 60s
- The scanner sweeps every 5 seconds and auto-places $25 paper bets when all
  6 entry gates pass (settles in 5–60 min, 55–90¢ band, volume ≥ $500,
  edge ≥ +2.5¢, score ≥ 60, not already held). New entries blink green.
- Everything is automatic: entry, settlement, P&L, hit rate, avg edge.
- All state lives in the browser (localStorage): it only runs while a tab is
  open, and the log is per-browser/per-device.

## Notes

- Settlement is currently simulated from each market's own implied odds
  (paper trading). Real-outcome settlement can be added once a feed is confirmed.
- If you always get FEED OFFLINE, Kalshi is blocking browser requests and the
  public relays are down — the fix is a ~10-line Cloudflare Worker proxy.
- Paper trading only. Not financial advice.
