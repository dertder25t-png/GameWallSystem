// Pass-through for ESPN's public JSON, used only if the phone can't call ESPN directly.
module.exports = async (req, res) => {
  const raw = String((req.query && req.query.u) || new URL(req.url, 'http://x').searchParams.get('u') || '');
  let url;
  try { url = new URL(raw); } catch (e) { res.status(400).json({ error: 'bad url' }); return; }
  if (url.protocol !== 'https:' || !/(^|\.)espn\.com$/.test(url.hostname)) { res.status(403).json({ error: 'host not allowed' }); return; }
  if (url.hostname === 'site.api.espn.com') url.hostname = 'site.web.api.espn.com';
  try {
    const r = await fetch(url.toString(), { headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
      accept: 'application/json, text/plain, */*'
    } });
    const body = await r.text();
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', r.ok ? 's-maxage=60, stale-while-revalidate=300' : 'no-store');
    if (!r.ok) { console.log('upstream', r.status, url.toString()); res.status(502).json({ error: 'upstream', status: r.status }); return; }
    res.status(200).send(body);
  } catch (e) { res.status(502).json({ error: 'upstream failed' }); }
};
