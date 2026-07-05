# Kalshi Live Desk — FINAL DEPLOYMENT (BUILD v37)

3 files + this README. The repo root must look exactly like this:

```
index.html      <- the dashboard (header must say BUILD v37 after deploy)
vercel.json     <- proxies /api/kalshi/* to Kalshi's market-data API
api/
  trade.js      <- signed order placement + portfolio sync (needs env vars)
```

## Deploy steps

1. **Replace ALL files in the repo** with the ones in this package.
   Easiest clean way on GitHub web: open each file → pencil icon → select-all →
   paste the new contents → Commit. (Uploading duplicates like `index (3).html`
   does nothing — the filename must be exactly `index.html` at the repo root,
   and `trade.js` inside a folder named `api`.)
2. Vercel auto-deploys on commit. Wait for "Ready".
3. **Hard refresh** the site: Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows).
4. Check the header — it must say **BUILD v37**. If it shows an older number,
   the repo file is still old: open the repo's `index.html` on GitHub and
   search for "BUILD v" to see what's actually committed.

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
  Log pills: ORDER (resting) / PARTIAL / PLACED (filled) with live win %.
  Resting orders are re-audited every sweep and canceled if the thesis breaks,
  the price runs away, or 10 min pass unfilled. Rejected orders are voided.
- Log reconciles against real Kalshi fills, settlements & positions every 30s
  (✓ = real result); ACCOUNT SYNC panel shows IN SYNC / MISMATCH + SYNC NOW.
- SETTLE HORIZON: AUTO (default) widens 1h→4h→12h→24h when the pool is thin.
- Domain models: crypto 0DTE gamma/fee logic + weather diurnal ratchet logic (8th gate).
- Learning module: calibration-based extra edge, category cooldowns, circuit breaker.
- Money-flow chart (cash vs in-bets), static live market strip with sparklines,
  browser notifications when tab hidden, screen wake-lock while armed.
- LEARNING MODULE: adapts required edge from calibration, cools down losing
  categories (3 straight losses = 2h block), circuit-breaks after 5 straight losses.
- Safety: −$500/day auto-halt, $30/order server cap, ■ STOP LIVE disarms instantly,
  `TRADING_HALTED=true` kills orders server-side.
- The desk only scans/trades while a browser tab is open.

Not financial advice. The edge is unproven — treat every session as an experiment.
