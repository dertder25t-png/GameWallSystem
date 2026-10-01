(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('gameId');
  const sport = (params.get('sport') || 'football').toLowerCase();
  // Served from GameDay (/wall/panel.html) the data comes from GameDay's API; served by
  // the laptop's Control Server it comes from the local one.
  const PANEL_API_BASE = window.location.pathname.startsWith('/wall') ? '/api/wall' : '/api';

  const el = {
    liveDot: document.getElementById('liveDot'),
    statusBadge: document.getElementById('statusBadge'),
    awayLogo: document.getElementById('awayLogo'),
    awayName: document.getElementById('awayName'),
    awayRecord: document.getElementById('awayRecord'),
    awayScore: document.getElementById('awayScore'),
    homeLogo: document.getElementById('homeLogo'),
    homeName: document.getElementById('homeName'),
    homeRecord: document.getElementById('homeRecord'),
    homeScore: document.getElementById('homeScore'),
    gameClock: document.getElementById('gameClock'),
    oddsInfo: document.getElementById('oddsInfo'),
    situationBanner: document.getElementById('situationBanner'),
    situationText: document.getElementById('situationText'),
    lastPlayText: document.getElementById('lastPlayText'),
    probAwayVal: document.getElementById('probAwayVal'),
    probHomeVal: document.getElementById('probHomeVal'),
    probBarAway: document.getElementById('probBarAway'),
    probBarHome: document.getElementById('probBarHome'),
    probDelta: document.getElementById('probDelta'),
    venueName: document.getElementById('venueName'),
    weatherIcon: document.getElementById('weatherIcon'),
    weatherDetails: document.getElementById('weatherDetails'),
    passLeader: document.getElementById('passLeader'),
    passStat: document.getElementById('passStat'),
    rushLeader: document.getElementById('rushLeader'),
    rushStat: document.getElementById('rushStat'),
    recLeader: document.getElementById('recLeader'),
    recStat: document.getElementById('recStat'),
    networkBroadcast: document.getElementById('networkBroadcast'),
    lastUpdated: document.getElementById('lastUpdated')
  };

  if (!gameId) {
    el.statusBadge.textContent = 'No Game ID specified';
    el.awayName.textContent = 'Please pass ?gameId=<id>';
    return;
  }

  function getWeatherIcon(conditionId) {
    if (!conditionId) return '⛅';
    const cid = String(conditionId);
    if (cid.startsWith('1') || cid.startsWith('2')) return '☀️'; // Sunny
    if (cid.startsWith('3') || cid.startsWith('4') || cid.startsWith('7')) return '☁️'; // Cloudy
    if (cid.startsWith('5') || cid.startsWith('6') || cid.startsWith('11') || cid.startsWith('12')) return '🌧️'; // Rain
    if (cid.startsWith('13') || cid.startsWith('14')) return '⛈️'; // Thunderstorm
    if (cid.startsWith('18') || cid.startsWith('19') || cid.startsWith('20')) return '❄️'; // Snow
    return '⛅';
  }

  async function updatePanel() {
    try {
      // 1. Fetch rich summary
      const res = await fetch(`${PANEL_API_BASE}/panel-data?gameId=${encodeURIComponent(gameId)}&sport=${encodeURIComponent(sport)}`);
      let data = null;
      if (res.ok) {
        data = await res.json();
      }

      // 2. Also fetch schedule for fallback / basic game data
      const schedRes = await fetch(`${PANEL_API_BASE}/schedule`);
      let scheduleGame = null;
      if (schedRes.ok) {
        const schedJson = await schedRes.json();
        scheduleGame = (schedJson.games || []).find(g => g.id === gameId);
      }

      renderData(data, scheduleGame);
      el.lastUpdated.textContent = `Updated: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch (err) {
      el.statusBadge.textContent = 'Retrying...';
    }
  }

  function renderData(richData, schedGame) {
    const isLive = schedGame ? schedGame.state === 'in' : (richData?.header?.competitions?.[0]?.status?.type?.state === 'in');
    const isFinal = schedGame ? schedGame.state === 'post' : (richData?.header?.competitions?.[0]?.status?.type?.completed);

    if (el.liveDot) {
      el.liveDot.style.display = isLive ? 'block' : 'none';
      el.liveDot.style.background = isLive ? '#e5534b' : (isFinal ? '#8b949e' : '#3fb950');
      el.liveDot.style.boxShadow = isLive ? '0 0 10px #e5534b' : 'none';
    }

    if (el.statusBadge) {
      if (isLive) {
        el.statusBadge.className = 'status-badge live';
        el.statusBadge.textContent = schedGame?.statusDetail || 'LIVE';
      } else if (isFinal) {
        el.statusBadge.className = 'status-badge';
        el.statusBadge.textContent = schedGame?.statusDetail || 'FINAL';
      } else {
        el.statusBadge.className = 'status-badge';
        el.statusBadge.textContent = schedGame?.statusDetail || 'SCHEDULED';
      }
    }

    // Teams & Scores
    if (schedGame) {
      el.awayName.textContent = schedGame.awayTeam || 'Away';
      el.homeName.textContent = schedGame.homeTeam || 'Home';
      if (schedGame.awayLogo) {
        el.awayLogo.src = schedGame.awayLogo;
        el.awayLogo.style.display = 'block';
      } else {
        el.awayLogo.style.display = 'none';
      }
      if (schedGame.homeLogo) {
        el.homeLogo.src = schedGame.homeLogo;
        el.homeLogo.style.display = 'block';
      } else {
        el.homeLogo.style.display = 'none';
      }
      el.awayScore.textContent = schedGame.awayScore ?? (isLive || isFinal ? '0' : '-');
      el.homeScore.textContent = schedGame.homeScore ?? (isLive || isFinal ? '0' : '-');
      el.networkBroadcast.textContent = `Broadcast: ${schedGame.network || 'TBD'}`;
    }

    // Header data from ESPN summary if available
    const headerComp = richData?.header?.competitions?.[0];
    if (headerComp?.competitors) {
      const awayComp = headerComp.competitors.find(c => c.homeAway === 'away');
      const homeComp = headerComp.competitors.find(c => c.homeAway === 'home');
      if (awayComp) {
        el.awayRecord.textContent = awayComp.record?.[0]?.displayValue ? `(${awayComp.record[0].displayValue})` : '';
        if (awayComp.score) el.awayScore.textContent = awayComp.score;
      }
      if (homeComp) {
        el.homeRecord.textContent = homeComp.record?.[0]?.displayValue ? `(${homeComp.record[0].displayValue})` : '';
        if (homeComp.score) el.homeScore.textContent = homeComp.score;
      }
      if (headerComp.status?.type?.shortDetail) {
        el.gameClock.textContent = headerComp.status.type.shortDetail;
      }
    }

    // Odds
    const odds = richData?.odds || schedGame?.odds;
    if (odds && odds.details) {
      el.oddsInfo.style.display = 'inline-flex';
      el.oddsInfo.textContent = `${odds.details}${odds.overUnder ? ` • O/U ${odds.overUnder}` : ''}`;
    } else {
      el.oddsInfo.style.display = 'none';
    }

    // Situation & Drive
    const situation = richData?.header?.competitions?.[0]?.situation || schedGame?.situation;
    if (situation && (situation.downDistanceText || situation.possessionText || situation.lastPlay)) {
      el.situationBanner.style.display = 'flex';
      el.situationText.textContent = `${situation.downDistanceText || ''} ${situation.possessionText ? `• ${situation.possessionText}` : ''}`.trim() || 'Game in progress';
      el.lastPlayText.textContent = situation.lastPlay?.text || situation.lastPlay || '';
    } else {
      el.situationBanner.style.display = 'none';
    }

    // Win Probability
    let homeWin = richData?.winProbability?.homeWinPercentage;
    let awayWin = richData?.winProbability?.awayWinPercentage;

    if (homeWin == null && schedGame && (isLive || isFinal)) {
      // Estimate based on score difference
      const hScore = schedGame.homeScore ?? 0;
      const aScore = schedGame.awayScore ?? 0;
      const diff = hScore - aScore;
      if (isFinal) {
        homeWin = diff > 0 ? 100 : (diff < 0 ? 0 : 50);
      } else {
        homeWin = Math.max(5, Math.min(95, Math.round(50 + diff * 4.5)));
      }
      awayWin = 100 - homeWin;
    }

    if (homeWin != null) {
      const hRounded = Math.round(homeWin);
      const aRounded = awayWin != null ? Math.round(awayWin) : 100 - hRounded;

      el.probAwayVal.textContent = `${schedGame?.awayTeam || 'Away'}: ${aRounded}%`;
      el.probHomeVal.textContent = `${schedGame?.homeTeam || 'Home'}: ${hRounded}%`;

      el.probBarAway.style.width = `${aRounded}%`;
      el.probBarHome.style.width = `${hRounded}%`;
      el.probDelta.textContent = isLive ? 'Live probability model' : (isFinal ? 'Final result' : 'Matchup predictor');
    }

    // Weather & Venue
    const gameInfo = richData?.gameInfo;
    const weather = gameInfo?.weather || schedGame?.weather;
    if (gameInfo?.venue?.fullName) {
      const cityState = [gameInfo.venue.address?.city, gameInfo.venue.address?.state].filter(Boolean).join(', ');
      el.venueName.textContent = cityState ? `${gameInfo.venue.fullName} (${cityState})` : gameInfo.venue.fullName;
    }

    if (weather) {
      const temp = weather.temperature != null ? `${weather.temperature}°F ` : '';
      const desc = weather.displayValue || 'Fair';
      const gust = weather.gust ? ` • Wind ${weather.gust}mph` : '';
      const precip = weather.precipitation ? ` • ${weather.precipitation}% Rain` : '';
      el.weatherDetails.textContent = `${temp}${desc}${gust}${precip}`.trim();
      el.weatherIcon.textContent = getWeatherIcon(weather.conditionId);
    }

    // Stat leaders
    const leaders = richData?.leaders;
    if (Array.isArray(leaders) && leaders.length) {
      for (const cat of leaders) {
        const catName = (cat.name || cat.displayName || '').toLowerCase();
        const topLeader = cat.leaders?.[0];
        if (!topLeader) continue;

        const athleteName = topLeader.athlete?.displayName || topLeader.athlete?.shortName || '--';
        const displayVal = topLeader.displayValue || `${topLeader.value || ''}`;

        if (catName.includes('pass')) {
          el.passLeader.textContent = athleteName;
          el.passStat.textContent = displayVal;
        } else if (catName.includes('rush')) {
          el.rushLeader.textContent = athleteName;
          el.rushStat.textContent = displayVal;
        } else if (catName.includes('receiv')) {
          el.recLeader.textContent = athleteName;
          el.recStat.textContent = displayVal;
        }
      }
    }
  }

  updatePanel();
  setInterval(updatePanel, 8000);
})();
