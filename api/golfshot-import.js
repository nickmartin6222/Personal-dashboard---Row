// ============================================================
// POST /api/golfshot-import
// Receives a Golfshot round-completion email (forwarded by a Google
// Apps Script watching your Gmail — see golfshot-apps-script.gs),
// asks Gemini to read it and extract the round as structured JSON
// (forced schema, not prose-parsing), then appends it to golf:rounds
// in the same Supabase row golf.html's own cloud sync uses — it shows
// up there exactly like a manually-entered round.
//
// Body: { html: string, text: string, subject: string }
//   (Apps Script sends whatever the email actually contains; either
//   html or text alone is enough, both together is more reliable.)
//
// Auth: requires an `x-api-key` header matching GOLFSHOT_IMPORT_SECRET
// (a Vercel env var) — set the same value in the Apps Script.
// Also requires GEMINI_API_KEY (already set for Nova) and the usual
// SUPABASE_URL / SUPABASE_ANON_KEY.
//
// Dedup: a round already present for the same date+course+score is
// skipped rather than logged again, so a re-processed email (the
// Apps Script re-scanning its own rolling search window) can't create
// a duplicate.
// ============================================================

const ROUND_SCHEMA = {
  type: 'object',
  properties: {
    readable: { type: 'boolean', description: 'True if this email is a genuine Golfshot round-completion scorecard with a legible score.' },
    date: { type: 'string', description: 'The round date as YYYY-MM-DD, e.g. from "September 04, 2026".' },
    course: { type: 'string', description: 'The FULL golf course name exactly as it appears in the email subject line or header (e.g. "Bundoora Park Golf Course", not a shortened "Bundoora") — Golfshot sometimes refers to the same course by a shorter name elsewhere in the email body; always prefer the fullest, most complete version of the name.' },
    holesPlayed: { type: 'integer', description: 'How many holes actually have a score recorded — 9 or 18. If only the back 9 (holes 10-18) or front 9 (1-9) have scores, this is 9.' },
    totalScore: { type: 'integer', description: 'The total strokes for the holes actually played (the IN or TOTAL score shown).' },
    totalPar: { type: 'integer', description: 'The par for the holes actually played (OUT par if only front 9, IN par if only back 9, TOTAL par if all 18).' },
    slope: { type: 'integer', description: 'The slope rating, the number after the "/" in e.g. "71.0 / 112" -> 112. 0 if not shown.' },
    courseRating: { type: 'number', description: 'The course/scratch rating, the number before the "/" in e.g. "71.0 / 112" -> 71.0. 0 if not shown.' },
    putts: { type: 'integer', description: 'Total putts for the holes played. 0 if not shown.' },
    fairwaysHit: { type: 'integer', description: 'Number of fairways hit. 0 if not shown.' },
    fairwaysTotal: { type: 'integer', description: 'Number of fairway opportunities (par-4/par-5 holes played, not counting par-3s). 0 if not shown.' },
    eagles: { type: 'integer', description: 'Count of holes scored 2+ under par.' },
    birdies: { type: 'integer', description: 'Count of holes scored 1 under par.' },
    pars: { type: 'integer', description: 'Count of holes scored exactly par.' },
    bogeys: { type: 'integer', description: 'Count of holes scored 1 over par.' },
    doubleBogeys: { type: 'integer', description: 'Count of holes scored 2 over par.' },
    triplePlus: { type: 'integer', description: 'Count of holes scored 3+ over par.' },
    holes: {
      type: 'array',
      description: 'One entry per hole actually played, in the order played (hole 1 first, or hole 10 first if this is a back-9-only round). Needed for the per-round scorecard view. Omit entries you genuinely cannot read rather than guessing.',
      items: {
        type: 'object',
        properties: {
          hole: { type: 'integer', description: 'Hole number as shown on the card (1-18).' },
          par: { type: 'integer' },
          score: { type: 'integer' },
          putts: { type: 'integer', description: '0 if not shown for this hole.' },
          gir: { type: 'boolean', description: 'True if this hole was a green in regulation (the GIR row shows hit for this hole).' }
        },
        required: ['hole', 'par', 'score']
      }
    }
  },
  required: ['readable', 'date', 'course', 'holesPlayed', 'totalScore', 'totalPar', 'holes']
};

// Rounds the golfer has deliberately asked to keep out of the dashboard
// (not a real stroke-play round — e.g. a scramble/best-ball event where
// the score doesn't reflect individual play). Matched on date + course
// so a re-run of the backfill (which resends every past email and thus
// re-offers this one too) can't silently recreate it after a manual
// delete, the way it did once already.
const EXCLUDED_ROUNDS = [
  { date: '2026-01-26', course: 'gosfordgolfclub' }
];
function isExcludedRound(date, course) {
  return EXCLUDED_ROUNDS.some(x => x.date === date && x.course === normalizeForMatch(course));
}

