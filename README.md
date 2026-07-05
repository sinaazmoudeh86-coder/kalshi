# Kalshi Live Desk — DEPLOYMENT (BUILD v75 · Kalshi-only, server feed)

3 files + this README. The repo root must look exactly like this:

```
index.html      <- the dashboard (header must say BUILD v75 after deploy)
vercel.json     <- proxies /api/kalshi/* to Kalshi's market-data API + feed budget
api/
  trade.js      <- signed order placement + portfolio sync (needs env vars)
  feed.js       <- server-side market sweep: browser makes 1 request, not ~80 (no env vars)
```

## Deploy steps

1. **Replace ALL files in the repo** with the ones in this package.
   The filename must be exactly `index.html` at the repo root, and `trade.js`
   inside a folder named `api`.
2. Vercel auto-deploys on commit. Wait for "Ready".
3. **Hard refresh** the site: Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows).
4. Check the header — it must say **BUILD v75**.

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Value |
|---|---|
| `KALSHI_ACCESS_KEY` | your Kalshi API key ID (read/write key) |
| `KALSHI_PRIVATE_KEY` | the key file, base64: `base64 -i key.pem \| tr -d '\n' \| pbcopy` |
| `TRADE_SECRET` | passphrase you invent — typed when arming |
| `TRADING_HALTED` | (optional) set to `true` as a remote kill switch |

Env changes require a Redeploy (Deployments → ⋯ → Redeploy).

## Using it

- Site password: `20042004`
- ARM: LIVE TRADING panel → ARM → enter your TRADE_SECRET.
  Balance appearing = the whole chain works.
- Armed: every signal clearing all 8 gates places a real $25 limit order.
  Resting orders are re-audited every sweep and canceled if the thesis breaks,
  the price runs away, or 10 min pass unfilled.
- Log reconciles against real Kalshi fills, settlements & positions every 30s.
- SPORTS (new): 18h watchlist, entries only T−6h → T−45m, 80–94¢ heavy favorites,
  spread ≤ 4¢, no sharp odds moves, $1k+ 24h volume, max 2 held at once.
- LOSER LOG (new): every loss keeps a snapshot of all 8 gate values at the
  betting moment; COPY exports the full report for review.
- Learning module: calibration extra edge, category/band adjust, 2h cooldown
  after 3 straight category losses, 1h circuit breaker after 5 straight.
- Safety: −$500/day auto-halt, $30/order server cap, ■ STOP LIVE disarms
  instantly, `TRADING_HALTED=true` kills orders server-side.
- **The desk only scans/trades while a browser tab is open.** Keep the tab open
  (it takes a screen wake-lock while armed).

Not financial advice. The edge is unproven — treat every session as an experiment.
