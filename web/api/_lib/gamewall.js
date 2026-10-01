// GameWall data for GameDay's Wall page: a port of GameWallControlServer/Program.cs
// (/api/schedule and /api/panel-data) so the remote works without the laptop's server.
//
// Alpha note: this still reads ESPN's public site API, as agreed for the private alpha.
// It sits behind Vercel's edge cache (see the handlers) so every tester shares one
// fetch. Swap the source here for CollegeFootballData before any paid launch.
'use strict';

const networksData = require('./networks.json');

const ESPN_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
  accept: 'application/json, text/plain, */*',
};

function resolveWatchUrl(network) {
  const entries = networksData.networks || {};
  const priority = networksData.priority || [];
  const entry = network && entries[network];
  if (entry) {
    for (const serviceId of priority) {
      if (entry[serviceId]) return { url: entry[serviceId], source: 'network' };
    }
  }
  return { url: networksData.default || 'https://www.espn.com/watch/', source: 'default' };
}

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: ESPN_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const teamName = c => c?.team?.shortDisplayName ?? c?.team?.displayName ?? c?.athlete?.shortName ?? c?.athlete?.displayName ?? 'Unknown competitor';
const teamLogo = c => c?.team?.logo || (c?.team?.logos || []).map(l => l?.href).find(Boolean) || null;
const score = c => {
  if (c?.score == null) return null;
  const n = parseInt(typeof c.score === 'object' ? c.score.value : c.score, 10);
  return Number.isFinite(n) ? n : null;
};
const firstBroadcast = comp => {
  const b = comp?.broadcasts;
  return Array.isArray(b) && b.length && Array.isArray(b[0]?.names) && b[0].names.length ? b[0].names[0] : null;
};
const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

async function buildSchedule(now = new Date()) {
  // ESPN rejects long date ranges, so ask by week instead: the current week (ESPN's
  // default), then next week by number. Finals older than 12 hours drop off.
  const windowStart = new Date(now.getTime() - 12 * 3600000);
  const base = 'https://site.web.api.espn.com/apis/site/v2/sports';
  const cfb = `${base}/football/college-football/scoreboard?groups=80&limit=300`;
  const results = [];
  try {
    const current = await fetchJson(cfb);
    results.push({ sport: 'football', root: current });
    const week = current?.week?.number;
    const seasonType = current?.leagues?.[0]?.season?.type?.type ?? current?.season?.type;
    if (Number.isInteger(week) && seasonType) {
      try { results.push({ sport: 'football', root: await fetchJson(`${cfb}&week=${week + 1}&seasontype=${seasonType}`) }); }
      catch (_) { /* no next week (end of season): fine */ }
    }
  } catch (err) {
    results.push({ sport: 'football', error: err.message });
  }

  const games = [];
  const seen = new Set();
  let fetchError = null;
  let ok = 0;

  for (const result of results) {
    if (result.root) ok++;
    else if (result.error) fetchError = fetchError || result.error;
    const events = result.root?.events;
    if (!Array.isArray(events)) continue;

    for (const ev of events) {
      try {
        const eventId = String(ev.id);
        const kickoff = new Date(ev.date);
        if (kickoff < windowStart) continue;

        const statusType = ev.status?.type || {};
        const state = statusType.state || 'pre';
        const detail = statusType.shortDetail || '';

        if (seen.has(eventId)) continue;
        seen.add(eventId);
        const competition = ev.competitions?.[0];
        const cs = competition?.competitors;
        if (!Array.isArray(cs) || cs.length < 2) continue;
        const home = cs.find(c => c?.homeAway === 'home');
        const away = cs.find(c => c?.homeAway === 'away');
        if (!home || !away) continue;
        const network = firstBroadcast(competition);
        const watch = resolveWatchUrl(network);
        const w = ev.weather;
        const o = Array.isArray(competition.odds) && competition.odds.length ? competition.odds[0] : null;
        const sit = competition.situation;
        games.push({
          id: eventId, sport: 'football', kickoff: kickoff.toISOString(),
          homeTeam: teamName(home), awayTeam: teamName(away),
          homeLogo: teamLogo(home), awayLogo: teamLogo(away),
          homeScore: score(home), awayScore: score(away),
          state, statusDetail: detail,
          network: network || 'TBD', watchUrl: watch.url, watchUrlSource: watch.source,
          requiresLogin: true, isRace: false,
          weather: w ? { displayValue: w.displayValue ?? null, temperature: num(w.temperature), highTemperature: num(w.highTemperature), conditionId: w.conditionId ?? null } : null,
          odds: o ? { details: o.details ?? null, overUnder: num(o.overUnder), spread: num(o.spread) } : null,
          situation: sit ? { downDistanceText: sit.downDistanceText ?? null, possessionText: sit.possessionText ?? null, lastPlay: sit.lastPlay?.text ?? null } : null,
        });
      } catch (_) {
        // skip one malformed event, keep the rest
      }
    }
  }

  games.sort((a, b) => (a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : 0));
  return { games, sourceOk: ok > 0, error: fetchError };
}

async function buildPanelData(gameId, sport) {
  sport = 'football';
  const rawEventId = String(gameId).split('-')[0];
  if (!/^\d+$/.test(rawEventId)) return { gameId, sport, sourceOk: false, message: 'Bad game id.' };
  const base = 'https://site.web.api.espn.com/apis/site/v2/sports';
  const path = 'football/college-football';
  try {
    const node = await fetchJson(`${base}/${path}/summary?event=${rawEventId}`, 10000);
    const predictor = node.predictor;
    const wp = Array.isArray(node.winprobability) ? node.winprobability : [];
    let homeWinPercentage = num(predictor?.homeTeam?.gameProjection);
    let awayWinPercentage = num(predictor?.awayTeam?.gameProjection);
    if (wp.length) {
      const live = num(wp[wp.length - 1]?.homeWinPercentage);
      if (live != null) {
        homeWinPercentage = live > 1 ? live : live * 100;
        awayWinPercentage = 100 - homeWinPercentage;
      }
    }
    const history = [];
    const step = Math.max(1, Math.floor(wp.length / 20));
    for (let i = 0; i < wp.length; i += step) {
      const v = num(wp[i]?.homeWinPercentage);
      if (v != null) history.push({ homeWin: v > 1 ? v : v * 100, playId: wp[i]?.playId ?? null });
    }
    return {
      gameId, sport,
      header: node.header ?? null,
      winProbability: { homeWinPercentage, awayWinPercentage, history },
      predictor: predictor ?? null,
      gameInfo: node.gameInfo ?? null,
      leaders: node.leaders ?? null,
      boxscore: node.boxscore ?? null,
      odds: Array.isArray(node.odds) ? node.odds[0] ?? null : null,
      sourceOk: true,
    };
  } catch (_) {
    return { gameId, sport, sourceOk: false, message: 'Live summary not currently active for this event.' };
  }
}

module.exports = { buildSchedule, buildPanelData, networksData, resolveWatchUrl };