function computeDifferential(score, par, slope) {
  if (!(score > 0) || !(par > 0)) return null;
  return Math.round(((score - par) * 113 / (slope > 0 ? slope : 113)) * 10) / 10;
}

// Golfshot names the same course inconsistently between emails — e.g.
// "Bundoora" in one and "Bundoora Park Golf Course" in another for the
// literal same course. Left unresolved, that fragments the course list
// AND breaks dedup (a round can slip through as "new" under the other
// spelling, which is exactly how an 18-hole/par-72 duplicate of a real
// 9-hole/par-36 round got created). Treat two names as the same course
// if one is a prefix of the other once normalized, and standardize on
// whichever is longer/more complete.
function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function resolveCourseName(rawName, rounds, courses) {
  const norm = normalizeForMatch(rawName);
  const allNames = new Set(rounds.map(r => r.course).filter(Boolean));
  Object.values(courses).forEach(c => { if (c && c.name) allNames.add(c.name); });
  for (const existing of allNames) {
    const en = normalizeForMatch(existing);
    if (en === norm) return existing;
    if (en.startsWith(norm) || norm.startsWith(en)) {
      return rawName.length > existing.length ? rawName : existing;
    }
  }
  return rawName;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const secret = process.env.GOLFSHOT_IMPORT_SECRET;
  if (!secret) return res.status(500).json({ error: 'GOLFSHOT_IMPORT_SECRET not set on the server' });
  if (req.headers['x-api-key'] !== secret) return res.status(401).json({ error: 'unauthorized' });

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set on the server' });
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not set on the server' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'invalid JSON body' }); }
  }
  const emailContent = (body && (body.html || body.text)) || '';
  if (!emailContent) return res.status(400).json({ error: 'expected { html, text, subject } body with at least one of html/text' });

  // 1) Ask Gemini to read the email and return the round as structured JSON.
  let extracted;
  try {
    const prompt = 'This is a Golfshot golf scorecard email (subject: "' + (body.subject || '') + '"). '
      + 'Read it and extract the round exactly as recorded — do not guess or invent figures that '
      + "aren't shown, use 0 for any count not visible. "
      + 'Every genuine Golfshot scorecard email contains a hole-by-hole table (columns like Hole, '
      + 'Par, Score, Putts, GIR — often laid out as a row of numbered hole cells rather than a plain '
      + 'HTML <table>, sometimes split into a "Front 9" block and a "Back 9" block, or styled with '
      + 'colored score bubbles instead of plain digits). Search the ENTIRE email body for it before '
      + 'concluding it is missing — check for repeated structural elements (divs/spans/table cells '
      + 'that recur once per hole), not just literal "Hole" text. Populate the holes array with one '
      + 'entry per hole actually played, reading the par and score printed inside or next to each '
      + "hole's cell even if putts or GIR aren't shown for it (use 0 / false for those two only). "
      + 'Only return an empty holes array if you have genuinely searched the whole email and no '
      + 'per-hole table or hole-numbered score cells exist anywhere in it. Email content:\n\n' + emailContent;
    const geminiResp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
      {
        method: 'POST',
        headers: { 'x-goog-api-key': geminiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: ROUND_SCHEMA }
        })
      }
    );
    const geminiData = await geminiResp.json().catch(() => ({}));
    if (!geminiResp.ok) {
      const msg = (geminiData && geminiData.error && geminiData.error.message) || ('Gemini error ' + geminiResp.status);
      return res.status(502).json({ error: 'extraction failed: ' + msg });
    }
    const candidate = geminiData && geminiData.candidates && geminiData.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
    if (!text) return res.status(502).json({ error: 'Gemini returned no extraction' });
    extracted = JSON.parse(text);
  } catch (e) {
    return res.status(502).json({ error: 'extraction failed: ' + (e && e.message ? e.message : String(e)) });
  }

  if (!extracted.readable) {
    return res.status(200).json({ ok: false, skipped: 'not a readable Golfshot scorecard' });
  }
  if (isExcludedRound(extracted.date, extracted.course)) {
    return res.status(200).json({ ok: false, skipped: 'round is on the permanent exclude list' });
  }

  const restHeaders = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };

  try {
    // 2) Read current golf data.
    const getUrl = SUPABASE_URL + '/rest/v1/app_state?key=eq.golf&select=data';
    const getResp = await fetch(getUrl, { headers: restHeaders });
    const rows = await getResp.json().catch(() => []);
    const state = (Array.isArray(rows) && rows[0] && rows[0].data) || {};
    const rounds = state['golf:rounds'] || [];
    const courses = state['golf:courses'] || {};

    // 2.5) Resolve this email's course name against whatever's already
    // stored, and standardize any existing shorter-variant entries onto
    // the canonical name too — self-heals prior fragmentation instead of
    // just avoiding new fragmentation.
    const canonicalCourse = resolveCourseName(extracted.course, rounds, courses);
    rounds.forEach(r => { if (r.course && r.course !== canonicalCourse && normalizeForMatch(r.course) && normalizeForMatch(canonicalCourse).length && (normalizeForMatch(canonicalCourse).startsWith(normalizeForMatch(r.course)) || normalizeForMatch(r.course).startsWith(normalizeForMatch(canonicalCourse)))) r.course = canonicalCourse; });
    Object.keys(courses).forEach(k => {
      const c = courses[k];
      if (c && c.name && c.name !== canonicalCourse && (normalizeForMatch(canonicalCourse).startsWith(normalizeForMatch(c.name)) || normalizeForMatch(c.name).startsWith(normalizeForMatch(canonicalCourse)))) c.name = canonicalCourse;
    });
    extracted.course = canonicalCourse;

    // 3) Dedup — same date+course+score already logged. If it's already there
    // but missing the per-hole breakdown (imported before that field existed)
    // and this pass found one, enrich it in place instead of skipping — lets
    // re-running the backfill fill in hole-by-hole data for old rounds
    // without creating duplicates.
    const holeByHole = Array.isArray(extracted.holes) ? extracted.holes : [];
    const holes = extracted.holesPlayed === 9 ? 9 : 18;
    const dupIndex = rounds.findIndex(r => r.date === extracted.date && r.course === extracted.course && r.score === extracted.totalScore);
    let round;
    let enriched = false;
    if (dupIndex !== -1) {
      const existing = rounds[dupIndex];
      const alreadyHasHoles = Array.isArray(existing.holeByHole) && existing.holeByHole.length > 0;
      if (holeByHole.length && !alreadyHasHoles) {
        existing.holeByHole = holeByHole;
        round = existing;
        enriched = true;
      } else {
        return res.status(200).json({ ok: false, skipped: 'duplicate round already logged', extracted });
      }
    } else {
      // 4) Build the round, same shape golf.html's own manual-entry saves.
      round = {
        id: 'r' + Date.now() + Math.random().toString(36).slice(2, 7),
        date: extracted.date,
        holes,
        course: extracted.course,
        score: extracted.totalScore,
        par: extracted.totalPar,
        slope: extracted.slope > 0 ? extracted.slope : null,
        differential: computeDifferential(extracted.totalScore, extracted.totalPar, extracted.slope),
        fairways: (extracted.fairwaysTotal > 0) ? (extracted.fairwaysHit + '/' + extracted.fairwaysTotal) : '',
        putts: extracted.putts > 0 ? extracted.putts : null,
        ts: Date.now(),
        source: 'golfshot',
        // Not read by golf.html today, but kept for a future stats view —
        // raw inputs, so nothing here is lost if that view's math changes later.
        rating: extracted.courseRating > 0 ? extracted.courseRating : null,
        eagles: extracted.eagles || 0,
        birdies: extracted.birdies || 0,
        pars: extracted.pars || 0,
        bogeys: extracted.bogeys || 0,
        doubleBogeys: extracted.doubleBogeys || 0,
        triplePlus: extracted.triplePlus || 0,
        // Per-hole { hole, par, score, putts, gir } — powers the round-detail
        // scorecard view. May be empty if Gemini couldn't read the table.
        holeByHole
      };
      rounds.push(round);
    }

    // 5) Keep the course list in sync too, same as a manual save would.
    const key = extracted.course.toLowerCase();
    const existingCourse = courses[key] || { name: extracted.course };
    existingCourse.name = extracted.course;
    if (holes === 9) existingCourse.par9 = extracted.totalPar; else existingCourse.par18 = extracted.totalPar;
    if (extracted.slope > 0) existingCourse.slope = extracted.slope;
    courses[key] = existingCourse;

    state['golf:rounds'] = rounds;
    state['golf:courses'] = courses;

    const putUrl = SUPABASE_URL + '/rest/v1/app_state?on_conflict=key';
    const putResp = await fetch(putUrl, {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, restHeaders),
      body: JSON.stringify({ key: 'golf', data: state, updated_at: new Date().toISOString() })
    });
    if (!putResp.ok) {
      const errText = await putResp.text().catch(() => '');
      return res.status(502).json({ error: 'supabase write failed: ' + errText });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, enriched, round });
  } catch (e) {
    return res.status(502).json({ error: 'import failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
