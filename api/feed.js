// Kalshi Desk — MARKET FEED (Vercel serverless, srv feed-4 · rotating ladder).
// The desk's ONLY heavy sweeper. Browser makes 1 request; this function talks to
// Kalshi with rate-limit discipline (sequential pages, 429 retry with backoff).
//
//   GET /api/feed             -> { ts, ageMs, pool: [{t,ticker,c,yes,closeTs,vol,bid,ask}], diag }
//   GET /api/feed?tickers=A,B -> { ts, quotes: { TICKER: {yes,bid,ask} } }  (fast lane)
//
// ROTATING LADDER SWEEP: instead of one giant window query that bottlenecks on
// pagination, the close-time ladder is swept rung by rung — 0-30m, 30-60m, then
// hourly out to 12h (plus a 12-20h rung so the sports 18h watchlist stays fed),
// then restarts at 30m. Each /api/feed call sweeps the 0-30m rung (always fresh)
// + the next few rotating rungs, WIPES the stored markets in each swept span and
// replaces them with what Kalshi returned. Small windows page in 1-2 requests,
// so the sweep always keeps moving. Fast crypto/index series are probed every
// call on top. Public market data only — no keys.
const KBASE = "https://api.elections.kalshi.com/trade-api/v2";

// close-time ladder in minutes: [from, to] — ALL rungs are swept on every call
// (serverless instances don't share memory, so nothing may depend on stored state)
const RUNGS = [
  [4, 30], [30, 60], [60, 120], [120, 180], [180, 240], [240, 300], [300, 360],
  [360, 420], [420, 480], [480, 540], [540, 600], [600, 660], [660, 720],
  [720, 1205] // sports 18h watchlist rung
];

