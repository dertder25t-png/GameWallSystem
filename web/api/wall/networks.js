// GET /api/wall/networks: streaming services and network → watch-page map.
// One shared copy for every tester (edit api/_lib/networks.json and redeploy).
const { networksData } = require('../_lib/gamewall');

module.exports = (req, res) => {
  res.setHeader('cache-control', 's-maxage=300, stale-while-revalidate=3600');
  res.status(200).json(networksData);
};
