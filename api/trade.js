// Kalshi live-trading proxy — Vercel serverless function.
// Env vars: KALSHI_ACCESS_KEY (key ID), KALSHI_PRIVATE_KEY (PEM or base64 PEM),
// TRADE_SECRET (dashboard passphrase). Optional: TRADING_HALTED=true kill switch.
const crypto = require("crypto");

// Kalshi has moved trading endpoints between hosts over time; we probe in order
// and lock onto whichever accepts the request.
const BASES = [
  "https://api.elections.kalshi.com",
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
    if (req.method === "GET") {
      const bal = await kalshi("GET", "/trade-api/v2/portfolio/balance");
      if (bal.status >= 200 && bal.status < 300) {
        return res.status(200).json({ balance: bal.json && bal.json.balance, via: bal.base });
      }
      const msg = (bal.json && ((bal.json.error && bal.json.error.message) || bal.json.message || bal.json.error)) || ("kalshi " + bal.status);
      return res.status(502).json({ error: String(msg), via: bal.base });
    }
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const ticker = b.ticker, side = b.side, count = Math.floor(b.count), price = Math.round(b.price);
      if (!ticker || (side !== "yes" && side !== "no") || !(count >= 1) || !(price >= 1 && price <= 99)) {
        return res.status(400).json({ error: "bad order params" });
      }
      if (count * price > 3000) {
        return res.status(400).json({ error: "order exceeds $30 cost cap" });
      }
      const order = {
        ticker,
        client_order_id: crypto.randomUUID(),
        action: "buy",
        side,
        count,
        type: "limit"
      };
      order[side + "_price"] = price;
      const r = await kalshi("POST", "/trade-api/v2/portfolio/orders", order);
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).json({ order: (r.json && r.json.order) || r.json, via: r.base });
      }
      const msg = (r.json && ((r.json.error && r.json.error.message) || r.json.message || r.json.error)) || ("kalshi " + r.status);
      return res.status(r.status >= 400 && r.status < 500 && r.status !== 404 ? r.status : 502).json({ error: String(msg), via: r.base });
    }
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
