// ============================================================
// GET /api/backup-snapshot?key=<BACKUP_SECRET>
//
// Daily safety net: copies every REAL app_state row into a dated
// backup row in the SAME table — key becomes
// "backup:<realKey>:<YYYY-MM-DD>" — so a snapshot of every day's real
// data exists somewhere to restore from if a sync bug (or anything
// else) wipes something again. Triggered automatically once a day by
// a Vercel Cron job (see vercel.json), same pattern as every other
// scheduled/webhook endpoint in this project.
//
// Deliberately as low-risk as possible:
//   - ONLY reads the known real keys, ONLY writes new rows under a
//     "backup:" prefix it fully owns. It never touches, modifies, or
//     even reads-then-writes any live appKey row — so it cannot
//     interact with, race against, or reintroduce any of the sync
//     bugs found and fixed on 2026-09-22.
//   - No deletion logic at all (see KEEP_DAYS note below) — nothing
//     in this file can ever remove data, only add it.
//   - Restoring from a backup is deliberately a manual, supervised
//     step (ask Claude, or run the restore query yourself), never an
//     automated endpoint — a one-click auto-restore is exactly the
//     kind of unsupervised write that caused the original incident.
//
// One-time setup:
//   1. Vercel env var BACKUP_SECRET — any string you make up.
//   2. vercel.json already has the cron entry pointing here with that
//      secret in the query string — update it to match if you change
//      the secret.
//
// Storage cost is trivial (a handful of small JSON rows per day), so
// this doesn't prune old backups — if that ever actually matters, add
// a deletion pass later, deliberately, rather than bundling risky
// DELETE logic into the same run as the safety net itself.
// ============================================================

const KNOWN_KEYS = ['finance-nw', 'po-coach', 'health-metrics', 'nutrition', 'golf'];

export default async function handler(req, res) {
  const secret = process.env.BACKUP_SECRET;
  if (!secret) return res.status(500).json({ error: 'BACKUP_SECRET not set on the server' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'unauthorized' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not set on the server' });
  const restHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  try {
    for (const realKey of KNOWN_KEYS) {
      const getUrl = SUPABASE_URL + '/rest/v1/app_state?key=eq.' + encodeURIComponent(realKey) + '&select=data';
      const getResp = await fetch(getUrl, { headers: restHeaders });
      if (!getResp.ok) {
        results.push({ key: realKey, ok: false, reason: 'GET failed (' + getResp.status + ')' });
        continue;
      }
      const rows = await getResp.json().catch(() => null);
      if (!Array.isArray(rows)) {
        results.push({ key: realKey, ok: false, reason: 'unexpected GET response' });
        continue;
      }
      if (!rows[0] || !rows[0].data) {
        results.push({ key: realKey, ok: false, reason: 'no row found for this key' });
        continue;
      }

      const backupKey = 'backup:' + realKey + ':' + today;
      const putResp = await fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
        method: 'POST',
        headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, restHeaders),
        body: JSON.stringify({ key: backupKey, data: rows[0].data, updated_at: new Date().toISOString() }),
      });
      results.push({ key: realKey, ok: putResp.ok, backupKey: putResp.ok ? backupKey : undefined });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, date: today, results });
  } catch (e) {
    return res.status(502).json({ error: 'backup failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
