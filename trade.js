// External market-data proxy — Vercel serverless function. NO env vars needed.
// One browser request sweeps: crypto spot (Kraken primary — one upstream call for
// all symbols — Coinbase per-symbol fallback), index quotes (Yahoo, best-effort),
// and NWS station observations for the weather lane.
// Everything is best-effort and degrades gracefully: a dead upstream returns
// nothing for its section plus a diag note, never an error status.

let CACHE = { ts: 0, key: "", body: null }; // per-instance micro-cache (12s)

async function jfetch(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 4500);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
    const j = await r.json();
    return { ok: r.ok, status: r.status, json: j };
  } finally { clearTimeout(t); }
}

const KRAKEN_PAIRS = { BTC: "XXBTZUSD", ETH: "XETHZUSD", SOL: "SOLUSD", XRP: "XXRPZUSD", DOGE: "XDGUSD" };
const COINBASE_IDS = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD", XRP: "XRP-USD", DOGE: "DOGE-USD" };
const YAHOO_IDS = { SPX: "%5EGSPC", NDX: "%5ENDX" };

async function getCrypto(diag) {
  const out = {};
  const now = Date.now();
  try {
    const pairs = Object.values(KRAKEN_PAIRS).join(",");
    const r = await jfetch("https://api.kraken.com/0/public/Ticker?pair=" + pairs, null, 4500);
    if (r.ok && r.json && r.json.result) {
      Object.keys(KRAKEN_PAIRS).forEach(sym => {
        const row = r.json.result[KRAKEN_PAIRS[sym]];
        const p = row && row.c && parseFloat(row.c[0]);
        if (p > 0) out[sym] = { p, ts: now, src: "KRAKEN" };
      });
    }
  } catch (e) { diag.push("kraken: " + String((e && e.message) || e)); }
  const missing = Object.keys(KRAKEN_PAIRS).filter(s => !out[s]);
  if (missing.length) {
    const rs = await Promise.allSettled(missing.map(sym =>
      jfetch("https://api.coinbase.com/v2/prices/" + COINBASE_IDS[sym] + "/spot", null, 4000)));
    rs.forEach((r, i) => {
      const sym = missing[i];
      if (r.status === "fulfilled" && r.value.ok) {
        const p = parseFloat(r.value.json && r.value.json.data && r.value.json.data.amount);
        if (p > 0) out[sym] = { p, ts: now, src: "COINBASE" };
      }
    });
    if (missing.some(s => !out[s])) diag.push("crypto missing: " + missing.filter(s => !out[s]).join(","));
  }
  return out;
}

async function getIndexes(diag) {
  const out = {};
  const rs = await Promise.allSettled(Object.keys(YAHOO_IDS).map(sym =>
    jfetch("https://query1.finance.yahoo.com/v8/finance/chart/" + YAHOO_IDS[sym] + "?interval=1m&range=1d",
      { headers: { "user-agent": "Mozilla/5.0 (kalshi-desk spot fn)" } }, 4500)));
  Object.keys(YAHOO_IDS).forEach((sym, i) => {
    const r = rs[i];
    if (r.status !== "fulfilled" || !r.value.ok) { diag.push("yahoo " + sym + ": unreachable"); return; }
    try {
      const res = r.value.json.chart.result[0];
      const p = res.meta.regularMarketPrice;
      const open = res.meta.regularMarketTime ? res.meta.regularMarketTime * 1000 : Date.now();
      if (p > 0) out[sym] = { p, ts: open, src: "YAHOO" };
    } catch (e) { diag.push("yahoo " + sym + ": parse"); }
  });
  return out;
}

// NWS observations: return a compact recent series per station; the dashboard
// computes "observed high/low since local midnight" with its own DST tables.
async function getWx(stations, diag) {
  const out = {};
  const list = (stations || []).slice(0, 10); // cap upstream fan-out
  const rs = await Promise.allSettled(list.map(id =>
    jfetch("https://api.weather.gov/stations/" + encodeURIComponent(id) + "/observations?limit=60",
      { headers: { "user-agent": "(kalshi-desk, contact: dashboard user)", accept: "application/geo+json" } }, 5000)));
  list.forEach((id, i) => {
    const r = rs[i];
    if (r.status !== "fulfilled" || !r.value.ok) { diag.push("nws " + id + ": unreachable"); return; }
    try {
      const feats = (r.value.json.features || []);
      const obs = feats.map(f => {
        const pr = f.properties || {};
        const c = pr.temperature && pr.temperature.value;
        if (c == null) return null;
        return { ts: new Date(pr.timestamp).getTime(), f: Math.round((c * 9 / 5 + 32) * 10) / 10 };
      }).filter(Boolean).sort((a, b) => a.ts - b.ts);
      if (obs.length) out[id] = { obs: obs.slice(-48) };
      else diag.push("nws " + id + ": no temps");
    } catch (e) { diag.push("nws " + id + ": parse"); }
  });
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  try {
    const q = req.query || {};
    const wxIds = String(q.wx || "").split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]{3,5}$/.test(s));
    const key = wxIds.join(",");
    if (CACHE.body && CACHE.key === key && Date.now() - CACHE.ts < 12000) {
      return res.status(200).json(Object.assign({}, CACHE.body, { cached: true, ageMs: Date.now() - CACHE.ts }));
    }
    const diag = [];
    const [crypto, idx, wx] = await Promise.all([
      getCrypto(diag),
      getIndexes(diag),
      wxIds.length ? getWx(wxIds, diag) : Promise.resolve({})
    ]);
    const body = { crypto, idx, wx, diag, ts: Date.now(), srv: 1 };
    CACHE = { ts: Date.now(), key, body };
    return res.status(200).json(body);
  } catch (e) {
    return res.status(200).json({ crypto: {}, idx: {}, wx: {}, diag: ["spot fn: " + String((e && e.message) || e)], ts: Date.now(), srv: 1 });
  }
};
