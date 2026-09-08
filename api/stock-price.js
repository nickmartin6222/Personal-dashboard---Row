// ============================================================
// GET /api/stock-price?symbols=IVV.AX,VDHG.AX,AAPL
// Proxies to EODHD's real-time quote endpoint so the API key never
// reaches the browser. Returns current price + change per symbol:
//   { "IVV.AX": { price, change, changePercent, ts }, ... }
// A symbol EODHD can't price comes back as { error: "..." } for
// just that symbol — the rest of the batch still resolves.
//
// Requires an EODHD_API_TOKEN environment variable in Vercel
// (Project Settings -> Environment Variables). Free EODHD tier is
// only 20 API calls/day total, and EODHD counts one call PER
// SYMBOL even when batched into a single HTTP request — so keep
// refreshes infrequent (the finance page throttles to a few times
// a day, not every few minutes).
//
// Ticker suffixes: this app stores ASX tickers as "X.AX" (the
// Finnhub/Yahoo convention). EODHD instead uses "X.AU" for the
// Australian exchange, so that translation happens here — you can
// keep entering tickers as "IVV.AX" on the Finance page either way.
// This ".AX" -> ".AU" mapping is a best-effort guess confirmed by
// testing, not from official EODHD documentation, so if it's wrong
// on your account, IVV.AX etc will come back with an error and this
// needs adjusting.
// ============================================================
function toEodhdSymbol(sym) {
  if (/\.AX$/i.test(sym)) return sym.slice(0, -3) + '.AU';
  return sym;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.EODHD_API_TOKEN;
  if (!key) return res.status(500).json({ error: 'EODHD_API_TOKEN not set on the server' });

  const raw = (req.query && req.query.symbols) || '';
  const symbols = String(raw)
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 15); // stay well inside the 20/day free-tier budget
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required, comma-separated' });

  const out = {};
  // Map EODHD's returned symbol -> the symbol the caller actually asked
  // for, so a translated ".AU" comes back keyed as the original ".AX".
  const lookup = {};
  symbols.forEach(s => { lookup[toEodhdSymbol(s)] = s; });

  const eodSymbols = symbols.map(toEodhdSymbol);
  const primary = eodSymbols[0];
  const rest = eodSymbols.slice(1);
  const url = 'https://eodhd.com/api/real-time/' + encodeURIComponent(primary) +
    (rest.length ? '?s=' + rest.map(encodeURIComponent).join(',') : '?') +
    (rest.length ? '&' : '') + 'api_token=' + key + '&fmt=json';

  try {
    const r = await fetch(url);
    if (!r.ok) {
      symbols.forEach(s => { out[s] = { error: 'eodhd http ' + r.status }; });
    } else {
      const data = await r.json();
      const rows = Array.isArray(data) ? data : [data];
      rows.forEach(row => {
        if (!row || !row.code) return;
        const orig = lookup[row.code.toUpperCase()];
        if (!orig) return;
        if (row.close == null || row.code === 'NA') {
          out[orig] = { error: 'no data for this symbol on EODHD' };
        } else {
          out[orig] = {
            price: row.close,
            change: row.change,
            changePercent: row.change_p,
            ts: row.timestamp ? row.timestamp * 1000 : Date.now()
          };
        }
      });
      // Anything requested but missing from the response = not found.
      symbols.forEach(s => { if (!out[s]) out[s] = { error: 'no data returned for this symbol' }; });
    }
  } catch (e) {
    symbols.forEach(s => { out[s] = { error: 'fetch failed: ' + (e && e.message ? e.message : String(e)) }; });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
}
