// Kalshi Desk — MARKET FEED (Vercel serverless, srv feed-1).
// Does the heavy tri-lane market sweep SERVER-SIDE (no CORS, no browser rate-limit
// races) and returns one compact pool JSON. Cached in-memory per warm lambda for 45s,
// so the whole dashboard costs ~1 request/minute instead of ~80.
//
//   GET /api/feed            -> { ts, ageMs, pool: [{t,ticker,c,yes,closeTs,vol,bid,ask}] }
//   GET /api/feed?tickers=A,B -> { ts, quotes: { TICKER: {yes,bid,ask} } }  (fast lane)
//
// Public market data only — no keys, no secret required.
const KBASE = "https://api.elections.kalshi.com/trade-api/v2";

let cache = { ts: 0, pool: null };
let seriesCache = { ts: 0, list: null };
let inflight = null;

async function kfetch(path, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 9000);
  try {
    const r = await fetch(KBASE + path, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
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

function shape(raw) {
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
    const c = m._evcat || tickerCat(m.ticker + " " + (m.title || ""));
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
  const laneEvents = (async () => {
    let cursor = "", raw = [], pages = 0;
    do {
      const j = await kfetch("/events?limit=200&status=open&with_nested_markets=true" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), 9000);
      (j.events || []).forEach(ev => {
        const cat = kalshiCat(ev.category, ev.event_ticker, ev.title);
        (ev.markets || []).forEach(m => { m._evcat = cat; raw.push(m); });
      });
      cursor = j.cursor || "";
      pages++;
    } while (cursor && pages < 10 && raw.length < 6000 && Date.now() - t0 < 25000);
    diag.push("events:" + raw.length + "/" + pages + "pg");
    return raw;
  })();
  const laneWindow = (async () => {
    let cursor = "", raw = [], pages = 0;
    do {
      const j = await kfetch("/markets?limit=1000&status=open" + W + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), 9000);
      raw = raw.concat(j.markets || []);
      cursor = j.cursor || "";
      pages++;
    } while (cursor && pages < 10 && raw.length < 8000 && Date.now() - t0 < 25000);
    diag.push("window:" + raw.length + "/" + pages + "pg");
    return raw;
  })();
  const laneSeries = (async () => {
    const staticList = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M", "KXBTCD", "KXETHD", "KXBTC", "KXETH", "KXXRPD", "KXSOLD", "KXDOGED", "KXINX", "KXINXD", "KXINXU", "KXNASDAQ100", "KXNASDAQ100D", "KXNASDAQ100U", "KXBTCUP", "KXETHUP", "KXMLBGAME", "KXWNBAGAME", "KXNBAGAME", "KXNHLGAME", "KXUFCFIGHT", "KXWCTOTAL", "KXWCSPREAD", "KXWCADVANCE"];
    let discovered = (seriesCache.list && Date.now() - seriesCache.ts < 1800000) ? seriesCache.list : null;
    if (!discovered) {
      const cats = ["Sports", "Crypto", "Financials", "Economics", "World", "Entertainment", "Politics", "Science and Technology"];
      const rs = await Promise.all(cats.map(c => kfetch("/series?category=" + encodeURIComponent(c), 8000).catch(() => null)));
      let ser = [];
      rs.forEach(j => { if (j && j.series) ser = ser.concat(j.series); });
      discovered = ser.map(s => s.ticker).filter(Boolean);
      if (discovered.length) seriesCache = { ts: Date.now(), list: discovered };
    }
    const spFirst = s => /GAME|MATCH|FIGHT|NBA|NFL|MLB|NHL|WNBA|UFC|WC|FIFWC|FIFA|SOCCER|TENNIS|GOLF|F1|EPL|LALIGA|SERIEA|BUNDES/i.test(s) ? 0 : 1;
    const series = Array.from(new Set(staticList.concat(discovered))).sort((a, b) => spFirst(a) - spFirst(b)).slice(0, 48);
    const raw = [];
    for (let i = 0; i < series.length; i += 8) {
      if (Date.now() - t0 > 25000) break;
      const rs = await Promise.all(series.slice(i, i + 8).map(s => kfetch("/markets?limit=100&status=open&series_ticker=" + s, 8000).catch(() => null)));
      rs.forEach(j => { if (j && j.markets) raw.push.apply(raw, j.markets); });
    }
    diag.push("series:" + raw.length);
    return raw;
  })();
  const rs = await Promise.all([laneEvents.catch(() => []), laneWindow.catch(() => []), laneSeries.catch(() => [])]);
  const pool = shape(rs[0].concat(rs[1], rs[2]));
  return { pool, diag };
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", "*");
  try {
    const url = new URL(req.url, "http://x");
    const tickers = url.searchParams.get("tickers");
    if (tickers) {
      // fast quote lane: one upstream call, up to 90 tickers
      const list = tickers.split(",").slice(0, 90);
      const j = await kfetch("/markets?limit=100&tickers=" + encodeURIComponent(list.join(",")), 8000);
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
    if (cache.pool && Date.now() - cache.ts < 45000) {
      return res.status(200).json({ ts: cache.ts, ageMs: Date.now() - cache.ts, cached: true, pool: cache.pool, diag: cache.diag });
    }
    if (!inflight) inflight = sweep().finally(() => { inflight = null; });
    const { pool, diag } = await inflight;
    if (pool.length) cache = { ts: Date.now(), pool, diag };
    return res.status(200).json({ ts: Date.now(), ageMs: 0, cached: false, pool, diag });
  } catch (e) {
    if (cache.pool) return res.status(200).json({ ts: cache.ts, ageMs: Date.now() - cache.ts, stale: true, pool: cache.pool, diag: cache.diag });
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
