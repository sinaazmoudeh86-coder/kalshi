# Kalshi Paper Desk — Deploy

A single-file, real-time paper-trading dashboard. No build step, no server code, no dependencies.

## Deploy to Vercel (recommended — guaranteed live feed)

1. Put BOTH files (`index.html` AND `vercel.json`) in your project root.
2. Redeploy (git push, or `vercel --prod`, or drag the folder into vercel.com/new).
3. `vercel.json` makes Vercel proxy `/api/kalshi/*` to Kalshi's API from your own
   domain — the browser sees a same-origin request, so CORS cannot block it.
4. Open the site: the badge should read `● LIVE · KALSHI` within seconds.

## Deploy to GitHub Pages (fallback feeds only)

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

- Settlement: for Kalshi-fed bets the desk fetches the market's REAL result at
  close (marked ✓ in the log); odds-based simulation is only a fallback if the
  result isn't available within 20 minutes.
- If GitHub Pages always shows FEED OFFLINE, use the Vercel route above — the
  proxy makes the feed unconditional.
- Paper trading only. Not financial advice.
