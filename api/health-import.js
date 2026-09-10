// ============================================================
// POST /api/health-import
// Receives a webhook payload from the "Health Connect Webhook" Android
// app (https://github.com/mcnaveen/health-connect-webhook), which reads
// Health Connect on the phone — including whatever Google Health /
// MyFitnessPal have written into it (steps, nutrition, etc.) — and
// POSTs it here on a schedule.
//
// Payload shape (from that app's docs): a JSON object with `timestamp`,
// `app_version`, and optional snake_case arrays per data type, e.g.:
//   { "steps": [{ count, start_time, end_time }, ...],
//     "nutrition": [{ start_time, end_time, calories, protein_grams,
//                      carbs_grams, fat_grams, sugar_grams,
//                      sodium_grams, dietary_fiber_grams, name }, ...] }
// Any batch may cover a rolling window and can resend the same day —
// entries are merged into per-day totals (last write wins per day for
// steps, per day+meal+start_time for nutrition), not appended, so a
// re-send never double-counts.
//
// Auth: requires an `x-api-key` header matching HEALTH_IMPORT_SECRET
// (a Vercel env var) — set the same value as a custom header in the
// webhook app's config so nobody else can post fake data here.
//
// Writes straight into the same Supabase app_state table sync.js uses,
// under appKey 'health-metrics', as health:steps / health:nutrition —
// health.html picks those up via the normal initCloudSync flow.
// ============================================================

function localDateKey(iso) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(iso));
  } catch (e) {
    return String(iso).slice(0, 10);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secret = process.env.HEALTH_IMPORT_SECRET;
  if (!secret) return res.status(500).json({ error: 'HEALTH_IMPORT_SECRET not set on the server' });
  if (req.headers['x-api-key'] !== secret) return res.status(401).json({ error: 'unauthorized' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not set on the server' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'invalid JSON body' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'JSON body required' });

  const restHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  try {
    // 1) Read whatever's already stored for this app row.
    const getUrl = SUPABASE_URL + '/rest/v1/app_state?key=eq.health-metrics&select=data';
    const getResp = await fetch(getUrl, { headers: restHeaders });
    const rows = await getResp.json().catch(() => []);
    const state = (Array.isArray(rows) && rows[0] && rows[0].data) || {};
    const steps = state['health:steps'] || {};
    const nutrition = state['health:nutrition'] || {};

    // 2) Merge in the new payload.
    (body.steps || []).forEach(s => {
      if (!s || s.count == null || !s.start_time) return;
      const day = localDateKey(s.start_time);
      steps[day] = Math.round(Number(s.count) || 0);
    });

    (body.nutrition || []).forEach(n => {
      if (!n || !n.start_time) return;
      const day = localDateKey(n.start_time);
      if (!nutrition[day]) nutrition[day] = {};
      const mealKey = (n.name || 'meal') + '@' + n.start_time;
      nutrition[day][mealKey] = {
        name: n.name || 'Meal',
        calories: Number(n.calories) || 0,
        proteinG: Number(n.protein_grams) || 0,
        carbsG: Number(n.carbs_grams) || 0,
        fatG: Number(n.fat_grams) || 0,
        sugarG: Number(n.sugar_grams) || 0,
        sodiumG: Number(n.sodium_grams) || 0,
        fiberG: Number(n.dietary_fiber_grams) || 0,
      };
    });

    state['health:steps'] = steps;
    state['health:nutrition'] = nutrition;

    // 3) Upsert the merged state back.
    const putUrl = SUPABASE_URL + '/rest/v1/app_state?on_conflict=key';
    const putResp = await fetch(putUrl, {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, restHeaders),
      body: JSON.stringify({ key: 'health-metrics', data: state, updated_at: new Date().toISOString() }),
    });
    if (!putResp.ok) {
      const errText = await putResp.text().catch(() => '');
      return res.status(502).json({ error: 'supabase write failed: ' + errText });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, daysUpdated: { steps: Object.keys(steps).length, nutrition: Object.keys(nutrition).length } });
  } catch (e) {
    return res.status(502).json({ error: 'import failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
