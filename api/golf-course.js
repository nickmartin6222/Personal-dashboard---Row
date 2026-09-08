// ============================================================
// GET /api/golf-course?search=<query>   -> course search results
// GET /api/golf-course?id=<courseId>    -> full course detail (tees + holes)
// Proxies GolfCourseAPI (golfcourseapi.com) so the API key never
// reaches the browser. Auth is a Bearer token per their own docs.
//
// Confirmed from GolfCourseAPI's own example responses: a hole is
// only { par, yardage, handicap } — no GPS coordinates for greens or
// tees. There is no live distance-to-pin feature possible from this
// API; this proxy is for course search + scorecard data only.
//
// Requires a GOLFCOURSE_API_KEY environment variable in Vercel
// (Project Settings -> Environment Variables). Free tier is 50
// requests/day — plenty for occasional round logging, not for
// polling.
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.GOLFCOURSE_API_KEY;
  if (!key) return res.status(500).json({ error: 'GOLFCOURSE_API_KEY not set on the server' });

  const { search, id } = req.query || {};
  let url;
  if (id) {
    url = 'https://api.golfcourseapi.com/v1/courses/' + encodeURIComponent(String(id));
  } else if (search) {
    url = 'https://api.golfcourseapi.com/v1/search?search_query=' + encodeURIComponent(String(search));
  } else {
    return res.status(400).json({ error: 'search or id query param required' });
  }

  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key } });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (data && data.error) || ('golfcourseapi http ' + r.status) });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'fetch failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
