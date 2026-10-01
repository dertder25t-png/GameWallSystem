// GET /api/wall/schedule: this week's and next week's games for the Wall page.
// Cached at Vercel's edge for 30 s so all testers share one upstream fetch.
const { buildSchedule } = require('../_lib/gamewall');

module.exports = async (req, res) => {
  try {
    const data = await buildSchedule();
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', data.sourceOk ? 's-maxage=30, stale-while-revalidate=120' : 'no-store');
    res.status(200).send(JSON.stringify(data));
  } catch (err) {
    res.status(200).json({ games: [], sourceOk: false, error: 'Schedule unavailable right now' });
  }
};
