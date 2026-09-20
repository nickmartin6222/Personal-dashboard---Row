// ============================================================
// POST /api/pearler-import
// Receives a webhook from a Google Apps Script watching your Gmail for
// Pearler order-confirmation emails ("Your automatic investment in
// NDQ is complete" / "Your Micro investment is complete" — both say
// "$X of NAME" in the body). Adds that purchase into the SAME
// Supabase app_state row (key "finance-nw") the Finance page itself
// syncs, so it shows up on the dashboard with no manual entry.
//
// Body: { name: "NDQ", amountAUD: 241.67 }
//   name       — whatever's in "$X of NAME" (or the ticker from the
//                subject line for the "automatic investment" emails).
//                A short ALL-CAPS token (2-5 letters, no spaces) is
//                treated as a real ASX ticker; anything else (e.g.
//                "All In One") is tracked as a plain dollar amount
//                with no live price (Pearler's own diversified
//                products aren't a line-item on the exchange).
//   amountAUD  — the dollar figure from the email, in AUD.
//
// Ticker path: looks up the live price via this project's own
// /api/stock-price (EODHD, same one the Finance page uses), converts
// the AUD amount to units at that price, and ADDS those units to the
// existing holding (creating one if this is the first buy). If the
// price lookup fails for any reason, the dollar amount is added to
// the holding's `amount` instead — the app's own refreshStockPrices()
// will convert that into units next time it runs successfully, same
// as the manual "type a value, no units yet" bootstrap flow.
//
// Non-ticker path: adds straight into nw:other as a plain running
// dollar total, using fx:rates already cached from Supabase to
// convert AUD -> CHF (this app's internal storage currency) — same
// "frozen rate" treatment every non-ticker holding gets.
//
// Auth: requires an x-api-key header matching PEARLER_IMPORT_SECRET
// (a Vercel env var) — set the same value in the Apps Script.
// ============================================================

function isLikelyTicker(name) {
  return /^[A-Z]{2,5}$/.test(name);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secret = process.env.PEARLER_IMPORT_SECRET;
  if (!secret) return res.status(500).json({ error: 'PEARLER_IMPORT_SECRET not set on the server' });
  if (req.headers['x-api-key'] !== secret) return res.status(401).json({ error: 'unauthorized' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not set on the server' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'invalid JSON body' }); }
  }
  const name = body && String(body.name || '').trim();
  const amountAUD = Number(body && body.amountAUD);
  if (!name || !(amountAUD > 0)) {
    return res.status(400).json({ error: 'expected { name, amountAUD } with amountAUD > 0' });
  }

  const restHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  try {
    const getUrl = SUPABASE_URL + '/rest/v1/app_state?key=eq.finance-nw&select=data';
    const getResp = await fetch(getUrl, { headers: restHeaders });
    const rows = await getResp.json().catch(() => []);
    const state = (Array.isArray(rows) && rows[0] && rows[0].data) || {};

    // fx:rates is CHF-per-1-unit-of-currency (same shape the Finance
    // page itself caches) — fall back to a rough AUD/CHF guess if it's
    // never been synced yet so this can't divide by zero.
    const fxRates = state['fx:rates'] || { CHF: 1, AUD: 1.8 };
    const audPerChf = Number(fxRates.AUD) > 0 ? Number(fxRates.AUD) : 1.8;
    const amountCHF = amountAUD / audPerChf;
    const today = new Date().toISOString().slice(0, 10);

    let result;
    if (isLikelyTicker(name)) {
      const ticker = name.toUpperCase() + '.AX';
      const stocks = state['nw:stocks'] || [];
      let holding = stocks.find(it => it.ticker === ticker);

      const proto = req.headers['x-forwarded-proto'] || 'https';
      let price = null;
      try {
        const priceResp = await fetch(proto + '://' + req.headers.host + '/api/stock-price?symbols=' + encodeURIComponent(ticker));
        const quotes = await priceResp.json().catch(() => ({}));
        const q = quotes[ticker];
        if (q && q.price > 0) price = q.price; // EODHD prices ASX tickers in AUD
      } catch (e) {}

      if (price) {
        const priceCHF = price / audPerChf;
        const deltaUnits = amountCHF / priceCHF;
        if (holding) {
          holding.units = (Number(holding.units) || 0) + deltaUnits;
        } else {
          holding = { name: name.toUpperCase(), ticker, units: deltaUnits, amount: 0, dateAdded: today };
          stocks.push(holding);
        }
        result = { path: 'ticker-priced', ticker, deltaUnits };
      } else {
        // Price lookup failed (rate limit, symbol not found, etc.) —
        // bank the dollar amount; refreshStockPrices() converts it to
        // units on its own next successful refresh.
        if (holding) {
          holding.amount = (Number(holding.amount) || 0) + amountCHF;
        } else {
          holding = { name: name.toUpperCase(), ticker, amount: amountCHF, dateAdded: today };
          stocks.push(holding);
        }
        result = { path: 'ticker-price-lookup-failed', ticker };
      }
      state['nw:stocks'] = stocks;
    } else {
      const others = state['nw:other'] || [];
      let holding = others.find(it => it.name === name);
      if (holding) {
        holding.amount = (Number(holding.amount) || 0) + amountCHF;
      } else {
        holding = { name, amount: amountCHF, dateAdded: today, rateAtAdd: audPerChf, rateCcy: 'AUD' };
        others.push(holding);
      }
      state['nw:other'] = others;
      result = { path: 'named-fund', name };
    }

    const putUrl = SUPABASE_URL + '/rest/v1/app_state?on_conflict=key';
    const putResp = await fetch(putUrl, {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, restHeaders),
      body: JSON.stringify({ key: 'finance-nw', data: state, updated_at: new Date().toISOString() }),
    });
    if (!putResp.ok) {
      const errText = await putResp.text().catch(() => '');
      return res.status(502).json({ error: 'supabase write failed: ' + errText });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(Object.assign({ ok: true, amountAUD }, result));
  } catch (e) {
    return res.status(502).json({ error: 'import failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
