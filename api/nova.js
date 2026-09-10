// ============================================================
// POST /api/nova
// Proxies Nova's chat to Google's Gemini API so the key never reaches
// the browser. The frontend (FROK-finance-standalone.html's
// callClaude()) still sends/expects Anthropic Messages-API shaped
// JSON — this endpoint translates both directions so nothing else in
// the app had to change when the model swapped from Claude to Gemini.
//
//   in:  { model, max_tokens, system, messages: [{role, content}] }
//   out: { content: [{ type: 'text', text: '...' }] }   (Anthropic-shaped)
//
// Requires a GEMINI_API_KEY environment variable in Vercel (Project
// Settings -> Environment Variables) — from aistudio.google.com, no
// billing needed to start. Optional GEMINI_MODEL env var overrides
// the model id (default gemini-3.6-flash) without a code change, since
// Google renames/retires model ids fairly often.
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set on the server' });
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'invalid JSON body' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'JSON body required' });

  // Anthropic 'assistant' -> Gemini 'model'; both use plain-string
  // content in this app (no images/tool-use go through Nova).
  const contents = (Array.isArray(body.messages) ? body.messages : []).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
  }));

  const geminiBody = {
    contents,
    generationConfig: { maxOutputTokens: body.max_tokens || 1024 }
  };
  if (body.system) geminiBody.systemInstruction = { parts: [{ text: body.system }] };

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'content-type': 'application/json'
      },
      body: JSON.stringify(geminiBody)
    });
    const data = await r.json().catch(() => ({}));
    res.setHeader('Cache-Control', 'no-store');

    if (!r.ok) {
      // Re-shape Gemini's { error: { message } } into the same field
      // callClaude() already reads, so its existing error handling
      // (data.error.message) doesn't need to change either.
      const msg = (data && data.error && data.error.message) || ('Gemini API error (' + r.status + ')');
      return res.status(r.status).json({ error: { message: msg } });
    }

    const candidate = data && data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(p => p.text || '').join('')
      : '';
    return res.status(200).json({ content: [{ type: 'text', text: text }] });
  } catch (e) {
    return res.status(502).json({ error: { message: 'fetch to Gemini failed: ' + (e && e.message ? e.message : String(e)) } });
  }
}
