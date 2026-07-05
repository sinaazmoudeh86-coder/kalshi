// Kalshi Desk — SERVER-SIDE ENGINE (Vercel serverless, srv 49).
// Runs the full desk loop (scan → gates → enter → manage → settle → learn) on a
// schedule, WITHOUT a browser tab open. State lives in Upstash/Vercel KV.
//
// Endpoints (all require TRADE_SECRET via x-trade-secret header or ?secret=):
//   GET  /api/engine?action=tick    <- one full sweep. Point a cron/pinger here every 1 min.
//   GET  /api/engine?action=state   <- full state for the dashboard (log, events, cfg, heartbeat)
//   POST /api/engine {action:"arm", armed:true|false}
//   POST /api/engine {action:"reset"}   <- clears the bet log
//
// Env vars: TRADE_SECRET (required), KV_REST_API_URL + KV_REST_API_TOKEN
// (or UPSTASH_REDIS_REST_URL/TOKEN), and for LIVE orders:
// KALSHI_ACCESS_KEY + KALSHI_PRIVATE_KEY. TRADING_HALTED=true = kill switch.
const crypto = require("crypto");

const KBASE = "https://api.elections.kalshi.com/trade-api/v2";
const STATE_KEY = "kpd:state:v1";

// ---------- KV (Upstash REST) ----------
function kvCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
async function kvCmd(cmd) {
  const kv = kvCfg();
  if (!kv) throw new Error("KV not configured — add Upstash/Vercel KV env vars");
  const r = await fetch(kv.url, {
    method: "POST",
    headers: { authorization: "Bearer " + kv.token, "content-type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("KV " + r.status + ": " + JSON.stringify(j).slice(0, 120));
  return j.result;
}
async function loadState() {
  const raw = await kvCmd(["GET", STATE_KEY]);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  return { v: 1, startTs: Date.now(), bets: [], events: [], phist: {}, cfg: { armed: false }, effHorizon: 60, lastTickTs: 0 };
}
async function saveState(S) {
  // keep the blob lean: trim phist + events, drop dead price histories
  const cut = Date.now() - 2 * 3600000;
  Object.keys(S.phist || {}).forEach(k => {
    S.phist[k] = (S.phist[k] || []).slice(-30);
    if (!S.phist[k].length || S.phist[k][S.phist[k].length - 1].ts < cut) delete S.phist[k];
  });
  S.events = (S.events || []).slice(0, 50);
  if (S.bets.length > 600) S.bets = S.bets.slice(-600);
  await kvCmd(["SET", STATE_KEY, JSON.stringify(S)]);
}

// ---------- Kalshi signed (live trading) ----------
function getPem() {
  let k = process.env.KALSHI_PRIVATE_KEY || "";
  if (k && !k.includes("BEGIN")) { try { k = Buffer.from(k, "base64").toString("utf8"); } catch (e) {} }
  return k;
}
function liveKeysOk() { return !!(process.env.KALSHI_ACCESS_KEY && getPem()); }
function sign(method, path) {
  const ts = Date.now().toString();
  const sig = crypto.sign("sha256", Buffer.from(ts + method + path.split("?")[0]), {
    key: getPem(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }).toString("base64");
  return { ts, sig };
}
async function kalshiAuth(method, path, body) {
  const { ts, sig } = sign(method, path);
  const r = await fetch(KBASE.replace("/trade-api/v2", "") + path, {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": process.env.KALSHI_ACCESS_KEY || "",
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
async function fetchJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 9000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------- shared desk logic (ported 1:1 from the dashboard) ----------
function pushEvent(S, icon, color, text, opts) {
  S.events = S.events || [];
  const e = { ts: Date.now(), icon, color, text, kind: (opts && opts.kind) || "" };
  if (opts && opts.coalesce && S.events.length && S.events[0].kind === e.kind) S.events[0] = e;
  else S.events.unshift(e);
  if (S.events.length > 50) S.events.length = 50;
}
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function tickerCat(t) {
  t = (t || "").toUpperCase();
  if (/BTC|ETH|SOL|XRP|DOGE|CRYPTO|BITCOIN|ETHEREUM/.test(t)) return "CRYPTO";
  if (/FED|CPI|GDP|JOBS|CLAIMS|PAYROLL|RATE|INX|NASDAQ|S&P|TNOTE|RECESSION|INFLATION/.test(t)) return "ECON";
  if (/OIL|GAS|GOLD|SILVER|WTI|BRENT|COMMOD/.test(t)) return "COMMOD";
  if (/ELECTION|PRESIDENT|SENATE|GOVERNOR|CONGRESS|NOMINEE|PRIMARY|POLITIC|WHITE HOUSE|SUPREME COURT/.test(t)) return "POLITICS";
  if (/HIGH|LOW|RAIN|SNOW|TEMP|STORM|HURR/.test(t)) return "WEATHER";
  if (/NBA|NFL|MLB|NHL|SOCCER|WC26|UFC|TENNIS|GOLF|F1|MATCH|GAME|WORLD CUP|CHAMPION/.test(t)) return "SPORTS";
  return "MARKET";
}
function pnlOf(b) {
  if (b.result === "void") return 0;
  if (b.realPnl != null && b.result) return b.realPnl;
  const fee = b.fee || 0;
  if (b.result === "won") return b.contracts * (100 - b.pc) / 100 - fee;
  if (b.result === "lost") return -(b.contracts * b.pc / 100) - fee;
  return 0;
}
function fmt$(v) { return (v < 0 ? "-$" : "+$") + Math.abs(v).toFixed(2); }
function isWeatherBet(t) { return /KXHIGH|KXLOW|KXTEMP/i.test(t || ""); }
function horizonMins(S) { return S.effHorizon || 60; }

function mapKalshi(S, j) {
  const nowT = Date.now();
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const cents = (c, d) => { const n = num(c); if (n > 0) return Math.round(n); return Math.round(num(d) * 100); };
  const mapped = (j.markets || [])
    .filter(m => !m.status || m.status === "active")
    .filter(m => !m.mve_collection_ticker && !(m.ticker || "").includes("KXMVE") && !(m.event_ticker || "").includes("KXMVE"))
    .filter(m => !/KXHIGH|KXLOW|KXTEMP/i.test(m.ticker || ""))
    .map(m => {
      const bid = cents(m.yes_bid, m.yes_bid_dollars);
      const ask = cents(m.yes_ask, m.yes_ask_dollars) || 100;
      const last = cents(m.last_price, m.last_price_dollars);
      const yes = last > 0 ? last : Math.round((bid + ask) / 2);
      const closeTs = new Date(m.close_time).getTime();
      const vol = num(m.volume_24h) || num(m.volume_24h_fp) || num(m.volume) || num(m.volume_fp) || num(m.liquidity_dollars);
      return {
        t: (m.title || m.ticker) + (m.yes_sub_title && m.yes_sub_title.length < 60 ? " \u2014 " + m.yes_sub_title : ""),
        ticker: m.ticker || "",
        c: tickerCat(m.ticker + " " + (m.title || "")),
        yes, closeTs, vol, _bid: bid, _ask: ask
      };
    })
    .filter(m => m.yes >= 5 && m.yes <= 95 && m.closeTs - nowT > 4 * 60000 && m.closeTs - nowT < ((m.c === "SPORTS" ? 1080 : horizonMins(S)) + 125) * 60000);
  let pool = mapped.filter(m => m.vol > 50);
  if (pool.length < 3) pool = mapped.filter(m => m._bid > 0 && m._ask < 100);
  return pool.sort((a, b) => b.vol - a.vol).slice(0, 80);
}

async function refreshPool(S, now) {
  if (S.pool && S.pool.length && now - (S.poolTs || 0) < 150000) {
    S.pool = S.pool.filter(m => m.closeTs > now + 4 * 60000);
    if (S.pool.length >= 3) return;
  }
  const nowS = Math.floor(now / 1000);
  const W = "&min_close_ts=" + (nowS + 240) + "&max_close_ts=" + (nowS + Math.max(72300, (horizonMins(S) + 125) * 60));
  const staticList = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M", "KXBTCD", "KXETHD", "KXBTC", "KXETH", "KXXRPD", "KXSOLD", "KXDOGED", "KXINX", "KXINXD", "KXINXU", "KXNASDAQ100", "KXNASDAQ100D", "KXNASDAQ100U", "KXBTCUP", "KXETHUP", "KXMLBGAME", "KXWNBAGAME", "KXNBAGAME", "KXNHLGAME", "KXUFCFIGHT", "KXWCTOTAL", "KXWCSPREAD", "KXWCADVANCE"];
  const diag = [];
  let all = [];
  // 1) series catalog (cached 30 min) — sports/crypto series are the desk's bread & butter
  try {
    let discovered = (S.seriesCache && now - (S.seriesCacheTs || 0) < 1800000) ? S.seriesCache : null;
    if (!discovered) {
      const cats = ["Crypto", "Financials", "Economics", "Sports", "World", "Entertainment", "Politics", "Science and Technology"];
      const rs = await Promise.all(cats.map(c => fetchJson(KBASE + "/series?category=" + encodeURIComponent(c), 8000).catch(() => null)));
      let ser = [];
      rs.forEach(j => { if (j && j.series) ser = ser.concat(j.series); });
      const freq = s => ((s && s.frequency) || "").toLowerCase();
      discovered = ser.filter(s => /hour|daily|day|weekly/.test(freq(s))).concat(ser.filter(s => !/hour|daily|day|weekly/.test(freq(s)))).map(s => s.ticker).filter(Boolean);
      if (discovered.length) { S.seriesCache = discovered; S.seriesCacheTs = now; }
      diag.push("catalog: " + discovered.length + " series");
    }
    const series = Array.from(new Set(staticList.concat(discovered || []))).slice(0, 30);
    for (let i = 0; i < series.length; i += 6) {
      const rs = await Promise.all(series.slice(i, i + 6).map(s =>
        fetchJson(KBASE + "/markets?limit=100&status=open&series_ticker=" + s, 8000).catch(() => null)));
      rs.forEach(j => { if (j && j.markets) all = all.concat(j.markets); });
      if (mapKalshi(S, { markets: all }).length >= 20) break;
    }
  } catch (e) { diag.push("series: " + String((e && e.message) || e)); }
  // 2) wide open-markets window (fills gaps, catches sports events without a probed series)
  try {
    let cursor = "", pages = 0;
    do {
      const j = await fetchJson(KBASE + "/markets?limit=1000&status=open" + W + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), 9000);
      all = all.concat(j.markets || []);
      cursor = j.cursor || "";
      pages++;
    } while (cursor && pages < 3 && mapKalshi(S, { markets: all }).length < 30);
  } catch (e) { diag.push("window: " + String((e && e.message) || e)); }
  const pool = mapKalshi(S, { markets: all });
  if (pool.length) {
    S.pool = pool; S.poolTs = now; S.feedDiag = diag;
    // AUTO horizon: widen when thin, tighten when rich (same tiers as the dashboard)
    const tiers = [60, 240, 720, 1440];
    const i = tiers.indexOf(S.effHorizon || 60);
    if (pool.length < 6 && i >= 0 && i < 3) { S.effHorizon = tiers[i + 1]; pushEvent(S, "\u27f3", "#eab54e", "AUTO HORIZON: thin pool (" + pool.length + ") \u2014 widening to " + (tiers[i + 1] / 60) + "h", { kind: "autoh", coalesce: true }); }
    else if (pool.length >= 14 && i > 0) { S.effHorizon = tiers[i - 1]; pushEvent(S, "\u27f3", "#5aa7e8", "AUTO HORIZON: rich pool \u2014 tightening to " + (tiers[i - 1] >= 60 ? (tiers[i - 1] / 60) + "h" : tiers[i - 1] + "m"), { kind: "autoh", coalesce: true }); }
    pushEvent(S, "\u27f3", "#5aa7e8", "feed connected \u00b7 KALSHI \u00b7 " + pool.length + " tradable markets (server sweep)", { kind: "feed", coalesce: true });
  } else {
    S.pool = (S.pool || []).filter(m => m.closeTs > now + 4 * 60000);
    pushEvent(S, "\u27f3", "#e5636a", "feed refresh thin \u2014 " + diag.join("; "), { kind: "feed", coalesce: true });
  }
}

function learnModel(S, now) {
  const bets = (S.bets || []).filter(b => b.result === "won" || b.result === "lost");
  const wOf = b => (b.settledBy === "real" || b.settledBy === "manual") ? 2 : 1;
  const expOf = b => Math.min(0.95, b.pc / 100 + 0.02);
  let n = 0, w = 0, exp = 0;
  bets.forEach(b => { const wt = wOf(b); n += wt; w += (b.result === "won" ? wt : 0); exp += wt * expOf(b); });
  const shortfall = n > 0 ? Math.max(0, (exp - w) / n) : 0;
  const calib = Math.round(Math.min(4, shortfall * 100 * (n / (n + 20))) * 10) / 10;
  const cat = {};
  bets.forEach(b => {
    const wt = wOf(b);
    const c = cat[b.cat] = cat[b.cat] || { n: 0, w: 0, exp: 0 };
    c.n += wt; c.w += (b.result === "won" ? wt : 0); c.exp += wt * expOf(b);
  });
  const bandOf = pc2 => pc2 >= 86 ? "86c+" : pc2 >= 80 ? "80-85c" : pc2 >= 70 ? "70-79c" : "<70c";
  const bandStats = {};
  bets.forEach(b => {
    const wt = wOf(b);
    const c = bandStats[bandOf(b.pc)] = bandStats[bandOf(b.pc)] || { n: 0, w: 0, exp: 0 };
    c.n += wt; c.w += (b.result === "won" ? wt : 0); c.exp += wt * expOf(b);
  });
  const shrink = (c, cap) => {
    const expRate = c.exp / c.n;
    const adjRate = (c.w + 2 * expRate) / (c.n + 2);
    const short = Math.max(0, expRate - adjRate);
    return { extra: Math.round(Math.min(cap, short * 100 * (c.n / (c.n + 8))) * 10) / 10, mult: Math.max(0.6, Math.min(1.25, adjRate / Math.max(expRate, 0.05))) };
  };
  const catAdj = {}; Object.keys(cat).forEach(k => { catAdj[k] = shrink(cat[k], 5); });
  const bandAdj = {}; Object.keys(bandStats).forEach(k => { bandAdj[k] = shrink(bandStats[k], 4); });
  const byCat = {};
  bets.slice().sort((a, b) => a.closeTs - b.closeTs).forEach(b => { (byCat[b.cat] = byCat[b.cat] || []).push(b); });
  const blocked = {};
  Object.keys(byCat).forEach(k => {
    const arr = byCat[k];
    let streak = 0, lastTs = 0;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].result === "lost") { streak++; lastTs = Math.max(lastTs, arr[i].closeTs); } else break; }
    if (streak >= 3 && now < lastTs + 2 * 3600000) blocked[k] = lastTs + 2 * 3600000;
  });
  const allS = bets.slice().sort((a, b) => a.closeTs - b.closeTs);
  let gStreak = 0, gLast = 0;
  for (let i = allS.length - 1; i >= 0; i--) { if (allS[i].result === "lost") { gStreak++; gLast = Math.max(gLast, allS[i].closeTs); } else break; }
  const haltUntil = (gStreak >= 5 && now < gLast + 3600000) ? gLast + 3600000 : 0;
  return { calib, catAdj, blocked, haltUntil,
    reqEdge: (c, pc2) => Math.round((2.5 + calib + ((catAdj[c] && catAdj[c].extra) || 0) + ((pc2 != null && bandAdj[bandOf(pc2)] && bandAdj[bandOf(pc2)].extra) || 0)) * 10) / 10 };
}
function categoryPerf(S) {
  const agg = {}, out = {};
  (S.bets || []).filter(b => b.result).forEach(b => {
    const k = b.cat; agg[k] = agg[k] || { n: 0, act: 0, exp: 0 };
    agg[k].n++; agg[k].act += b.result === "won" ? 1 : 0; agg[k].exp += Math.min(0.95, b.pc / 100 + 0.03);
  });
  Object.keys(agg).forEach(k => {
    const a = agg[k];
    out[k] = Math.max(0.85, Math.min(1.15, 1 + ((a.act - a.exp) / a.n) * 0.8));
  });
  return out;
}
function domainLogic(S, m, side, pc, minsLeft, now) {
  const tk = ((m.ticker || "") + " " + (m.t || "")).toUpperCase();
  const hist = (S.phist && S.phist[m.ticker]) || [];
  const past = hist.filter(h => h.ts <= now - 8 * 60000);
  const old = past.length ? past[past.length - 1] : (hist[0] || null);
  const range = hist.length >= 2 ? Math.max.apply(null, hist.map(h => h.yes)) - Math.min.apply(null, hist.map(h => h.yes)) : 0;
  const drift = old ? m.yes - old.yes : 0;
  const sideDrift = side === "YES" ? drift : -drift;
  if (/KXBTC|KXETH|KXSOL|KXXRP|KXDOGE|BITCOIN|ETHEREUM|SOLANA/.test(tk)) {
    if (pc < 66 && minsLeft <= 20) return { ok: false, extra: 0, label: "crypto: <66c near expiry = ATM coin-flip (max gamma + fee drag)", val: pc + "c@" + Math.round(minsLeft) + "m" };
    if (sideDrift <= -5) return { ok: false, extra: 0, label: "crypto: tape moving against this side over last 10m", val: sideDrift + "c/10m" };
    let extra = 0;
    if (range >= 10) extra += 2.5; else if (range >= 6) extra += 1;
    if (sideDrift >= 4) extra -= 0.5;
    extra += Math.min(2, (minsLeft / 60) * (range / 12));
    return { ok: true, extra: Math.round(extra * 10) / 10, label: "crypto 0DTE: ITM favorite + stable tape wins by time decay", val: "\u00b1" + Math.round(range) + "c " + (sideDrift >= 0 ? "+" : "") + sideDrift + "c" };
  }
  if (/KXHIGH|KXLOW|KXTEMP|HIGH TEMP|LOW TEMP/.test(tk)) {
    return { ok: false, extra: 0, label: "weather markets disabled", val: "off" };
  }
  if (m.c === "SPORTS") {
    const spr = (m._ask != null && m._bid != null && m._ask > 0 && m._bid > 0) ? m._ask - m._bid : null;
    if (pc < 80) return { ok: false, extra: 0, bandMin: 80, bandMax: 94, label: "sports: <80c = single-event variance too high \u2014 heavy favorites only", val: pc + "c" };
    if (spr != null && spr > 4) return { ok: false, extra: 0, bandMin: 80, bandMax: 94, label: "sports: bid/ask spread over 4c \u2014 thin or uncertain book", val: spr + "c spread" };
    if (range >= 12) return { ok: false, extra: 0, bandMin: 80, bandMax: 94, label: "sports: sharp odds movement \u2014 someone knows something", val: "\u00b1" + Math.round(range) + "c/10m" };
    if (sideDrift <= -4) return { ok: false, extra: 0, bandMin: 80, bandMax: 94, label: "sports: line moving against this side (live-game swing risk)", val: sideDrift + "c/10m" };
    let extra = 1.5;
    extra += Math.round(Math.min(1, minsLeft / 360) * 1.5 * 10) / 10;
    if (range >= 8) extra += 1.5;
    return { ok: true, extra: Math.round(extra * 10) / 10, bandMin: 80, bandMax: 94, volMin: 1000, label: "sports: 80-94c favorite, tight spread, stable line, $1k+ volume", val: pc + "c " + (sideDrift >= 0 ? "+" : "") + sideDrift + "c/10m" + (spr != null ? " \u00b7 " + spr + "c spr" : "") };
  }
  return { ok: true, extra: 0, label: "no domain model for this market family", val: "n/a" };
}

function evaluate(S, now) {
  const M = S.pool || [];
  const curHour = Math.floor(now / 3600000);
  const bucket = Math.floor(now / 600000);
  const nextTop = (curHour + 1) * 3600000;
  const perf = categoryPerf(S);
  const L = learnModel(S, now);
  const openBets = (S.bets || []).filter(b => !b.result);
  const cands = [];
  S.phist = S.phist || {};
  M.forEach(m => {
    if (!m.ticker) return;
    const a = S.phist[m.ticker] = S.phist[m.ticker] || [];
    const last = a[a.length - 1];
    if (!last || now - last.ts > 45000) { a.push({ ts: now, yes: m.yes }); if (a.length > 30) a.splice(0, a.length - 30); }
  });
  M.forEach((m, idx) => {
    const closeTs = m.closeTs || nextTop;
    const minsLeft = (closeTs - now) / 60000;
    const yes = Math.max(3, Math.min(97, m.yes));
    ["YES", "NO"].forEach(side => {
      const pc = side === "YES" ? yes : 100 - yes;
      const contracts = Math.floor(2500 / Math.max(pc, 1));
      const winProb = Math.min(0.95, pc / 100 + 0.03);
      const sig = (rng(Math.imul(bucket, 40503) ^ (idx * 131) ^ (side === "YES" ? 7 : 13))() - 0.4) * 7;
      const edge = Math.round((3 + sig) * 10) / 10;
      const feeC = Math.round(7 * (pc / 100) * (1 - pc / 100) * 10) / 10;
      const fee = Math.ceil(contracts * feeC) / 100;
      const netEdge = Math.round((edge - feeC) * 10) / 10;
      const boost = perf[m.c] || 1;
      const evNorm = Math.min(contracts * 0.03 / 2, 1);
      const edgeNorm = Math.min(Math.max((netEdge - 2.5) / 4, 0), 1);
      const score = Math.round((winProb * 0.55 + evNorm * 0.30 + edgeNorm * 0.15) * boost * 100);
      const dl = domainLogic(S, m, side, pc, minsLeft, now);
      const reqE = Math.max(1.5, Math.round((L.reqEdge(m.c, pc) + (dl.extra || 0)) * 10) / 10);
      const etH = (new Date(now).getUTCHours() + 20) % 24;
      const volReq = etH >= 2 && etH < 7 ? 500 : 100;
      const dupe = openBets.some(b => b.title === m.t);
      const horizonM = m.c === "SPORTS" ? 360 : horizonMins(S);
      const minEntryM = m.c === "SPORTS" ? 45 : 5;
      const volReqEff = Math.max(volReq, (dl.volMin || 0));
      const vol = m.vol || 0;
      const volLabel = vol >= 1000000 ? (vol / 1000000).toFixed(1) + "M" : vol >= 1000 ? Math.round(vol / 1000) + "k" : String(vol);
      const gates = [
        { k: "T-MINUS", pass: minsLeft >= minEntryM && minsLeft <= horizonM, val: (minsLeft >= 60 ? (minsLeft / 60).toFixed(1) + "h" : Math.max(0, Math.round(minsLeft)) + "m") + (m.c === "SPORTS" && minsLeft > 360 ? " watchlist" : "") },
        { k: "WIN ODDS", pass: (pc >= (dl.bandMin || 70) && pc <= (dl.bandMax || 92)) || (m.c !== "SPORTS" && pc >= 93 && pc <= 98 && minsLeft <= 10), val: pc + "c@" + Math.max(0, Math.round(minsLeft)) + "m" },
        { k: "LIQUIDITY", pass: vol >= volReqEff, val: "$" + volLabel },
        { k: "NET EDGE", pass: netEdge >= reqE, val: (netEdge >= 0 ? "+" : "") + netEdge + "c req+" + reqE + "c" },
        { k: "SCORE", pass: score >= 60, val: String(score) },
        { k: "DUPLICATE", pass: !dupe, val: dupe ? "held" : "clear" },
        { k: "DOMAIN", pass: dl.ok, val: dl.val },
        { k: "LEARNING", pass: !L.blocked[m.c] && !L.haltUntil, val: L.haltUntil ? "halted" : (L.blocked[m.c] ? "cooldown" : "clear") }
      ];
      cands.push({ m, idx, side, pc, contracts, winProb, edge, netEdge, fee, score, closeTs, minsLeft, gates, dl, be: Math.round(pc + feeC), pass: gates.every(g => g.pass), held: dupe });
    });
  });
  cands.sort((a, b) => (b.held ? 1 : 0) - (a.held ? 1 : 0) || b.score - a.score);
  return cands;
}

// ---------- live account sync (armed only) ----------
async function syncLive(S, now) {
  if (!liveKeysOk()) return { ok: false, why: "no api keys" };
  try {
    const bal = await kalshiAuth("GET", "/trade-api/v2/portfolio/balance");
    if (bal.status >= 200 && bal.status < 300) {
      const bj = bal.json || {};
      const cents = (v, d) => v != null ? Math.round(parseFloat(v)) : (d != null ? Math.round(parseFloat(d) * 100) : null);
      S.liveStatus = { balance: cents(bj.balance, bj.balance_dollars), ts: now };
    }
    const page = async (path, key) => {
      const r = await kalshiAuth("GET", path);
      return (r.status >= 200 && r.status < 300 && r.json && r.json[key]) || [];
    };
    const [fills, setts, poss] = await Promise.all([
      page("/trade-api/v2/portfolio/fills?limit=100", "fills"),
      page("/trade-api/v2/portfolio/settlements?limit=100", "settlements"),
      page("/trade-api/v2/portfolio/positions?limit=100&count_filter=position", "market_positions")
    ]);
    const fpNum = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
    const fpCount = (o, a, b) => { const x = fpNum(o[a]); if (x != null) return x; const y = b ? fpNum(o[b]) : null; return y != null ? y : 0; };
    const fpCents = (o, a, b) => { const x = fpNum(o[a]); if (x != null) return x * 100; const y = b ? fpNum(o[b]) : null; return y != null ? y : null; };
    const posSet = {};
    poss.forEach(p => { if (Math.abs(fpCount(p, "position_fp", "position")) >= 1) posSet[p.ticker] = true; });
    S.posSet = posSet; S.posSetTs = now; S.pfOkTs = now;
    // settlements -> real results
    setts.forEach(s => {
      const res = String(s.market_result || s.result || "").toLowerCase();
      if (res !== "yes" && res !== "no") return;
      S.bets.forEach(b => {
        if (b.ticker !== s.ticker || b.result) return;
        b.result = (b.side.toLowerCase() === res) ? "won" : "lost";
        b.settledBy = "real";
        const revC = fpCents(s, "revenue_dollars", "revenue");
        if (b.live && revC != null) b.realPnl = revC / 100 - (b.contracts * b.pc / 100);
        pushEvent(S, b.result === "won" ? "\u2713" : "\u2717", b.result === "won" ? "#4fce7f" : "#e5636a", "KALSHI SETTLED " + (b.result === "won" ? "WON " : "LOST ") + fmt$(pnlOf(b)) + " \u00b7 " + b.title);
      });
    });
    // fills -> fill state
    const groups = {};
    fills.forEach(f => {
      const side = String(f.side || "").toUpperCase();
      const g = groups[f.ticker + "|" + side] = groups[f.ticker + "|" + side] || { count: 0 };
      g.count += fpCount(f, "count_fp", "count");
    });
    S.bets.forEach(b => {
      if (!b.live || b.result) return;
      const g = groups[b.ticker + "|" + b.side];
      if (g && g.count >= (b.ordered || b.contracts)) b.fillState = "filled";
      else if (g && g.count > 0) b.fillState = "partial";
    });
    // audits: void what never became real
    S.bets.forEach(b => {
      if (b.result || !b.ticker || b.imported) return;
      const graceMs = isWeatherBet(b.ticker) ? 20 * 3600000 : 30 * 60000;
      const g = groups[b.ticker + "|" + b.side];
      if (S.cfg.armed && !b.live && now > (b.placedTs || 0) + 3 * 60000) {
        b.result = "void"; b.settledBy = "real"; b.realPnl = 0;
        pushEvent(S, "\u25cb", "#7d8697", "VOIDED (never placed on Kalshi) \u00b7 " + b.title);
      } else if (b.live && !posSet[b.ticker] && (!g || !g.count) && now > b.closeTs + graceMs) {
        b.result = "void"; b.settledBy = "real"; b.realPnl = 0;
        pushEvent(S, "\u25cb", "#7d8697", "VOIDED (order never filled, $0) \u00b7 " + b.title);
      }
    });
    return { ok: true };
  } catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
}

async function settleDue(S, now) {
  const pendingReal = [];
  S.bets.forEach(b => {
    if (b.result || now < b.closeTs) return;
    if (b.ticker) { pendingReal.push(b); return; }
    // paper market with no real ticker: simulated settle
    const roll = rng((b.id || "x").split("").reduce((s, ch) => s + ch.charCodeAt(0), 0) ^ Math.floor(b.closeTs / 1000))();
    const winProb = Math.min(0.95, Math.max(0.05, b.pc / 100 + 0.03));
    b.result = roll < winProb ? "won" : "lost";
    b.settledBy = "sim";
    pushEvent(S, b.result === "won" ? "\u2713" : "\u2717", b.result === "won" ? "#4fce7f" : "#e5636a", "SETTLED " + (b.result === "won" ? "WON " : "LOST ") + fmt$(pnlOf(b)) + " \u00b7 " + b.title);
  });
  if (!pendingReal.length) return;
  try {
    const tickers = Array.from(new Set(pendingReal.map(b => b.ticker))).slice(0, 20).join(",");
    const j = await fetchJson(KBASE + "/markets?tickers=" + encodeURIComponent(tickers), 9000);
    const byT = {};
    (j.markets || []).forEach(m => { byT[m.ticker] = m; });
    S.bets.forEach(b => {
      if (b.result || !b.ticker) return;
      const m = byT[b.ticker];
      if (m && !(m.result === "yes" || m.result === "no")) {
        const st = String(m.status || "").toLowerCase();
        b.review = !!st && st !== "active" && st !== "open";
      }
      if (m && (m.result === "yes" || m.result === "no")) {
        b.result = (m.result.toUpperCase() === b.side) ? "won" : "lost";
        b.settledBy = "real"; b.review = false;
        pushEvent(S, b.result === "won" ? "\u2713" : "\u2717", b.result === "won" ? "#4fce7f" : "#e5636a", "SETTLED (real result) " + (b.result === "won" ? "WON " : "LOST ") + fmt$(pnlOf(b)) + " \u00b7 " + b.title);
      }
      // grace expiry for paper bets on real tickers that never resolve
      if (!b.result && !b.live && now > b.closeTs + (isWeatherBet(b.ticker) ? 20 * 3600000 : 6 * 3600000)) {
        b.result = "void"; b.settledBy = "real"; b.realPnl = 0;
        pushEvent(S, "\u25cb", "#7d8697", "VOIDED (no settlement published) \u00b7 " + b.title);
      }
    });
  } catch (e) {}
}

async function placeLiveOrder(S, c, betId, now) {
  if (!liveKeysOk()) return;
  if (process.env.TRADING_HALTED === "true") { pushEvent(S, "\u25cb", "#e5636a", "TRADING_HALTED env var set \u2014 order suppressed", { kind: "halt", coalesce: true }); return; }
  if (!S.liveStatus || S.liveStatus.balance == null || now - (S.liveStatus.ts || 0) > 120000) { pushEvent(S, "\u25cb", "#eab54e", "order blocked \u2014 balance not verified this sweep", { kind: "hold", coalesce: true }); return; }
  if (S.liveStatus.balance < 2600) { pushEvent(S, "\u25cb", "#eab54e", "balance under $26 \u2014 order skipped", { kind: "lowbal", coalesce: true }); return; }
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const dayPnl = S.bets.filter(b => b.live && b.result && b.closeTs >= d0.getTime()).reduce((s, b) => s + pnlOf(b), 0);
  if (dayPnl <= -500) { S.cfg.armed = false; pushEvent(S, "\u25a0", "#e5636a", "AUTO-HALT: \u2212$500 day loss reached \u2014 disarmed"); return; }
  if (S.posSet && S.posSet[c.m.ticker]) {
    const held = S.bets.find(x => x.id === betId);
    if (held && !held.result) held.live = true;
    pushEvent(S, "\u25cb", "#5aa7e8", "AUDIT: position already on Kalshi \u2014 adopted, no re-buy \u00b7 " + c.m.t);
    return;
  }
  const slow = (c.closeTs - now) > 45 * 60000;
  const ask = c.side === "YES" ? (c.m._ask || c.pc) : (100 - (c.m._bid || (100 - c.pc)));
  const sideBid = c.side === "YES" ? (c.m._bid || (c.pc - 2)) : (100 - (c.m._ask || (100 - c.pc + 2)));
  const price = Math.max(1, Math.min(99, Math.round(slow ? sideBid + 1 : ask)));
  const liveCount = Math.max(1, Math.floor(2500 / price));
  if (liveCount * price > 3000) { pushEvent(S, "\u25cb", "#e5636a", "order exceeds $30 cap \u2014 skipped \u00b7 " + c.m.t); return; }
  const yesPrice = c.side === "YES" ? price : (100 - price);
  const order = {
    ticker: c.m.ticker,
    client_order_id: crypto.randomUUID(),
    side: c.side === "YES" ? "bid" : "ask",
    count: liveCount.toFixed(2),
    price: (yesPrice / 100).toFixed(4),
    time_in_force: "good_till_canceled",
    self_trade_prevention_type: "taker_at_cross",
    post_only: slow,
    cancel_order_on_pause: false,
    reduce_only: false
  };
  let r = await kalshiAuth("POST", "/trade-api/v2/portfolio/events/orders", order);
  if (r.status === 404) {
    const legacy = { ticker: c.m.ticker, client_order_id: crypto.randomUUID(), action: "buy", side: c.side.toLowerCase(), count: liveCount, type: "limit" };
    legacy[c.side.toLowerCase() + "_price"] = price;
    r = await kalshiAuth("POST", "/trade-api/v2/portfolio/orders", legacy);
  }
  const b = S.bets.find(x => x.id === betId);
  if (r.status >= 200 && r.status < 300) {
    const j = r.json || {};
    const o = j.order || j;
    pushEvent(S, "\u25c9", "#4fce7f", "LIVE ORDER placed \u00b7 " + c.side + " " + liveCount + "x @ " + price + "c \u00b7 " + c.m.t);
    if (b) {
      b.live = true; b.orderId = (o && o.order_id) || "";
      const fc = parseFloat((o && (o.fill_count != null ? o.fill_count : o.taker_fill_count)) || 0);
      b.fillState = fc >= liveCount ? "filled" : fc > 0 ? "partial" : "resting";
      b.pc = price; b.contracts = liveCount; b.ordered = liveCount;
      b.fee = Math.ceil(liveCount * (Math.round(7 * (price / 100) * (1 - price / 100) * 10) / 10)) / 100;
    }
  } else {
    const msg = (r.json && ((r.json.error && r.json.error.message) || r.json.message)) || ("kalshi " + r.status);
    pushEvent(S, "\u25c9", "#e5636a", "LIVE ORDER rejected (" + String(msg).slice(0, 80) + ") \u00b7 " + c.m.t);
    if (b && !b.result) { b.result = "void"; b.settledBy = "real"; b.realPnl = 0; }
  }
}

async function manageOrders(S, now, cands) {
  if (!S.cfg.armed || !liveKeysOk()) return;
  for (const b of S.bets) {
    if (!b.live || b.result || !b.orderId) continue;
    if (b.fillState !== "resting" && b.fillState !== "partial") continue;
    if (b.fillState === "resting" && S.posSet && S.posSet[b.ticker]) continue;
    const age = now - (b.placedTs || 0);
    if (age < 45000) continue;
    const c = cands.find(x => x.m.ticker === b.ticker && x.side === b.side);
    let why = null;
    if (age > 10 * 60000) why = "unfilled 10min+ \u2014 stale limit";
    else if (c) {
      const broken = c.gates.filter(g => !g.pass && g.k !== "DUPLICATE" && g.k !== "LEARNING");
      if (broken.length) why = "thesis broke (" + broken[0].k + ")";
    } else if (age > 5 * 60000) why = "market left the scan pool";
    if (!why) continue;
    let r = await kalshiAuth("DELETE", "/trade-api/v2/portfolio/events/orders/" + encodeURIComponent(b.orderId));
    if (r.status === 404 || r.status === 405 || r.status === 410) r = await kalshiAuth("DELETE", "/trade-api/v2/portfolio/orders/" + encodeURIComponent(b.orderId));
    if (r.status >= 200 && r.status < 300) {
      if (b.fillState === "partial") {
        b.fillState = "filled";
        pushEvent(S, "\u2716", "#eab54e", "REMAINDER CANCELED (" + why + ") \u2014 filled portion kept \u00b7 " + b.title);
      } else {
        b.result = "void"; b.settledBy = "real"; b.realPnl = 0;
        pushEvent(S, "\u2716", "#eab54e", "ORDER CANCELED (" + why + "), voided \u00b7 " + b.title);
      }
    }
  }
}

async function tick(S) {
  const now = Date.now();
  await refreshPool(S, now);
  if (S.cfg.armed) await syncLive(S, now);
  await settleDue(S, now);
  const cands = evaluate(S, now);
  S.sweepN = (S.sweepN || 0) + 1;
  const nQual = cands.filter(c => c.pass).length;
  pushEvent(S, "\u00b7", "#5c6474", "server sweep #" + S.sweepN + " \u2014 " + cands.length + " positions scored, " + nQual + " qualify", { kind: "sweep", coalesce: true });
  let placedLive = false;
  for (const c of cands) {
    if (!c.pass) continue;
    if (S.bets.some(b => !b.result && b.title === c.m.t)) continue;
    if (S.bets.filter(b => !b.result).length >= 4) { pushEvent(S, "\u25cb", "#eab54e", "max 4 concurrent open bets \u2014 holding", { kind: "maxopen", coalesce: true }); break; }
    if (c.m.c === "SPORTS" && S.bets.filter(b => !b.result && b.cat === "SPORTS").length >= 2) { pushEvent(S, "\u25cb", "#eab54e", "max 2 concurrent sports positions \u2014 skipping " + c.m.t, { kind: "maxsports", coalesce: true }); continue; }
    if (S.cfg.armed && (!S.pfOkTs || now - S.pfOkTs > 120000)) { pushEvent(S, "\u25cb", "#eab54e", "entries held \u2014 account state not verified this sweep", { kind: "hold", coalesce: true }); break; }
    const idBase = c.m.t + "@" + c.closeTs + "-" + c.side;
    const prior = S.bets.filter(b => b.id === idBase || (b.id && b.id.indexOf(idBase + "-r") === 0));
    if (prior.some(b => b.result !== "void")) continue;
    if (prior.length >= 3) continue;
    const id = prior.length ? idBase + "-r" + prior.length : idBase;
    pushEvent(S, "\u271a", "#4fce7f", "ENTERED " + c.side + " @ " + c.pc + "c \u00b7 " + c.m.t + " \u00b7 $25 to win $" + (c.contracts * (100 - c.pc) / 100 - c.fee).toFixed(2) + " net of fees");
    S.bets.push({
      id, placedTs: now,
      title: c.m.t, ticker: c.m.ticker || "", cat: c.m.c, side: c.side, pc: c.pc,
      contracts: c.contracts, score: c.score, edge: c.netEdge, fee: c.fee, winProb: Math.round(c.winProb * 100),
      strat: c.winProb >= 0.8 ? "HIGH-PROB" : "KELLY-EDGE",
      snap: c.gates.map(g => g.k + "=" + g.val).join(" \u00b7 ") + " \u00b7 BREAKEVEN=" + c.be + "c \u00b7 srv",
      closeTs: c.closeTs, result: null, settledBy: null
    });
    if (S.cfg.armed && !placedLive) { await placeLiveOrder(S, c, id, now); placedLive = true; }
  }
  await manageOrders(S, now, cands);
  S.lastTickTs = now;
  return { sweep: S.sweepN, scored: cands.length, qualified: nQual, open: S.bets.filter(b => !b.result).length, armed: !!S.cfg.armed };
}

// ---------- HTTP handler ----------
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const secret = process.env.TRADE_SECRET;
  const url = new URL(req.url, "http://x");
  const given = req.headers["x-trade-secret"] || url.searchParams.get("secret");
  const cronOk = !!(process.env.CRON_SECRET && (req.headers["authorization"] || "") === "Bearer " + process.env.CRON_SECRET);
  if (!cronOk && (!secret || given !== secret)) return res.status(401).json({ error: "unauthorized" });
  const action = url.searchParams.get("action") || (req.method === "POST" ? "" : "state");
  try {
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const S = await loadState();
      if (b.action === "arm") {
        S.cfg.armed = !!b.armed;
        pushEvent(S, b.armed ? "\u25c9" : "\u25a0", b.armed ? "#e5636a" : "#7d8697", b.armed ? "LIVE TRADING ARMED (server engine) \u2014 $25 limit orders \u00b7 halt at \u2212$500/day" : "LIVE TRADING DISARMED (server engine)");
        await saveState(S);
        return res.status(200).json({ armed: S.cfg.armed });
      }
      if (b.action === "reset") {
        S.bets = []; S.startTs = Date.now(); S.phist = {}; S.sweepN = 0;
        pushEvent(S, "\u25cb", "#7d8697", "bet log reset (server engine)");
        await saveState(S);
        return res.status(200).json({ reset: true });
      }
      return res.status(400).json({ error: "unknown action" });
    }
    if (action === "tick") {
      const S = await loadState();
      const out = await tick(S);
      await saveState(S);
      return res.status(200).json({ ok: true, ...out, srv: 49 });
    }
    if (action === "state") {
      const S = await loadState();
      return res.status(200).json({
        srv: 49,
        lastTickTs: S.lastTickTs || 0,
        sweepN: S.sweepN || 0,
        startTs: S.startTs,
        armed: !!S.cfg.armed,
        balance: S.liveStatus ? S.liveStatus.balance : null,
        bets: S.bets || [],
        events: S.events || [],
        effHorizon: S.effHorizon || 60,
        poolSize: (S.pool || []).length,
        feedDiag: S.feedDiag || []
      });
    }
    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