let cache = { ts: 0, pool: null, diag: null };
let evCatCache = { ts: 0, map: null };
let inflight = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function kfetch(path, ms, retries) {
  for (let a = 0; ; a++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 9000);
    try {
      const r = await fetch(KBASE + path, { signal: ctrl.signal });
      if (r.status === 429 || r.status >= 500) {
        if (a < (retries != null ? retries : 2)) { clearTimeout(t); await sleep(1200 * (a + 1)); continue; }
        throw new Error("HTTP " + r.status);
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
}

function tickerCat(t) {
  t = (t || "").toUpperCase();
  if (/BTC|ETH|SOL|XRP|DOGE|CRYPTO|BITCOIN|ETHEREUM/.test(t)) return "CRYPTO";
  if (/FED|CPI|GDP|JOBS|CLAIMS|PAYROLL|RATE|INX|NASDAQ|S&P|TNOTE|RECESSION|INFLATION/.test(t)) return "ECON";
  if (/OIL|GAS|GOLD|SILVER|WTI|BRENT|COMMOD/.test(t)) return "COMMOD";
  if (/ELECTION|PRESIDENT|SENATE|GOVERNOR|CONGRESS|NOMINEE|PRIMARY|POLITIC|WHITE HOUSE|SUPREME COURT/.test(t)) return "POLITICS";
  if (/HIGH|LOW|RAIN|SNOW|TEMP|STORM|HURR/.test(t)) return "WEATHER";
  if (/SPORT|NBA|NFL|MLB|NHL|SOCCER|WC26|FIFWC|FIFA|UFC|TENNIS|GOLF|F1|MATCH|GAME|WORLD CUP|CHAMPION|EXACT SCORE|SPREAD:|O\/U |OVER\/UNDER|\bVS\.?\b|1ST HALF|FIRST HALF|GOALSCORER|CORNERS|PREMIER LEAGUE|LA LIGA|SERIE A|BUNDESLIGA|GRAND PRIX|HOME RUN|TOUCHDOWN/.test(t)) return "SPORTS";
  return "MARKET";
}
function kalshiCat(evCat, ticker, title) {
  const c = String(evCat || "").toLowerCase();
  if (c.indexOf("sport") >= 0) return "SPORTS";
  if (c.indexOf("crypto") >= 0) return "CRYPTO";
  if (c.indexOf("econ") >= 0 || c.indexOf("financ") >= 0) return "ECON";
  if (c.indexOf("climate") >= 0 || c.indexOf("weather") >= 0) return "WEATHER";
  if (c.indexOf("politic") >= 0 || c.indexOf("election") >= 0) return "POLITICS";
  return tickerCat((ticker || "") + " " + (title || ""));
}

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const cents = (c, d) => { const n = num(c); if (n > 0) return Math.round(n); return Math.round(num(d) * 100); };

// event_ticker -> official category, cached 30 min (events list is big but stable)
async function eventCats(diag) {
  if (evCatCache.map && Date.now() - evCatCache.ts < 1800000) return evCatCache.map;
  const map = {};
  let cursor = "", pages = 0;
  try {
    do {
      const j = await kfetch("/events?limit=200&status=open" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), 9000, 1);
      (j.events || []).forEach(ev => { if (ev.event_ticker) map[ev.event_ticker] = ev.category || ""; });
      cursor = j.cursor || "";
      pages++;
    } while (cursor && pages < 15);
  } catch (e) { diag.push("evcats:" + String((e && e.message) || e)); }
  diag.push("evcats:" + Object.keys(map).length + "/" + pages + "pg");
  if (Object.keys(map).length) evCatCache = { ts: Date.now(), map };
  return map;
}

// raw Kalshi markets -> shaped, filtered desk markets (no quotas here)
function shape(raw, evMap) {
  const nowT = Date.now();
  const winMs = 1205 * 60000;
  const out = [];
  const seen = {};
  raw.forEach(m => {
    if (!m || !m.ticker || seen[m.ticker]) return;
    seen[m.ticker] = 1;
    if (m.status && m.status !== "active") return;
    if (m.mve_collection_ticker || (m.ticker || "").includes("KXMVE") || (m.event_ticker || "").includes("KXMVE")) return;
    if (/KXHIGH|KXLOW|KXTEMP/i.test(m.ticker || "")) return; // weather disabled by desk policy
    const bid = cents(m.yes_bid, m.yes_bid_dollars);
    const ask = cents(m.yes_ask, m.yes_ask_dollars) || 100;
    const last = cents(m.last_price, m.last_price_dollars);
    const yes = last > 0 ? last : Math.round((bid + ask) / 2);
    const closeTs = new Date(m.close_time).getTime();
    const vol = num(m.volume_24h) || num(m.volume_24h_fp) || num(m.volume) || num(m.volume_fp) || num(m.liquidity_dollars);
    const c = kalshiCat(evMap[m.event_ticker], m.ticker, m.title);
    if (c === "WEATHER") return;
    if (!(yes >= 5 && yes <= 95)) return;
    if (!(closeTs - nowT > 4 * 60000 && closeTs - nowT < winMs)) return;
    out.push({
      t: (m.title || m.ticker) + (m.yes_sub_title && m.yes_sub_title.length < 60 ? " \u2014 " + m.yes_sub_title : ""),
      ticker: m.ticker, c, yes, closeTs, vol, bid, ask
    });
  });
  // volume OR a real two-sided book qualifies: brand-new fast markets (fresh 15-min
  // crypto strikes) start at ~$0 volume but have tight live quotes
  const filtered = out.filter(m => m.vol > 50 || (m.bid >= 3 && m.ask <= 97 && m.ask - m.bid <= 10));
  return filtered.length ? filtered : out.filter(m => m.bid > 0 && m.ask < 100);
}

// per-category quotas so no category crowds out another
function quotaPool(all) {
  const byVol = all.slice().sort((a, b) => b.vol - a.vol);
  const sports = byVol.filter(m => m.c === "SPORTS").slice(0, 600);
  // crypto slots go soonest-settling first — fresh fast strikes carry $0 printed
  // volume and were losing their slots to stale high-volume dailies
  const crypto = all.filter(m => m.c === "CRYPTO").sort((a, b) => a.closeTs - b.closeTs).slice(0, 400);
  const other = byVol.filter(m => m.c !== "SPORTS" && m.c !== "CRYPTO").slice(0, 600);
  return other.concat(crypto, sports);
}

async function sweep() {
  const t0 = Date.now();
  const diag = [];
  const evMap = await eventCats(diag);
  // STATELESS FULL-LADDER SWEEP: serverless instances don't share memory, so a
  // rotating pointer never accumulates — instead every sweep walks ALL rungs.
  // Each close-time span is small enough to page in 1-2 requests, so the whole
  // ladder is ~20-30 cheap requests and can never bottleneck on pagination.
  let raw = [];
  const counts = [];
  for (const rung of RUNGS) {
    if (Date.now() - t0 > 42000) { diag.push("time-boxed at rung " + rung[0] + "m"); break; }
    const nowS = Math.floor(Date.now() / 1000);
    const W = "&min_close_ts=" + (nowS + rung[0] * 60) + "&max_close_ts=" + (nowS + rung[1] * 60);
    let cursor = "", pages = 0, got = 0;
    try {
      do {
        const j = await kfetch("/markets?limit=1000&status=open" + W + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), 9000, 1);
        raw = raw.concat(j.markets || []);
        got += (j.markets || []).length;
        cursor = j.cursor || "";
        pages++;
      } while (cursor && pages < 3 && Date.now() - t0 < 42000); // 3-page cap: rungs that blow past it are MVE parlay noise; real fast supply comes from the direct series lane
    } catch (e) { counts.push(rung[0] + "m:ERR"); continue; }
    counts.push(rung[0] + "m:" + got + (cursor ? "+" : ""));
  }
  diag.push("ladder " + counts.join(" "));

  // FAST-SERIES LANE: the desk's core supply — 15-min/hourly/daily crypto + index
  // dailies — probed DIRECTLY every call (no pagination risk, ~16 cheap requests)
  const fastSeries = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M", "KXDOGE15M", "KXBTC", "KXETH", "KXSOL", "KXXRP", "KXBTCD", "KXETHD", "KXSOLD", "KXXRPD", "KXDOGED", "KXINXD", "KXNASDAQ100D"];
  for (const s of fastSeries) {
    if (Date.now() - t0 > 50000) break;
    try {
      const j = await kfetch("/markets?limit=100&status=open&series_ticker=" + s, 8000, 1);
      raw = raw.concat(j.markets || []);
    } catch (e) {}
    await sleep(150);
  }

  const pool = quotaPool(shape(raw, evMap));
  const nSp = pool.filter(m => m.c === "SPORTS").length;
  const nCr = pool.filter(m => m.c === "CRYPTO").length;
  diag.push("pool:" + pool.length + " sports:" + nSp + " crypto:" + nCr);
  return { pool, diag };
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", "*");
  try {
    const url = new URL(req.url, "http://x");
    const tickers = url.searchParams.get("tickers");
    if (tickers) {
      const list = tickers.split(",").slice(0, 90);
      const j = await kfetch("/markets?limit=100&tickers=" + encodeURIComponent(list.join(",")), 8000, 1);
      const quotes = {};
      (j.markets || []).forEach(m => {
        const bid = cents(m.yes_bid, m.yes_bid_dollars);
        const ask = cents(m.yes_ask, m.yes_ask_dollars) || 100;
        const last = cents(m.last_price, m.last_price_dollars);
        const yes = last > 0 ? last : Math.round((bid + ask) / 2);
        if (yes >= 1 && yes <= 99) quotes[m.ticker] = { yes, bid, ask };
      });
      return res.status(200).json({ ts: Date.now(), quotes });
    }
    // 45s cache — a full-ladder sweep is ~25 requests, so don't re-run it per client tick
    if (cache.pool && cache.pool.length && Date.now() - cache.ts < 45000) {
      return res.status(200).json({ ts: cache.ts, ageMs: Date.now() - cache.ts, cached: true, pool: cache.pool, diag: cache.diag });
    }
    if (!inflight) inflight = sweep().finally(() => { inflight = null; });
    const { pool, diag } = await inflight;
    if (pool.length) cache = { ts: Date.now(), pool, diag };
    else if (cache.pool && cache.pool.length) {
      return res.status(200).json({ ts: cache.ts, ageMs: Date.now() - cache.ts, stale: true, pool: cache.pool, diag: cache.diag.concat(diag) });
    }
    return res.status(200).json({ ts: Date.now(), ageMs: 0, cached: false, pool, diag });
  } catch (e) {
    if (cache.pool && cache.pool.length) return res.status(200).json({ ts: cache.ts, ageMs: Date.now() - cache.ts, stale: true, pool: cache.pool, diag: cache.diag });
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
