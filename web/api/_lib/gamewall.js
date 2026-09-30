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

function ymd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// Game weeks run Tuesday through Monday, US Eastern. Show everything from 12 hours ago
// through the end of NEXT week, so Saturday's games are visible all week long.
function endOfNextGameWeek(now) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const daysUntilTuesday = ((2 - dow + 7) % 7) || 7;
  return new Date(now.getTime() + (daysUntilTuesday + 7) * 86400000);
}

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
    let res = await fetch(url, { headers: ESPN_HEADERS, signal: controller.signal });
    if (!res.ok) {
      const alt = url.includes('site.web.api.espn.com')
        ? url.replace('site.web.api.espn.com', 'site.api.espn.com')
        : url.replace('site.api.espn.com', 'site.web.api.espn.com');
      res = await fetch(alt, { headers: ESPN_HEADERS, signal: controller.signal });
    }
    if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const teamName = c => c?.team?.shortDisplayName ?? c?.team?.displayName ?? c?.athlete?.shortName ?? c?.athlete?.displayName ?? 'Unknown competitor';
const teamLogo = c => (c?.team?.logos || []).map(l => l?.href).find(Boolean) ?? c?.athlete?.flag?.href ?? c?.athlete?.headshot?.href ?? null;
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
  const windowStart = new Date(now.getTime() - 12 * 3600000);
  const windowEnd = endOfNextGameWeek(now);
  const rangeStart = ymd(new Date(now.getTime() - 86400000));
  const rangeEnd = ymd(windowEnd);
  const base = 'https://site.web.api.espn.com/apis/site/v2/sports';
  const endpoints = [
    { sport: 'football', url: `${base}/football/college-football/scoreboard?dates=${rangeStart}-${rangeEnd}&groups=80&limit=400` },
    { sport: 'mma', url: `${base}/mma/ufc/scoreboard` },
    { sport: 'nascar', url: `${base}/racing/nascar-premier/scoreboard` },
    { sport: 'f1', url: `${base}/racing/f1/scoreboard` },
  ];

  const results = await Promise.all(endpoints.map(async e => {
    try { return { sport: e.sport, root: await fetchJson(e.url) }; }
    catch (err) { return { sport: e.sport, error: err.message }; }
  }));

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
        const otherSport = result.sport !== 'football';
        const inWindow = otherSport
          ? kickoff >= new Date(now.getTime() - 5 * 86400000) && kickoff <= new Date(now.getTime() + 7 * 86400000)
          : kickoff >= windowStart && kickoff <= windowEnd;
        if (!inWindow) continue;

        const statusType = ev.status?.type || {};
        const state = statusType.state || 'pre';
        const detail = statusType.shortDetail || '';

        if (result.sport === 'mma') {
          (ev.competitions || []).forEach((bout, i) => {
            const cs = bout?.competitors;
            if (!Array.isArray(cs) || cs.length < 2) return;
            const boutId = `${eventId}-${i}`;
            if (seen.has(boutId)) return;
            seen.add(boutId);
            const bs = bout?.status?.type || {};
            const network = firstBroadcast(bout) || bout?.broadcast || 'ESPN+';
            const watch = resolveWatchUrl(network);
            games.push({
              id: boutId, sport: 'mma', kickoff: kickoff.toISOString(),
              homeTeam: teamName(cs[0]), awayTeam: teamName(cs[1]),
              homeLogo: teamLogo(cs[0]), awayLogo: teamLogo(cs[1]),
              homeScore: score(cs[0]), awayScore: score(cs[1]),
              state: bs.state || state, statusDetail: bs.shortDetail || detail,
              network, watchUrl: watch.url, watchUrlSource: watch.source, requiresLogin: true, isRace: false,
            });
          });
          continue;
        }

        if (result.sport === 'nascar' || result.sport === 'f1') {
          if (seen.has(eventId)) continue;
          seen.add(eventId);
          let comp = ev.competitions?.[0];
          if (result.sport === 'f1') {
            const comps = ev.competitions || [];
            comp = comps.find(c => /^race$/i.test(c?.type?.abbreviation || '') || c?.type?.id === '3')
              || comps.find(c => c?.status?.type?.state === 'in')
              || comps[comps.length - 1] || ev.competitions?.[0];
          }
          const competitors = [...(comp?.competitors || [])].sort((a, b) => (a?.order ?? 1e9) - (b?.order ?? 1e9));
          const leader = competitors[0];
          const leaderName = leader?.athlete?.displayName || leader?.team?.displayName;
          const network = firstBroadcast(comp) || 'ESPN';
          const watch = resolveWatchUrl(network);
          const cst = comp?.status?.type || {};
          const raceState = cst.state || state;
          const raceDetail = cst.shortDetail || detail;
          const eventName = ev.name || ev.shortName || (result.sport === 'f1' ? 'Formula 1' : 'NASCAR Cup Series');
          const session = comp?.type?.abbreviation || 'Race';
          const title = result.sport === 'f1' && !/^race$/i.test(session) ? `${eventName} (${session})` : eventName;
          const when = result.sport === 'f1' && comp?.date ? new Date(comp.date) : kickoff;
          games.push({
            id: eventId, sport: result.sport, kickoff: when.toISOString(),
            homeTeam: title, awayTeam: '', homeLogo: null, awayLogo: null, homeScore: null, awayScore: null,
            state: raceState, statusDetail: leaderName ? `Leader: ${leaderName} · ${raceDetail}` : raceDetail,
            network, watchUrl: watch.url, watchUrlSource: watch.source, requiresLogin: true, isRace: true,
          });
          continue;
        }

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
  sport = String(sport || 'football').toLowerCase();
  const rawEventId = String(gameId).split('-')[0];
  if (!/^\d+$/.test(rawEventId)) return { gameId, sport, sourceOk: false, message: 'Bad game id.' };
  const base = 'https://site.web.api.espn.com/apis/site/v2/sports';
  const path = { mma: 'mma/ufc', nascar: 'racing/nascar-premier', f1: 'racing/f1' }[sport] || 'football/college-football';
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

module.exports = { buildSchedule, buildPanelData, networksData, endOfNextGameWeek, resolveWatchUrl };
