# Kalshi Live Desk — DEPLOYMENT (BUILD v102 · Kalshi-only, sub-1h hunter)

3 files + this README. The repo root must look exactly like this:

```
index.html      <- the dashboard (header must say BUILD v94 after deploy)
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
4. Check the header — it must say **BUILD v102**.

## What v102 changes — 4:21 PM log review

- **AUTO HORIZON hysteresis**: the entry window flapped 12h→4h→1h within 5
  minutes, re-scoring the whole pool on each flip. A switch now requires its
  condition to hold ~90s and 3 min since the last switch (an EMPTY window
  still widens immediately so startup stays fast).
- **Smarter log coalescing**: repeated rows (sweep summaries, hot lane,
  "already exposed — skipping…") now merge even when other rows interleave —
  the same skip message printed 6× in 30s.
- (v101's ACTIVE-only REVERSAL rule is included — the 3h-old settled-bet
  blocks in this log are gone once deployed.)

## What v101 changes

- **REVERSAL gate narrowed**: only blocks when an ACTIVE (open, unsettled)
  opposite-direction bet exists on the same underlying — holding both sides
  guarantees one loses. Settled/expired bets no longer block for 6h; the 4:07 PM
  log showed a 92¢ BTC entry blocked by a YES from 3 hours earlier that had
  already settled.

## What v100 changes

- **Activity log retains 24 hours** (was last 50 rows) on both the dashboard
  and the server engine (5000-row safety cap).
- **COPY TEXT button** in the Activity header — copies the whole 24h log as
  plain text (timestamped rows) for pasting into chat.

## What v99 fixes — Jul 6 tape review

- **Junk-payout filter**: net payout must be ≥ $1.25. Kills the 98–99¢ entries
  that risked $25 to win $0.01–$0.47 after fees; the final-10-min high-band
  exception now caps at 96¢ (was 98¢).
- **No-fill churn guard**: one immediate retry allowed; after two voided
  attempts a market goes quiet for 30 min (BNB/gold/Shiba were re-signaled
  every 1–3 min, all NO FILL — wasted slots, log spam, duplicate rows).
- **Fill audit**: if Kalshi fills more contracts than ordered (the −$49 weather
  losses on a $25 stake = double fill) a loud FILL AUDIT event fires; a bet
  that settles WON with negative P&L is flagged instead of hiding in the log.

## What v98 fixes

- Killed the "pwKey / onPwChange is not defined" errors in the bottom banner:
  typing into the password box before the app finished mounting executed raw
  template attributes as native JS. Pre-mount no-op handlers added; zero
  behavior change.

## What v97 changes — weather RE-ENABLED (post-peak lock-in lane)

Weather failed before because the desk made FORECAST bets (morning entries on a
model temperature). Daily temp extremes are monotonic — the high only ratchets
UP, the low only ratchets DOWN — so after the diurnal turn the outcome is
physics, not forecast, and extreme-priced weather markets historically settled
true ~98% of the time. v97 trades ONLY that slice:

- **Clock gate**: daily-HIGH entries only after ~3pm local station time (city
  decoded from the ticker, DST offsets); daily-LOW only after ~9am local.
- **Short window**: market must close within 5h — no long forecast exposure.
- **85–96¢ favorites only**; ≥90¢ with aligned book gets a small edge credit
  (post-peak certainty is under-priced).
- **Observed-stable book**: 3+ quote samples, ≤5¢/10m range, no ≥3¢ drift
  against the side — a locked outcome does not reprice; movement = still in play.
- **Max 1 open weather position** · **24h stand-down** after any weather loss.
- Existing NWS settlement patience (20h grace, "AWAITING NWS RPT") unchanged.
- The v95 slippage guard applies to weather too (bandMin 85¢).

## What v96 changes — hero bar polish (presentation ONLY)

- The top hero/status bar is now sticky (stays pinned while scrolling) with a
  glass blur background, stronger typography hierarchy, cleaner separators,
  a glowing TOTAL VALUE card, and smooth count-up animations + green/red
  flashes when values change.
- **Zero data/logic changes**: same fields, same order, same API bindings,
  same refresh intervals, same calculations. The count-up element animates
  whatever formatted string the existing pipeline already produces.

## What v95 fixes — the Jul 6 $62,700 loss + high-prob ramp

- **SLIPPAGE GUARD (the loss)**: gates were checked at the signal quote (92¢,
  "model 95%"), but placement always takes the live ask — which was 4¢ (BTC had
  already fallen through the strike; the feed quote was stale). The order was
  re-sized to 625 contracts and bought a 4% longshot the model never evaluated.
  Now: if the executable price is more than 3¢ from the evaluated price, or
  below the win-odds band, the order is ABORTED, the entry voided, and the
  ticker cooled off for 2h. A signal is only valid at the price it was scored.
- **HIGH-PROB RAMP**: the small-payout/high-win-rate book (≥82¢ favorites) is
  the proven lane — those entries may now run **3 concurrent crypto positions**
  (was 1) and **up to 3 entries per sweep** (was 1). Sub-82¢ entries keep the
  old discipline (max 1 crypto, one entry ends the sweep). Never two positions
  on the same underlying, whatever the strike or settlement.

## What v94 changes — sub-1h hunting across ALL categories

- The first hour is now swept in four 15-min slices with DEEP page budgets
  (8 pages each) — busy-day MVE parlay floods can no longer truncate real
  soon-settling markets (econ, commodities, politics, entertainment included).
  Far rungs get shallow budgets; they only feed the watchlist.
- **Sub-1h markets are exempt from every pool quota** — anything settling
  within 70 min stays in the pool regardless of category or volume.
- Feed diag now reports `sub-1h:` count.

## What v93 fixes — knife-edge NET EDGE misses

- A textbook candidate (calm 88¢ favorite, tight book) nets ~+4.4¢ while learned
  penalties pushed the bar to the 4.5¢ cap — a permanent 0.1¢ miss. Bar cap is
  now 4.0¢ (clean setups clear by ~0.5¢; choppy/misaligned tape still fails).
- Convergence bonus window widened to ≤75m / ≥78¢.
- The NET EDGE gate now shows the bar: "+4.4¢ vs bar 4.0¢".

## What v91–v92 rebuild — scanning + placement, ground up

Scanning:
- **Two-tier quote engine**: hot lane (in-window tradable markets + anything held)
  re-priced every 15s in one request; full pool every 60s. Tape samples every 12s
  — a hot market becomes tradable in ~40s instead of 2+ minutes.
- **Fast series probed directly every sweep** (15m/hourly/daily crypto incl. DOGE,
  SOL/XRP dailies, index dailies) — guaranteed coverage, no pagination risk.
  Ladder rungs capped at 3 pages (past that it's MVE parlay noise).
- **Crypto pool slots go soonest-settling first** — fresh strikes ($0 printed
  volume) no longer lose their slots to stale high-volume dailies.
- **Premium-stack cap**: base bar + learned band penalties + domain taxes stacked
  to an unpassable ~5¢+ bar on a desk running 83–10. Every brake still applies;
  the SUM is capped at 4.5¢.

Placement:
- **Always take the ask** — the record priced missed fills far above the 1–2¢
  spread. No more resting maker entries.
- Unfilled orders on fast markets (<45m to settle) pulled at 90s (3 min
  elsewhere); the retry takes the fresh ask.

## What v90 fixes — LIQUIDITY blocking every survivor

- In-window, in-band candidates are mostly fresh fast crypto strikes with ~$0
  PRINTED 24h volume; v79 let them into the pool via their tight book but the
  LIQUIDITY gate still demanded $100 volume, so nothing could fire.
- The gate now passes on EITHER printed volume OR a tight two-sided book
  (≤2¢ spread, both sides 3–97¢) — a live tight book IS liquidity before
  volume prints. Sports still require real printed volume.

## What v89 fixed — bar-vs-signal miscalibration (0 qualify for hours)

- The v86 observed-tape edge topped out ~2–3¢ while the required bar sat above
  it nearly everywhere, so NET EDGE silently killed every survivor. The edge
  model is recalibrated to the desk's own settled record (favorites 80–95¢
  realized ~3–5¢ true edge before fees): higher base, stronger convergence
  bonus, momentum cap +2.5¢. Penalties (chop, wide spread, against-tape)
  unchanged.
- AUTO HORIZON now counts TRADABLE favorites (70–92¢ band) instead of raw
  markets when deciding to widen — 4h no longer looks "rich" because of 300
  untradable longshots.

## What v88 added — learned from the Jul 4–5 record

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
