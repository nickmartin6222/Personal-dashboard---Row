// ============================================================
// GET /api/stock-price?symbols=VOO,IVV.AX,AAPL
// Proxies to Finnhub's /quote endpoint so the API key never reaches
// the browser. Returns current price + 24h change per symbol:
//   { "VOO": { price, change, changePercent, prevClose, ts }, ... }
// A symbol Finnhub can't price (bad ticker, plan doesn't cover that
// exchange, rate limited) comes back as { error: "..." } for just
// that symbol — the rest of the batch still resolves.
//
// Requires a FINNHUB_API_KEY environment variable in Vercel
// (Project Settings -> Environment Variables). Free-tier Finnhub
// covers US-listed tickers well; non-US exchanges (e.g. ASX .AX
// tickers) may be delayed or unavailable depending on plan.
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.FINNHUB_API_KEY;
  if (!key) return res.status(500).json({ error: 'FINNHUB_API_KEY not set on the server' });

  const raw = (req.query && req.query.symbols) || '';
  const symbols = String(raw)
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 25); // keep a batch sane
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required, comma-separated' });

  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      const r = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + key);
      if (!r.ok) { out[sym] = { error: 'finnhub http ' + r.status }; return; }
      const d = await r.json();
      // Finnhub returns all-zero fields for a symbol it can't find/price.
      if (d && (d.c || d.pc)) {
        out[sym] = {
          price: d.c,
          change: d.d,
          changePercent: d.dp,
          prevClose: d.pc,
          ts: d.t ? d.t * 1000 : Date.now()
        };
      } else {
        out[sym] = { error: 'no data for this symbol on your Finnhub plan' };
      }
    } catch (e) {
      out[sym] = { error: 'fetch failed: ' + (e && e.message ? e.message : String(e)) };
    }
  }));

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
