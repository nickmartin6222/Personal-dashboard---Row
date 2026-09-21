// ============================================================
// GET /api/basiq-sync?key=<BASIQ_SYNC_SECRET>
// Pulls the current balance of every connected Macquarie account from
// Basiq and writes it into nw:bank in the same Supabase app_state row
// (key "finance-nw") the Finance page syncs — so it shows up on the
// dashboard with no manual entry, same idea as the Pearler import.
//
// Unlike Pearler (which ADDS a delta per purchase email), this SETS
// each account's amount to whatever Basiq reports as the current
// balance — a bank balance is a snapshot, not something to accumulate.
// Each account is matched across syncs by its Basiq account id (stored
// as `basiqAccountId` on the holding), so renaming an account on
// Basiq's side or in the dashboard won't create a duplicate row.
//
// Run this manually to start, then point a Vercel Cron Job at this
// same URL (Project Settings -> Cron Jobs) once it's confirmed working,
// so the balance refreshes on its own — e.g. once a day.
//
// Requires /api/basiq-connect to have been run first (needs a stored
// basiq:userId with at least one connected account).
// ============================================================

const BASIQ_BASE = 'https://au-api.basiq.io';

async function getServerToken(apiKey) {
  // Basiq API keys are already the credential to send as-is — see the
  // matching comment in basiq-connect.js.
  const r = await fetch(BASIQ_BASE + '/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'basiq-version': '3.0',
    },
    body: 'scope=SERVER_ACCESS',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Basiq auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

export default async function handler(req, res) {
  const secret = process.env.BASIQ_SYNC_SECRET;
  if (!secret) return res.status(500).json({ error: 'BASIQ_SYNC_SECRET not set on the server' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'unauthorized — add ?key=<BASIQ_SYNC_SECRET> to the URL' });

  const apiKey = process.env.BASIQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'BASIQ_API_KEY not set on the server' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not set on the server' });
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

    const userId = state['basiq:userId'];
    if (!userId) return res.status(400).json({ error: 'No Basiq user yet — run /api/basiq-connect first and complete the Macquarie login.' });

    const serverToken = await getServerToken(apiKey);
    const acctResp = await fetch(BASIQ_BASE + '/users/' + encodeURIComponent(userId) + '/accounts', {
      headers: { Authorization: 'Bearer ' + serverToken, 'basiq-version': '3.0' },
    });
    const acctData = await acctResp.json().catch(() => ({}));
    if (!acctResp.ok) return res.status(502).json({ error: 'Basiq accounts fetch failed', basiq: acctData });

    const accounts = Array.isArray(acctData.data) ? acctData.data : [];
    if (!accounts.length) {
      return res.status(200).json({ ok: true, synced: 0, note: 'No accounts yet — finish connecting Macquarie via the basiq-connect link, Basiq can take a minute to sync after you log in.' });
    }

    const fxRates = state['fx:rates'] || { CHF: 1, AUD: 1.8 };
    const audPerChf = Number(fxRates.AUD) > 0 ? Number(fxRates.AUD) : 1.8;
    const today = new Date().toISOString().slice(0, 10);

    const bank = state['nw:bank'] || [];
    const synced = [];
    accounts.forEach(acc => {
      const balanceAUD = Number(acc.balance);
      if (!(balanceAUD >= 0) && !(balanceAUD < 0)) return; // skip if not a real number
      const balanceCHF = balanceAUD / audPerChf;
      let holding = bank.find(it => it.basiqAccountId === acc.id);
      if (holding) {
        holding.amount = balanceCHF;
        holding.rateAtAdd = audPerChf;
        holding.rateCcy = 'AUD';
        holding.name = acc.name || holding.name;
      } else {
        holding = {
          name: acc.name || ('Macquarie ' + (acc.accountNo || '')).trim(),
          amount: balanceCHF,
          rateAtAdd: audPerChf,
          rateCcy: 'AUD',
          dateAdded: today,
          basiqAccountId: acc.id,
        };
        bank.push(holding);
      }
      synced.push({ name: holding.name, balanceAUD });
    });
    state['nw:bank'] = bank;

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
    return res.status(200).json({ ok: true, synced: synced.length, accounts: synced });
  } catch (e) {
    return res.status(502).json({ error: 'basiq-sync failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
