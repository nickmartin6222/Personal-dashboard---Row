// ============================================================
// POST /api/health-import
// Receives a webhook payload from the "Health Auto Export" iPhone app
// (healthyapps.dev), which reads Apple Health/HealthKit on the phone —
// including whatever Google Health / MyFitnessPal have written into it
// (steps, nutrition, etc.) — and POSTs it here on a schedule.
//
// Payload shape (help.healthyapps.dev/en/health-auto-export/export-format):
//   { "data": { "metrics": [
//       { "name": "step_count", "units": "count",
//         "data": [ { "qty": 8500, "date": "2024-02-06 14:30:00 -0800" } ] },
//       { "name": "dietary_energy", "units": "kcal", "data": [ {...} ] },
//       ... one metric object per health metric the automation is set to send
//   ] } }
// Each `date` string is the phone's own local wall-clock time with its
// UTC offset already applied, so the date portion (first 10 chars) is
// the local calendar day directly — no timezone math needed here.
//
// A batch may resend the same day (e.g. an hourly automation re-covers
// today repeatedly) — every metric+date pair is summed WITHIN this one
// call, then that sum REPLACES whatever was stored for that metric+date,
// so overlapping/resent batches never double-count.
//
// Auth: requires an `x-api-key` header matching HEALTH_IMPORT_SECRET
// (a Vercel env var) — set the same value as a custom header on the
// REST API automation in the app so nobody else can post fake data here.
//
// Writes straight into the same Supabase app_state table sync.js uses,
// under appKey 'health-metrics', as health:steps / health:nutrition —
// health.html picks those up via the normal initCloudSync flow.
// ============================================================

function localDateKey(dateStr) {
  return String(dateStr).slice(0, 10);
}

// Health Auto Export metric `name`s aren't 100% pinned down in the docs,
// so match by keyword rather than an exact string — resilient to minor
// naming differences (e.g. "dietary_energy" vs "dietary_energy_consumed").
const NUTRITION_MATCHERS = [
  { key: 'calories', test: n => /energy/i.test(n) && !/basal|active/i.test(n) },
  { key: 'proteinG', test: n => /protein/i.test(n) },
  { key: 'carbsG', test: n => /carbohydrate/i.test(n) },
  { key: 'fatG', test: n => /fat/i.test(n) && /total/i.test(n) },
  { key: 'sugarG', test: n => /sugar/i.test(n) },
  { key: 'sodiumG', test: n => /sodium/i.test(n) },
  { key: 'fiberG', test: n => /fiber/i.test(n) },
];

// Apple's "Walking + Running Distance" metric — kept in whatever unit the
// phone reports (mi or km) rather than force-converted, since the units
// string is stored alongside it for the frontend to label correctly.
const DISTANCE_MATCH = n => /walking.*distance|running.*distance|distance.*walking/i.test(n);

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
  const metrics = (body && body.data && Array.isArray(body.data.metrics)) ? body.data.metrics : null;
  if (!metrics) return res.status(400).json({ error: 'expected { data: { metrics: [...] } } body' });

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
    const distance = state['health:distance'] || {};

    // 2) Sum this call's own entries per metric+date, then overwrite
    // (not add to) whatever was already stored for those dates.
    const stepsThisCall = {};
    const nutritionThisCall = {};
    const distanceThisCall = {};
    let distanceUnit = state['health:distanceUnit'] || 'mi';

    metrics.forEach(m => {
      if (!m || !m.name || !Array.isArray(m.data)) return;
      const name = String(m.name);

      if (/step_count|^steps$/i.test(name)) {
        m.data.forEach(pt => {
          if (!pt || pt.qty == null || !pt.date) return;
          const day = localDateKey(pt.date);
          stepsThisCall[day] = (stepsThisCall[day] || 0) + (Number(pt.qty) || 0);
        });
        return;
      }

      if (DISTANCE_MATCH(name)) {
        if (m.units) distanceUnit = m.units;
        m.data.forEach(pt => {
          if (!pt || pt.qty == null || !pt.date) return;
          const day = localDateKey(pt.date);
          distanceThisCall[day] = (distanceThisCall[day] || 0) + (Number(pt.qty) || 0);
        });
        return;
      }

      const matcher = NUTRITION_MATCHERS.find(x => x.test(name));
      if (matcher) {
        // Apple Health (and this app's Whoop card) can report energy in
        // kilojoules rather than kcal depending on the device's region/
        // units setting — convert to kcal so "calories" is always kcal.
        const isEnergyInKJ = matcher.key === 'calories' && /kj|kilojoule/i.test(m.units || '');
        m.data.forEach(pt => {
          if (!pt || pt.qty == null || !pt.date) return;
          const day = localDateKey(pt.date);
          if (!nutritionThisCall[day]) nutritionThisCall[day] = {};
          const qty = (Number(pt.qty) || 0) / (isEnergyInKJ ? 4.184 : 1);
          nutritionThisCall[day][matcher.key] = (nutritionThisCall[day][matcher.key] || 0) + qty;
        });
      }
    });

    Object.keys(stepsThisCall).forEach(day => { steps[day] = Math.round(stepsThisCall[day]); });
    Object.keys(distanceThisCall).forEach(day => { distance[day] = Math.round(distanceThisCall[day] * 100) / 100; });
    Object.keys(nutritionThisCall).forEach(day => {
      nutrition[day] = Object.assign(
        { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, sugarG: 0, sodiumG: 0, fiberG: 0 },
        nutrition[day] || {},
        nutritionThisCall[day]
      );
    });

    state['health:steps'] = steps;
    state['health:nutrition'] = nutrition;
    state['health:distance'] = distance;
    state['health:distanceUnit'] = distanceUnit;

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
    return res.status(200).json({
      ok: true,
      stepsDaysTouched: Object.keys(stepsThisCall),
      nutritionDaysTouched: Object.keys(nutritionThisCall),
    });
  } catch (e) {
    return res.status(502).json({ error: 'import failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
