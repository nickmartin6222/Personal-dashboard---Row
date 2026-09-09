// ============================================================
// POST /api/nova
// Proxies to Anthropic's Messages API so the API key never reaches
// the browser. Body is passed straight through to Anthropic (model,
// messages, system, max_tokens, images, etc. — whatever the caller
// sends) and the response is returned as-is.
//
// Requires an ANTHROPIC_API_KEY environment variable in Vercel
// (Project Settings -> Environment Variables). Set a spend limit /
// budget alert on the Anthropic account console, since this proxy
// has no per-user cap of its own.
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'invalid JSON body' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'JSON body required' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'fetch to Anthropic failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
