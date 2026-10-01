// GET /api/wall/panel-data?gameId=...&sport=...: live stats for a Wall stats panel.
const { buildPanelData } = require('../_lib/gamewall');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const gameId = (req.query && req.query.gameId) || url.searchParams.get('gameId');
  const sport = (req.query && req.query.sport) || url.searchParams.get('sport') || 'football';
  if (!gameId) { res.status(400).json({ error: 'gameId is required' }); return; }
  const data = await buildPanelData(String(gameId), String(sport));
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', data.sourceOk ? 's-maxage=15, stale-while-revalidate=60' : 'no-store');
  res.status(200).send(JSON.stringify(data));
};
