// Kalshi live-trading proxy — Vercel serverless function.
// Env vars: KALSHI_ACCESS_KEY (key ID), KALSHI_PRIVATE_KEY (PEM or base64 PEM),
// TRADE_SECRET (dashboard passphrase). Optional: TRADING_HALTED=true kill switch.
const crypto = require("crypto");

// Kalshi has moved trading endpoints between hosts over time; we probe in order
// and lock onto whichever accepts the request.
const BASES = [
  "https://api.elections.kalshi.com",
  "https://external-api.kalshi.com",
  "https://api.kalshi.com",
  "https://trading-api.kalshi.com"
];
let goodBase = null; // cached per warm lambda

function getPem() {
  let k = process.env.KALSHI_PRIVATE_KEY || "";
  if (k && !k.includes("BEGIN")) {
    try { k = Buffer.from(k, "base64").toString("utf8"); } catch (e) {}
  }
  return k;
}

function sign(method, path) {
  const ts = Date.now().toString();
  const msg = ts + method + path;
  const sig = crypto.sign("sha256", Buffer.from(msg), {
    key: getPem(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }).toString("base64");
  return { ts, sig };
}

async function kalshiAt(base, method, path, body) {
  const { ts, sig } = sign(method, path.split("?")[0]);
  const r = await fetch(base + path, {
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
  return { status: r.status, json: j, base };
}

function endpointLevelError(r) {
  const msg = JSON.stringify(r.json || {});
  return r.status === 0 || r.status === 404 || r.status === 410 ||
    /switch to the V2|V2 endpoints|endpoint.*deprecated|not found/i.test(msg);
}

async function kalshi(method, path, body) {
  const bases = goodBase ? [goodBase].concat(BASES.filter(b => b !== goodBase)) : BASES;
  let last = null;
  for (const base of bases) {
    let r;
    try { r = await kalshiAt(base, method, path, body); }
    catch (e) { r = { status: 0, json: { error: String((e && e.message) || e) }, base }; }
    if (r.status >= 200 && r.status < 300) { goodBase = base; return r; }
    last = r;
    // auth/param errors are the same everywhere — don't retry those on other hosts
    if (!endpointLevelError(r)) return r;
  }
  return last;
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const secret = process.env.TRADE_SECRET;
  if (!secret || req.headers["x-trade-secret"] !== secret) {
    return res.status(401).json({ error: "unauthorized — set TRADE_SECRET env var and enter it when arming" });
  }
  if (process.env.TRADING_HALTED === "true") {
    return res.status(423).json({ error: "halted by TRADING_HALTED env var" });
  }
  if (!process.env.KALSHI_ACCESS_KEY || !getPem()) {
    return res.status(500).json({ error: "missing KALSHI_ACCESS_KEY / KALSHI_PRIVATE_KEY env vars" });
  }

  try {
    if (req.method === "GET" && req.url && req.url.includes("action=diag")) {
      const pem = getPem();
      const out = {
        keyIdLen: (process.env.KALSHI_ACCESS_KEY || "").length,
        pemLooksValid: pem.includes("BEGIN") && pem.includes("END"),
        hosts: {}
      };
      for (const base of BASES) {
        try {
          const r = await kalshiAt(base, "GET", "/trade-api/v2/portfolio/balance");
          out.hosts[base] = { status: r.status, body: JSON.stringify(r.json).slice(0, 200) };
        } catch (e) { out.hosts[base] = { status: 0, body: String((e && e.message) || e) }; }
      }
      return res.status(200).json(out);
    }
    if (req.method === "GET" && req.url && req.url.includes("action=testorder")) {
      const probe = {
        ticker: "KXFAKEDIAG-00JAN01-T1",
        client_order_id: crypto.randomUUID(),
        side: "bid", count: "1.00", price: "0.0100",
        time_in_force: "good_till_canceled",
        self_trade_prevention_type: "taker_at_cross",
        post_only: false, cancel_order_on_pause: false, reduce_only: false
      };
      const out = {};
      for (const base of BASES) {
        try {
          const r = await kalshiAt(base, "POST", "/trade-api/v2/portfolio/events/orders", probe);
          out[base] = { status: r.status, body: JSON.stringify(r.json).slice(0, 300) };
        } catch (e) { out[base] = { status: 0, body: String((e && e.message) || e) }; }
      }
      return res.status(200).json(out);
    }
    if (req.method === "GET" && req.url && req.url.includes("action=portfolio")) {
      const [f, s, p] = await Promise.all([
        kalshi("GET", "/trade-api/v2/portfolio/fills?limit=100"),
        kalshi("GET", "/trade-api/v2/portfolio/settlements?limit=100"),
        kalshi("GET", "/trade-api/v2/portfolio/positions?limit=200&count_filter=position&settlement_status=unsettled")
      ]);
      return res.status(200).json({
        fills: (f.json && f.json.fills) || [],
        settlements: (s.json && s.json.settlements) || [],
        positions: (p.json && (p.json.market_positions || p.json.positions)) || [],
        errors: [["fills", f], ["settlements", s], ["positions", p]].filter(x => x[1].status >= 300).map(x => x[0] + ":" + x[1].status)
      });
    }
    if (req.method === "GET") {
      const bal = await kalshi("GET", "/trade-api/v2/portfolio/balance");
      if (bal.status >= 200 && bal.status < 300) {
        return res.status(200).json({ balance: bal.json && bal.json.balance, via: bal.base, srv: 36 });
      }
      const msg = (bal.json && ((bal.json.error && bal.json.error.message) || bal.json.message || bal.json.error)) || ("kalshi " + bal.status);
      return res.status(502).json({ error: String(msg), via: bal.base });
    }
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      if (b.action === "cancel") {
        if (!b.order_id) return res.status(400).json({ error: "missing order_id" });
        let r = await kalshi("DELETE", "/trade-api/v2/portfolio/events/orders/" + encodeURIComponent(b.order_id));
        if (r.status === 404 || r.status === 405 || r.status === 410) {
          r = await kalshi("DELETE", "/trade-api/v2/portfolio/orders/" + encodeURIComponent(b.order_id));
        }
        if (r.status >= 200 && r.status < 300) return res.status(200).json({ canceled: true, via: r.base });
        const cmsg = (r.json && ((r.json.error && r.json.error.message) || r.json.message)) || ("kalshi " + r.status);
        return res.status(502).json({ error: String(cmsg), via: r.base });
      }
      const ticker = b.ticker, side = b.side, count = Math.floor(b.count), price = Math.round(b.price);
      if (!ticker || (side !== "yes" && side !== "no") || !(count >= 1) || !(price >= 1 && price <= 99)) {
        return res.status(400).json({ error: "bad order params" });
      }
      if (count * price > 3000) {
        return res.status(400).json({ error: "order exceeds $30 cost cap" });
      }
      // Kalshi V2 order shape (May 2026): single-book YES-side quoting, fixed-point dollars.
      // buy YES = bid at yes price; buy NO = ask (sell YES) at 1 - no price.
      const yesPrice = side === "yes" ? price : (100 - price);
      const order = {
        ticker,
        client_order_id: crypto.randomUUID(),
        side: side === "yes" ? "bid" : "ask",
        count: count.toFixed(2),
        price: (yesPrice / 100).toFixed(4),
        time_in_force: "good_till_canceled",
        self_trade_prevention_type: "taker_at_cross",
        post_only: false,
        cancel_order_on_pause: false,
        reduce_only: false
      };
      let r = await kalshi("POST", "/trade-api/v2/portfolio/events/orders", order);
      // last-resort fallback to the legacy endpoint (e.g. demo envs)
      if (r.status === 404) {
        const legacy = { ticker, client_order_id: crypto.randomUUID(), action: "buy", side, count, type: "limit" };
        legacy[side + "_price"] = price;
        r = await kalshi("POST", "/trade-api/v2/portfolio/orders", legacy);
      }
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).json({ order: (r.json && (r.json.order || r.json)), via: r.base });
      }
      const msg = (r.json && ((r.json.error && r.json.error.message) || r.json.message)) || JSON.stringify(r.json || {}).slice(0, 200) || ("kalshi " + r.status);
      return res.status(r.status >= 400 && r.status < 500 && r.status !== 404 && r.status !== 410 ? r.status : 502).json({ error: String(msg), via: r.base });
    }
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
