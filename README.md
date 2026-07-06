# Kalshi Live Desk — DEPLOYMENT (BUILD v88 · Kalshi-only, full-ladder feed)

3 files + this README. The repo root must look exactly like this:

```
index.html      <- the dashboard (header must say BUILD v88 after deploy)
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
4. Check the header — it must say **BUILD v88**.

## What v88 adds — learned from the Jul 4–5 record

- **Fill capture**: ~half of winning signals died as NO FILL resting maker orders.
  Orders now TAKE the ask unless the spread is genuinely wide (≥3¢) on a slow
  market; unfilled limits are canceled after 3 min (was 10) and the retry always
  takes the ask.
- **Family form**: the desk now learns per category+side from its own settled
  record (e.g. crypto-NO won ~90%+, YES near-strike held the losses) —
  outperforming families get a 0.5¢ lower edge bar, underperforming ones +1.5¢.

## What v87 changed

- Removed the 5-open-position portfolio cap. Per-category caps (1 crypto,
  2 sports), one-entry-per-sweep, and all gates/brakes remain.

## What v86 changed — betting-logic polish

- **Real signal, not noise**: the "model edge" was a synthetic random signal.
  It is now computed purely from the OBSERVED tape: favorite-bias premium +
  aligned momentum (capped) − tape instability − wide-spread tax + convergence
  decay for deep calm favorites near settlement. A market the desk hasn't
  watched for ~2 minutes has edge 0 and cannot pass NET EDGE — watch, then trade.
- **Entries ranked by true margin**: money goes to the widest (net edge −
  required edge) margin, not the highest display score.
- **One entry per sweep** (paper and live) — no burst-entering a correlated batch.

## What v85 added — the desk explains WHY it isn't betting

- Sweep lines with 0 qualifiers now list the top blocking gates, e.g.
  `blockers: LEARNING:180 T-MINUS:70 PRICE:38`.
- If a standing brake (circuit breaker or asymmetry brake) is parking the desk,
  a red `DESK PARKED` line appears every ~10 sweeps saying which brake and when
  it clears. After the Jul 5 losses, the asymmetry brake blocks all ≥80¢ entries
  until the 24h record recovers — that quiet period is intentional, not a bug.

## What v84 fixed — pool stuck at ~90 markets

- The v80 rotating ladder kept its accumulated pool in lambda memory — but Vercel
  serverless gives a different/cold instance constantly, so every response was
  "rung 0 + 3 rungs" ≈ 90 markets and accumulation never happened.
- `api/feed.js` now sweeps the ENTIRE ladder on every call (stateless-safe): each
  small close-time window pages in 1–2 requests, ~25 requests total, time-boxed.
- The dashboard also ACCUMULATES across feed responses (merge + 30-min staleness
  prune) so a partial sweep can only add markets, never shrink the watchlist.
- Feed diag shows per-rung counts: `ladder 4m:120 30m:85 …`.

## What v83 added

- **REVERSAL gate (9th gate)**: the desk can no longer bet the opposite direction
  on the same underlying within 6h of its own bet (Jul 5: NO on BTC ≥$62,800 at
  2am, then YES on BTC ≥$62,600 at 4:35am — one of those had to be wrong, and at
  favorite prices one loss ≈ 6–9 wins).
- **ASYMMETRY BRAKE**: if the last 24h of settled bets (≥6) win under 50%, all
  entries ≥80¢ are blocked — the record is proving those favorites aren't winning
  at favorite rates, and each one risks a ~7:1 loss.
- **Whipsaw cooldown 1h → 3h** after a loss on a series.

## What v82 fixed — crypto discipline (the Jul 5 loss run)

- **Near-strike gamma zone blocked**: crypto favorites under 90¢ with <1h left are
  priced there because the strike is within ordinary tape reach — every Jul 5 loss
  lived in that zone. Now requires a ≥90¢ cushion, or <90¢ only with a dead-calm
  (≤3¢/10m), aligned, actually-observed tape.
- **Adjacent strikes = one risk**: never two positions on the same underlying +
  settlement (the 5:14 PM double on $63,400/$63,500 can't happen again), and max
  1 concurrent crypto position overall.
- **90-min crypto stand-down after ANY crypto loss** (the 3-strike cooldown never
  tripped because losses were spaced hours apart).

## What v81 fixed

- **`post only cross` rejections**: quotes are up to ~60s stale, so on fast
  markets a maker order priced safely can land on the moved ask. `api/trade.js`
  now retries such a rejection ONCE as a plain limit at the SAME price — the
  limit still caps cost; the desk takes the fill instead of voiding the entry.

## What v80 changed — rotating-ladder sweep (no more bottleneck)

- The feed now sweeps a close-time LADDER rung by rung: 0–30m, 30–60m, then
  hourly out to 12h (plus a 12–20h rung to feed the sports 18h watchlist),
  then restarts at 30m. Each sweep: re-sweep 0–30m (always fresh) + the next
  3 rotating rungs, WIPE each swept span in the stored pool and replace it
  with what Kalshi just returned. Small windows page in 1–2 requests, so the
  sweep never stalls on pagination.
- Fast crypto/index series probed on every sweep; markets that settle or go
  unconfirmed for 50 min are pruned automatically.
- Feed cache dropped to 20s and the dashboard polls it every 60s — the full
  ladder cycles roughly every 4–5 minutes.
- Feed diag reports each rung (`rung30-60m:…`) for debugging.

## What v79 fixed

- **Time-sliced sweep**: the feed used ONE 20h window query capped at 12 pages —
  Kalshi returned the same static prefix every sweep and everything behind it was
  never seen. The window is now swept in close-time slices (0–2h, 2–6h, 6–12h,
  12–20h), nearest-settling first, each with its own page budget — soon-settling
  markets can never be crowded out.
- **Fresh markets no longer dropped**: brand-new fast markets (e.g. each new
  15-min crypto strike) start at ~$0 volume and were silently filtered out.
  A tight two-sided book now qualifies a market even before volume accrues.
- Feed diag now reports per-slice counts (`win4-120m:…`) for debugging.

## What v78 fixed

- **"LIVE ORDER rejected (invalid order)"**: slow-market maker orders were priced
  at bid+1¢, which EQUALS the ask when the spread is 1¢ — a crossing post-only
  order, which Kalshi rejects. Maker price is now capped at ask−1¢ (joins the bid
  on 1¢ spreads), so resting orders never cross.
- `api/trade.js` now forwards Kalshi's full error (code · message · details) and
  echoes the order payload sent, so any future rejection is self-diagnosing.

## What v77 fixed

- **AUTO HORIZON deadlock**: the entry window now widens based on how many
  markets settle INSIDE it (not on total watchlist size). A rich watchlist
  that all settles hours out no longer pins the desk at 1h with 0 qualifying.
- **CRYPTO = 0**: `api/feed.js` now probes the fast crypto series (KXBTC15M,
  KXETH15M, KXBTCD, …) directly every sweep so the 15-min/hourly markets —
  the desk's main sub-1h supply — are always in the pool. The browser also
  runs its own crypto probe as a safety net if a sweep returns none.

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
