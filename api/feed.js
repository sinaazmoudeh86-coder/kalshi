// Kalshi Desk — MARKET FEED (Vercel serverless, srv feed-2).
// The desk's ONLY heavy sweeper. Browser makes 1 request; this function talks to
// Kalshi with rate-limit discipline (sequential pages, 429 retry with backoff),
// caches the shaped pool for 45s, and caches the event→category map for 30 min.
//
//   GET /api/feed             -> { ts, ageMs, pool: [{t,ticker,c,yes,closeTs,vol,bid,ask}], diag }
//   GET /api/feed?tickers=A,B -> { ts, quotes: { TICKER: {yes,bid,ask} } }  (fast lane)
//
// Design: the WINDOW query (/markets with min/max_close_ts) is the source of truth —
// Kalshi filters by close time server-side, so every market that settles within 18.5h
// arrives regardless of series naming. Categories come from a cached /events map
// (event_ticker -> official category); ticker regex is only the fallback.
// Public market data only — no keys, no secret required.
const KBASE = "https://api.elections.kalshi.com/trade-api/v2";

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

function shape(raw, evMap) {
  const nowT = Date.now();
  const winMs = 1205 * 60000; // 18h35m + margin
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
  let pool = out.filter(m => m.vol > 50);
  if (pool.length < 3) pool = out.filter(m => m.bid > 0 && m.ask < 100);
  const sorted = pool.sort((a, b) => b.vol - a.vol);
  const sports = sorted.filter(m => m.c === "SPORTS").slice(0, 600);
  const crypto = sorted.filter(m => m.c === "CRYPTO").slice(0, 400);
  const other = sorted.filter(m => m.c !== "SPORTS" && m.c !== "CRYPTO").slice(0, 600);
  return other.concat(crypto, sports);
}

async function sweep() {
  const t0 = Date.now();
  const nowS = Math.floor(t0 / 1000);
  const W = "&min_close_ts=" + (nowS + 240) + "&max_close_ts=" + (nowS + 72300);
  const diag = [];
  // source of truth: the close-window query — Kalshi filters by settle time server-side
  let raw = [], cursor = "", pages = 0;
  do {
    const j = await kfetch("/markets?limit=1000&status=open" + W + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), 9000, 2);
    raw = raw.concat(j.markets || []);
    cursor = j.cursor || "";
    pages++;
  } while (cursor && pages < 12 && raw.length < 10000 && Date.now() - t0 < 30000);
  diag.push("window:" + raw.length + "/" + pages + "pg");
  const evMap = await eventCats(diag);
  const pool = shape(raw, evMap);
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
