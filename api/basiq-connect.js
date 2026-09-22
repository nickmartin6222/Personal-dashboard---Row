// ============================================================
// GET /api/basiq-connect?key=<BASIQ_SYNC_SECRET>
// One-time setup step: creates (or reuses) a Basiq "user" for you and
// returns a link to Basiq's own hosted login page, where you connect
// Macquarie by entering your real online-banking credentials directly
// into Basiq's page — this server never sees them.
//
// The Basiq user id is stored in the same Supabase app_state row the
// rest of Finance uses (key "finance-nw", field "basiq:userId"), so
// this only needs to run once. Re-running it is safe — it reuses the
// stored id instead of creating a second user.
//
// Env vars needed on Vercel:
//   BASIQ_API_KEY     — from dashboard.basiq.io -> your Application
//   BASIQ_SYNC_SECRET — any string you make up, shared with basiq-sync
//   SUPABASE_URL / SUPABASE_ANON_KEY — already set for the rest of the app
// ============================================================

const BASIQ_BASE = 'https://au-api.basiq.io';

async function getServerToken(apiKey) {
  // Basiq API keys are already the credential to send as-is — no extra
  // base64-wrapping needed (that was the bug: double-encoding produced
  // a header Basiq's /token endpoint rejected outright).
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

async function getClientToken(apiKey, userId) {
  const r = await fetch(BASIQ_BASE + '/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'basiq-version': '3.0',
    },
    body: 'scope=CLIENT_ACCESS&userId=' + encodeURIComponent(userId),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Basiq client-token failed: ' + JSON.stringify(data));
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
    // Same GET-merge-PUT safety fix as pearler-import.js — a failed or
    // unexpected GET here must never be treated as "no existing data",
    // since the PUT below (see the basiq:userId write) replaces the
    // FULL row. Silently degrading to state={} on a GET hiccup would
    // wipe every real holding the same way that already happened once.
    if (!getResp.ok) {
      const errText = await getResp.text().catch(() => '');
      return res.status(502).json({ error: 'refusing to continue: could not read existing data (' + getResp.status + '): ' + errText });
    }
    const rows = await getResp.json().catch(() => null);
    if (!Array.isArray(rows)) {
      return res.status(502).json({ error: 'refusing to continue: unexpected response reading existing data' });
    }
    const state = (rows[0] && rows[0].data) || {};

    const serverToken = await getServerToken(apiKey);
    let userId = state['basiq:userId'];

    if (!userId) {
      const createResp = await fetch(BASIQ_BASE + '/users', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + serverToken,
          'Content-Type': 'application/json',
          'basiq-version': '3.0',
        },
        // Basiq requires SOME identifier — a placeholder email is fine,
        // it's never emailed, just used as the account key on their side.
        body: JSON.stringify({ email: 'nick-dashboard@example.com' }),
      });
      const created = await createResp.json().catch(() => ({}));
      if (!createResp.ok || !created.id) {
        return res.status(502).json({ error: 'Basiq user creation failed', basiq: created });
      }
      userId = created.id;

      const putUrl = SUPABASE_URL + '/rest/v1/app_state?on_conflict=key';
      state['basiq:userId'] = userId;
      await fetch(putUrl, {
        method: 'POST',
        headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, restHeaders),
        body: JSON.stringify({ key: 'finance-nw', data: state, updated_at: new Date().toISOString() }),
      });
    }

    // Basiq won't generate a consent link without a valid mobile number
    // on the user record — pass ?mobile=+61...  once to set it (safe to
    // include on every call, it's a no-op if already set to this value).
    const mobile = req.query.mobile;
    if (mobile) {
      const updateResp = await fetch(BASIQ_BASE + '/users/' + encodeURIComponent(userId), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + serverToken,
          'Content-Type': 'application/json',
          'basiq-version': '3.0',
        },
        body: JSON.stringify({ mobile: String(mobile) }),
      });
      const updated = await updateResp.json().catch(() => ({}));
      if (!updateResp.ok) {
        return res.status(502).json({ error: 'Basiq user update (mobile) failed', basiq: updated });
      }
    }

    const clientToken = await getClientToken(apiKey, userId);
    // Basiq's hosted Consent UI — logs you into Macquarie on THEIR page,
    // never sends your bank credentials through this server.
    const connectUrl = 'https://consent.basiq.io/home?token=' + encodeURIComponent(clientToken) + '&action=connect';

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, userId, connectUrl, note: 'Open connectUrl in a browser and log into Macquarie there.' });
  } catch (e) {
    return res.status(502).json({ error: 'basiq-connect failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
