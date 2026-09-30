// GameWall phone screen.
//
// On phones the desktop remote (sidebar + 8 control cards + a toolbar of 15 buttons)
// is replaced by a GameDay-style screen:
//   header      laptop status (tap for display / identify / unpair) and Tools
//   Screens     layout chips + a live picture of the wall; tap a screen to control it
//   Games       GameDay-style list; tap a game, then tap where it goes
//   Tools sheet presets, custom layout, Day Planner, history, streaming services,
//               favorite teams, test pattern, close all, end session
// Everything calls the same functions as the desktop remote (window.GameWallApp),
// so layouts, undo, presets and the planner behave exactly the same.
(() => {
  'use strict';

  const PHONE = window.matchMedia('(max-width: 720px)');
  let api = null;
  let root = null;
  let active = false;

  const ui = {
    filter: 'all',        // all | live | today | mine
    placeTarget: null,    // screen index waiting for a game ("Change game")
    sheet: null,          // { kind, ...params }
  };

  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cloud = () => window.GameWallCloud || null;

  const ICON = {
    tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
    tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8 20.5h8M12 16.5v4"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  };

  // ------------------------------------------------------------ helpers

  const LAYOUTS = [['1', '1'], ['2', '2'], ['4', '4'], ['6', '6'], ['8', '8'], ['featured', 'Featured']];

  function state() { return api.state; }
  function visible() { return api.visibleSlotCount(); }
  function gameLabel(g) { return g ? (g.custom ? g.homeTeam : `${g.awayTeam} @ ${g.homeTeam}`) : ''; }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function allGames() { return [...(state().customGames || []), ...(state().schedule || [])]; }
  function findGame(id) { return allGames().find(g => String(g.id) === String(id)); }

  function screenOf(game) {
    const i = state().slots.findIndex((s, idx) => idx < visible() && s.label && s.lastGame && String(s.lastGame.id) === String(game.id));
    return i >= 0 ? i : null;
  }

  function connection() {
    const c = cloud();
    if (c) return c.getStatus();
    return { paired: true, deviceName: 'This laptop', online: !!state().wsConnected, connecting: false, sessionActive: null, local: true };
  }

  function statusLine(st) {
    if (st.connecting) return 'Connecting…';
    if (!st.online) return 'Offline';
    if (st.sessionActive === true) return 'Wall on';
    if (st.sessionActive === false) return 'Wall off';
    return 'Online';
  }

  function dayLabel(date) {
    const now = new Date();
    if (sameDay(date, now)) return 'Today';
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (sameDay(date, tomorrow)) return 'Tomorrow';
    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function statusText(g) {
    if (g.custom) return 'Your stream';
    if (g.state === 'in') return g.statusDetail || 'Live';
    if (g.state === 'post') return g.statusDetail || 'Final';
    return g.kickoff ? new Date(g.kickoff).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : (g.statusDetail || '');
  }

  // ------------------------------------------------------------ main screen

  function render() {
    if (!active || !api) return;
    const st = connection();
    const needsPairing = cloud() && !st.paired;
    root.innerHTML = `
      <header class="m-head">
        <div class="m-title">Wall</div>
        ${needsPairing ? '' : `
          <button class="m-device" data-act="laptop" aria-label="Laptop and display">
            <span class="m-dot ${st.online ? 'on' : st.connecting ? 'wait' : 'off'}"></span>
            <span class="m-device-name">${esc(st.deviceName)}</span>
            <span class="m-device-status">${esc(statusLine(st))}</span>
          </button>
          <button class="m-icon" data-act="tools" aria-label="Tools">${ICON.tools}</button>`}
      </header>
      <main class="m-main">${needsPairing ? pairingView(st) : wallView(st)}</main>`;
    if (ui.sheet) renderSheet();
  }

  function pairingView(st) {
    return `
      <section class="m-pair">
        <div class="m-pair-icon">${ICON.tv}</div>
        <h1>Connect your laptop</h1>
        <p>On the laptop, click the GameWall icon in the tray and choose <b>Pair a phone</b>. Enter the 6-digit code it shows.</p>
        <form class="m-pair-form" data-form="pair" autocomplete="off">
          <input name="code" class="m-code" inputmode="numeric" maxlength="7" placeholder="000 000" aria-label="Pairing code" />
          <input name="name" class="m-input" maxlength="40" placeholder="Name for this phone" value="${esc(st.defaultPhoneName || '')}" aria-label="Name for this phone" />
          <button class="m-btn primary" type="submit" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Connecting…' : 'Connect'}</button>
        </form>
        ${st.error ? `<p class="m-err" role="alert">${esc(st.error)}</p>` : ''}
        <p class="m-note">First time? Run <b>GameWall - Click to Run</b> on the laptop. It starts with Windows after that.</p>
      </section>`;
  }

  function wallView(st) {
    const s = state();
    const count = visible();
    const empty = s.slots.slice(0, count).filter(x => !x.label).length;
    const canUndo = (s.actionHistory || []).length > 0;
    const screens = `${count} ${count === 1 ? 'screen' : 'screens'}`;
    const layoutName = s.layout === 'custom' ? `Custom · ${screens}` : s.layout === 'featured' ? `Featured · ${screens}` : screens;
    return `
      ${!st.online && !st.connecting ? `<div class="m-banner">Laptop is offline. Open the lid and plug it in; GameWall starts with Windows and reconnects on its own.</div>` : ''}
      ${st.error && st.paired ? `<div class="m-banner m-banner--err">${esc(st.error)}</div>` : ''}
      ${ui.placeTarget !== null ? `<div class="m-banner m-banner--place"><span>Pick a game for <b>Screen ${ui.placeTarget + 1}</b></span><button class="m-link" data-act="cancel-place">Cancel</button></div>` : ''}

      <div class="m-sec"><h2>Screens</h2><span>${esc(layoutName)}</span></div>
      <div class="m-chips">
        ${LAYOUTS.map(([id, label]) => `<button class="m-chip ${s.layout === id ? 'on' : ''}" data-act="layout" data-layout="${id}">${label}</button>`).join('')}
        <button class="m-chip ${s.layout === 'custom' ? 'on' : ''}" data-act="custom-layout">Custom…</button>
      </div>
      ${wallPicture({ act: 'screen' })}
      <div class="m-row">
        <button class="m-btn primary" data-act="autofill" ${empty ? '' : 'disabled'}>${empty ? `Fill ${empty} empty ${empty === 1 ? 'screen' : 'screens'}` : 'All screens filled'}</button>
        <button class="m-btn" data-act="undo" ${canUndo ? '' : 'disabled'}>Undo</button>
      </div>

      <div class="m-sec"><h2>Games</h2><button class="m-link" data-act="refresh">Refresh</button></div>
      ${(s.subscriptions || []).length ? '' : `<button class="m-card m-hint" data-act="services"><b>Pick your streaming services</b><span>So each game opens in an app you pay for.</span>${ICON.chev}</button>`}
      <div class="m-chips">
        ${[['all', 'All'], ['live', 'Live'], ['today', 'Today'], ['mine', 'My teams']].map(([id, label]) =>
          `<button class="m-chip ${ui.filter === id ? 'on' : ''}" data-act="filter" data-filter="${id}">${label}</button>`).join('')}
      </div>
      ${gamesList()}
      <button class="m-link m-add" data-act="add-stream">${ICON.plus} Add a stream by link</button>`;
  }

  // The wall as it looks on the projector: one box per screen, placed like the layout.
  function wallPicture({ act, highlight = null, mark = null }) {
    const s = state();
    const rects = api.layoutRects();
    const count = Math.min(visible(), rects.length, api.SLOT_COUNT);
    let boxes = '';
    for (let i = 0; i < count; i++) {
      const r = rects[i];
      const slot = s.slots[i];
      const g = slot.label ? slot.lastGame : null;
      const title = slot.label ? (g && !g.custom ? `${g.awayTeam} @ ${g.homeTeam}` : slot.label) : '';
      const health = s.health[i];
      boxes += `
        <button class="m-screen ${slot.label ? 'full' : 'empty'} ${highlight === i ? 'hl' : ''} ${mark === i ? 'mark' : ''}"
          style="left:${r.x * 100}%;top:${r.y * 100}%;width:${r.width * 100}%;height:${r.height * 100}%"
          data-act="${act}" data-slot="${i}" aria-label="Screen ${i + 1}${title ? ': ' + esc(title) : ', empty'}">
          <span class="m-screen-n">${i + 1}</span>
          ${slot.label ? `<span class="m-screen-t">${esc(title)}</span>` : `<span class="m-screen-plus">${ICON.plus}</span>`}
          <span class="m-screen-f">
            ${slot.muted && slot.label ? `<i class="m-muted">${ICON.mute}</i>` : ''}
            ${health && health !== 'ok' ? '<i class="m-warn" title="Recovered">!</i>' : ''}
            ${slot.label && slot.network ? `<em>${esc(slot.network)}</em>` : ''}
          </span>
        </button>`;
    }
    return `<div class="m-wall" role="group" aria-label="Screens on the wall">${boxes}</div>`;
  }

  function gamesList() {
    const s = state();
    const now = new Date();
    let games = allGames();
    if (ui.filter === 'live') games = games.filter(g => g.state === 'in');
    if (ui.filter === 'today') games = games.filter(g => g.custom || (g.kickoff && sameDay(new Date(g.kickoff), now)));
    if (ui.filter === 'mine') games = games.filter(g => api.isPinnedGame(g));
    const order = g => g.custom ? 0 : g.state === 'in' ? 1 : g.state === 'pre' ? 2 : 3;
    games.sort((a, b) => order(a) - order(b) || (api.isPinnedGame(b) - api.isPinnedGame(a)) || String(a.kickoff).localeCompare(String(b.kickoff)));

    if (!games.length) {
      const msg = ui.filter === 'live' ? 'No games live right now.'
        : ui.filter === 'mine' ? 'No games for your teams this week. Add teams under Tools → Favorite teams.'
        : ui.filter === 'today' ? 'No games today.'
        : (s.schedule || []).length ? 'Nothing to show.' : 'Loading this week’s games…';
      return `<p class="m-empty">${msg}</p>`;
    }

    let html = '';
    let lastGroup = '';
    for (const g of games) {
      const group = g.custom ? 'Your streams' : g.state === 'in' ? 'Live now' : g.state === 'post' ? 'Final' : dayLabel(new Date(g.kickoff));
      if (group !== lastGroup) { html += `<div class="m-day">${esc(group)}</div>`; lastGroup = group; }
      html += gameRow(g);
    }
    return `<div class="m-list">${html}</div>`;
  }

  function teamLine(name, logo, score, lose, pinned) {
    return `<div class="m-t ${lose ? 'lose' : ''}">
      ${logo ? `<img class="m-logo" src="${esc(logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<span class="m-logo"></span>'}
      <span class="m-tn">${esc(name)}</span>${pinned ? `<i class="m-star">${ICON.star}</i>` : ''}
      ${Number.isInteger(score) ? `<b class="m-sc">${score}</b>` : ''}
    </div>`;
  }

  function gameRow(g) {
    const onScreen = screenOf(g);
    const pinnedTeam = t => (state().pinnedTeams || []).some(p => t && t.toLowerCase().includes(p.toLowerCase()));
    const final = g.state === 'post';
    const awayLose = final && Number.isInteger(g.awayScore) && g.awayScore < g.homeScore;
    const homeLose = final && Number.isInteger(g.homeScore) && g.homeScore < g.awayScore;
    const service = (state().subscriptions || []).length ? api.serviceLabelFor(g) : '';
    const body = g.custom
      ? `<div class="m-t"><span class="m-logo m-logo--c">${ICON.tv}</span><span class="m-tn">${esc(g.homeTeam)}</span></div>`
      : teamLine(g.awayTeam, g.awayLogo, g.awayScore, awayLose, pinnedTeam(g.awayTeam)) + teamLine(g.homeTeam, g.homeLogo, g.homeScore, homeLose, pinnedTeam(g.homeTeam));
    return `
      <button class="m-game ${ui.placeTarget !== null ? 'placing' : ''}" data-act="game" data-game="${esc(g.id)}">
        ${body}
        <div class="m-meta">
          <span class="${g.state === 'in' ? 'm-live' : ''}">${esc(statusText(g))}</span>
          <span>${esc([g.custom ? '' : g.network, service && service !== g.network ? service : ''].filter(Boolean).join(' · '))}</span>
        </div>
        ${onScreen !== null ? `<span class="m-on">On screen ${onScreen + 1}</span>` : ''}
      </button>`;
  }

  // ------------------------------------------------------------ sheets

  function openSheet(sheet) { ui.sheet = sheet; renderSheet(); }
  function closeSheet() {
    ui.sheet = null;
    const layer = document.getElementById('mSheet');
    if (layer) layer.remove();
    document.body.classList.remove('m-sheet-open');
  }

  function renderSheet() {
    const sheet = ui.sheet;
    if (!sheet) return;
    let layer = document.getElementById('mSheet');
    // Don't redraw under a finger that is typing or dragging a slider.
    if (layer && layer.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const content = sheetContent(sheet);
    if (content === null) { closeSheet(); return; }
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'mSheet';
      layer.className = 'm-sheet-layer';
      document.body.appendChild(layer);
      document.body.classList.add('m-sheet-open');
    }
    layer.innerHTML = `
      <div class="m-backdrop" data-act="close-sheet"></div>
      <section class="m-sheet" role="dialog" aria-modal="true" aria-label="${esc(content.title)}">
        <div class="m-grab" aria-hidden="true"></div>
        <header class="m-sheet-head">
          <div><h3>${esc(content.title)}</h3>${content.sub ? `<p>${content.sub}</p>` : ''}</div>
          <button class="m-icon" data-act="close-sheet" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="m-sheet-body">${content.body}</div>
      </section>`;
  }

  function sheetContent(sheet) {
    const s = state();
    switch (sheet.kind) {
      case 'game': {
        const g = findGame(sheet.id);
        if (!g) return null;
        const onScreen = screenOf(g);
        const usual = api.findUsualSlot(g);
        const firstEmpty = s.slots.slice(0, visible()).findIndex(x => !x.label);
        const suggest = onScreen !== null ? null : (usual !== null && usual < visible() ? usual : firstEmpty >= 0 ? firstEmpty : null);
        const service = (s.subscriptions || []).length ? api.serviceLabelFor(g) : '';
        const meta = [statusText(g), g.custom ? '' : g.network, service ? `opens in ${service}` : ''].filter(Boolean).join(' · ');
        const pins = g.custom ? '' : [g.awayTeam, g.homeTeam].map(t => {
          const on = (s.pinnedTeams || []).some(p => p.toLowerCase() === t.toLowerCase());
          return `<button class="m-chip ${on ? 'on' : ''}" data-act="pin" data-team="${esc(t)}">${on ? '★ ' : '☆ '}${esc(t)}</button>`;
        }).join('');
        return {
          title: gameLabel(g),
          sub: esc(meta) + (onScreen !== null ? ` · <b>on screen ${onScreen + 1}</b>` : ''),
          body: `
            <p class="m-label">${sheet.stats ? 'Show live stats on' : 'Put it on'}</p>
            ${wallPicture({ act: sheet.stats ? 'place-stats' : 'place', highlight: suggest, mark: onScreen })}
            <p class="m-help">${suggest !== null ? `Screen ${suggest + 1} is ${usual === suggest ? 'where this team usually goes' : 'free'}. ` : ''}Tap a screen. A game already there gets replaced (Undo brings it back).</p>
            <div class="m-row">
              ${g.custom ? '' : `<button class="m-btn" data-act="toggle-stats">${sheet.stats ? 'Show the game instead' : 'Show live stats instead'}</button>`}
              ${g.custom ? `<button class="m-btn danger" data-act="remove-stream" data-game="${esc(g.id)}">Remove stream</button>` : ''}
            </div>
            ${pins ? `<p class="m-label">Favorite teams</p><div class="m-chips m-chips--wrap">${pins}</div>` : ''}`,
        };
      }

      case 'screen': {
        const i = sheet.slot;
        const slot = s.slots[i];
        if (!slot) return null;
        if (sheet.swap) {
          return {
            title: `Swap screen ${i + 1} with…`,
            sub: esc(slot.label || 'Empty'),
            body: `${wallPicture({ act: 'swap-with', mark: i })}<p class="m-help">Tap the screen to trade places with.</p>`,
          };
        }
        if (!slot.label) {
          return {
            title: `Screen ${i + 1}`,
            sub: 'Empty',
            body: `
              <div class="m-stack">
                <button class="m-btn primary" data-act="place-here" data-slot="${i}">Pick a game for this screen</button>
                ${slot.lastUrl ? `<button class="m-btn" data-act="reopen" data-slot="${i}">Bring back ${esc(slot.lastLabel || 'last stream')}</button>
                <button class="m-btn quiet" data-act="forget" data-slot="${i}">Forget the last stream</button>` : ''}
              </div>`,
          };
        }
        const volume = Math.round((slot.volume ?? 1) * 100);
        return {
          title: `Screen ${i + 1}`,
          sub: esc(slot.label) + (slot.network ? ` · ${esc(slot.network)}` : ''),
          body: `
            <div class="m-li">
              <span>Sound</span>
              <button class="m-switch ${slot.muted ? '' : 'on'}" data-act="mute" data-slot="${i}" role="switch" aria-checked="${!slot.muted}" aria-label="Sound on"><i></i></button>
            </div>
            <div class="m-li">
              <span>Volume</span>
              <input class="m-range" type="range" min="0" max="100" value="${volume}" data-act="volume" data-slot="${i}" aria-label="Volume" ${slot.muted ? 'disabled' : ''}>
            </div>
            <div class="m-stack">
              <button class="m-btn" data-act="place-here" data-slot="${i}">Change game</button>
              <button class="m-btn" data-act="swap" data-slot="${i}">Swap with another screen</button>
              <button class="m-btn danger" data-act="close-screen" data-slot="${i}">Turn off this screen</button>
            </div>`,
        };
      }

      case 'tools': {
        const presetCount = Object.keys(s.presets || {}).length;
        const planner = s.dayPlanner && s.dayPlanner.enabled;
        const row = (act, label, detail, cls = '') => `<button class="m-li m-li--btn ${cls}" data-act="${act}"><span>${label}</span><span class="m-li-r">${detail ? `<em>${detail}</em>` : ''}${ICON.chev}</span></button>`;
        return {
          title: 'Tools',
          body: `
            <div class="m-group">
              ${row('presets', 'Saved lineups', presetCount ? `${presetCount} saved` : '')}
              ${row('custom-layout', 'Custom layout', s.layout === 'custom' ? 'In use' : '')}
              ${row('planner', 'Day Planner', planner ? 'On' : 'Off')}
              ${row('history', 'History', (s.actionHistory || []).length ? `${s.actionHistory.length}` : '')}
            </div>
            <div class="m-group">
              ${row('services', 'Streaming services', (s.subscriptions || []).length ? `${s.subscriptions.length} selected` : 'Not set')}
              ${row('teams', 'Favorite teams', (s.pinnedTeams || []).length ? `${s.pinnedTeams.length}` : '')}
            </div>
            <div class="m-group">
              ${row('test', 'Test pattern', 'Checks the layout')}
              ${row('close-all', 'Turn off all screens', '', 'danger')}
              ${row('end-session', 'End session', 'Hides the wall', 'danger')}
            </div>`,
        };
      }

      case 'laptop': {
        const st = connection();
        const monitors = s.monitors || [];
        return {
          title: st.deviceName,
          sub: esc(statusLine(st)),
          body: `
            <p class="m-label">Show the wall on</p>
            ${monitors.length ? `<div class="m-group">${monitors.map(m => `
              <button class="m-li m-li--btn" data-act="monitor" data-monitor="${m.index}">
                <span>${esc(m.name)}<small>${m.width}×${m.height}</small></span>
                <span class="m-radio ${Number(s.selectedMonitor) === m.index ? 'on' : ''}"></span>
              </button>`).join('')}</div>` : '<p class="m-help">The laptop reports its screens when it’s online.</p>'}
            <div class="m-stack">
              ${cloud() ? '<button class="m-btn" data-act="identify">Show this laptop’s name on the wall</button>' : ''}
              ${cloud() ? '<button class="m-btn danger" data-act="unpair">Unpair this phone</button>' : ''}
            </div>`,
        };
      }

      case 'presets': {
        const names = Object.keys(s.presets || {}).sort();
        return {
          title: 'Saved lineups',
          sub: 'Save what’s on every screen and bring it back with one tap.',
          body: `
            ${names.length ? `<div class="m-group">${names.map(n => `
              <div class="m-li">
                <button class="m-li-main" data-act="apply-preset" data-name="${esc(n)}">${esc(n)}</button>
                <button class="m-icon m-icon--sm" data-act="delete-preset" data-name="${esc(n)}" aria-label="Delete ${esc(n)}">${ICON.close}</button>
              </div>`).join('')}</div>` : '<p class="m-help">No saved lineups yet.</p>'}
            <form class="m-inline" data-form="save-preset">
              <input class="m-input" name="name" maxlength="40" placeholder="Name, e.g. Saturday noon" />
              <button class="m-btn primary" type="submit">Save current</button>
            </form>`,
        };
      }

      case 'teams': {
        const teams = s.pinnedTeams || [];
        const names = [...new Set((s.schedule || []).flatMap(g => [g.homeTeam, g.awayTeam]).filter(Boolean))].sort();
        return {
          title: 'Favorite teams',
          sub: 'Their games sort to the top, get alerts, and fill screens first.',
          body: `
            <div class="m-chips m-chips--wrap">${teams.length ? teams.map(t =>
              `<button class="m-chip on" data-act="pin" data-team="${esc(t)}">★ ${esc(t)} ×</button>`).join('') : '<p class="m-help">None yet.</p>'}</div>
            <form class="m-inline" data-form="add-team">
              <input class="m-input" name="team" list="mTeamNames" placeholder="Add a team" />
              <datalist id="mTeamNames">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
              <button class="m-btn primary" type="submit">Add</button>
            </form>`,
        };
      }

      case 'add-stream':
        return {
          title: 'Add a stream by link',
          sub: 'For a game that isn’t in the list, or any page you want on a screen.',
          body: `
            <form class="m-stack" data-form="add-stream">
              <input class="m-input" name="label" maxlength="60" placeholder="Name, e.g. Army @ Navy" required />
              <input class="m-input" name="url" type="url" placeholder="https://…" required />
              <button class="m-btn primary" type="submit">Add to games</button>
            </form>`,
        };
    }
    return null;
  }

  // ------------------------------------------------------------ actions

  function onClick(event) {
    const target = event.target.closest('[data-act]');
    if (!target || !root) return;
    const act = target.dataset.act;
    const slot = target.dataset.slot !== undefined ? Number(target.dataset.slot) : null;
    const s = state();

    switch (act) {
      case 'close-sheet': closeSheet(); return;
      case 'tools': openSheet({ kind: 'tools' }); return;
      case 'laptop': openSheet({ kind: 'laptop' }); return;
      case 'layout': api.setLayout(target.dataset.layout); return;
      case 'custom-layout': closeSheet(); api.openLayoutEditor(); return;
      case 'autofill': api.autoFill(); return;
      case 'undo': api.undo(); return;
      case 'refresh': api.refreshSchedule(); return;
      case 'filter': ui.filter = target.dataset.filter; render(); return;
      case 'services': closeSheet(); api.openSubscriptions(); return;
      case 'add-stream': openSheet({ kind: 'add-stream' }); return;
      case 'cancel-place': ui.placeTarget = null; render(); return;

      case 'game': {
        const game = findGame(target.dataset.game);
        if (!game) return;
        if (ui.placeTarget !== null) {
          api.assignGame(game, ui.placeTarget);
          ui.placeTarget = null;
          render();
          return;
        }
        openSheet({ kind: 'game', id: game.id, stats: false });
        return;
      }
      case 'toggle-stats': ui.sheet.stats = !ui.sheet.stats; renderSheet(); return;
      case 'place':
      case 'place-stats': {
        const game = findGame(ui.sheet && ui.sheet.id);
        if (!game) return;
        if (act === 'place') api.assignGame(game, slot); else api.showStats(game, slot);
        closeSheet();
        return;
      }
      case 'pin': api.togglePinTeam(target.dataset.team); renderSheet(); return;
      case 'remove-stream': api.removeCustomGame(target.dataset.game); closeSheet(); return;

      case 'screen': openSheet({ kind: 'screen', slot }); return;
      case 'place-here':
        closeSheet();
        ui.placeTarget = slot;
        render();
        document.querySelector('.m-list, .m-empty')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      case 'mute': api.setMuted(slot, !s.slots[slot].muted); return;
      case 'reopen': api.reopenSlot(slot); closeSheet(); return;
      case 'forget': api.clearSlot(slot); closeSheet(); return;
      case 'close-screen': api.closeSlot(slot); closeSheet(); return;
      case 'swap': ui.sheet = { kind: 'screen', slot, swap: true }; renderSheet(); return;
      case 'swap-with': {
        const from = ui.sheet.slot;
        closeSheet();
        if (from !== slot) api.swapSlots(from, slot);
        return;
      }

      case 'presets': openSheet({ kind: 'presets' }); return;
      case 'apply-preset': api.applyPreset(target.dataset.name); closeSheet(); return;
      case 'delete-preset':
        if (confirm(`Delete "${target.dataset.name}"?`)) api.deletePreset(target.dataset.name);
        renderSheet();
        return;
      case 'planner': closeSheet(); api.openDayPlanner(); return;
      case 'history': closeSheet(); api.openHistory(); return;
      case 'teams': openSheet({ kind: 'teams' }); return;
      case 'test': closeSheet(); api.testMode(); return;
      case 'close-all': closeSheet(); if (confirm('Turn off every screen?')) api.closeAll(); return;
      case 'end-session': closeSheet(); api.endSession(); return;

      case 'monitor': api.setMonitor(Number(target.dataset.monitor)); renderSheet(); return;
      case 'identify': cloud()?.identify(); closeSheet(); return;
      case 'unpair':
        if (confirm(`Unpair this phone from ${connection().deviceName}?`)) { closeSheet(); cloud()?.unpair(true); }
        return;
    }
  }

  function onInput(event) {
    const target = event.target;
    if (target.dataset.act === 'volume') api.setVolume(Number(target.dataset.slot), Number(target.value) / 100);
  }

  function onSubmit(event) {
    const form = event.target.closest('[data-form]');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    switch (form.dataset.form) {
      case 'pair': cloud()?.pair(data.get('code'), data.get('name')); return;
      case 'save-preset': {
        const name = String(data.get('name') || '').trim();
        if (!name) return;
        api.savePreset(name);
        form.reset();
        document.activeElement?.blur();
        renderSheet();
        return;
      }
      case 'add-team': {
        const team = String(data.get('team') || '').trim();
        if (!team) return;
        if (!(state().pinnedTeams || []).some(t => t.toLowerCase() === team.toLowerCase())) api.togglePinTeam(team);
        form.reset();
        document.activeElement?.blur();
        renderSheet();
        return;
      }
      case 'add-stream': {
        const label = String(data.get('label') || '').trim();
        const url = String(data.get('url') || '').trim();
        if (!label || !/^https?:\/\//i.test(url)) return;
        api.addCustomGame(label, url);
        closeSheet();
        return;
      }
    }
  }

  // ------------------------------------------------------------ mount

  function setActive(on) {
    active = on;
    document.body.classList.toggle('m-ui', on);
    if (on) {
      if (!root) {
        root = document.createElement('div');
        root.id = 'mApp';
        root.className = 'm-app';
        const anchor = document.getElementById('setupBar') || document.body.firstChild;
        document.body.insertBefore(root, anchor);
        root.addEventListener('click', onClick);
        root.addEventListener('input', onInput);
        root.addEventListener('submit', onSubmit);
        document.addEventListener('click', e => { if (e.target.closest('#mSheet')) onClick(e); });
        document.addEventListener('input', e => { if (e.target.closest('#mSheet')) onInput(e); });
        document.addEventListener('submit', e => { if (e.target.closest('#mSheet')) onSubmit(e); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.sheet) closeSheet(); });
      }
      render();
    } else {
      closeSheet();
    }
  }

  function start() {
    api = window.GameWallApp;
    if (!api) return;
    api.onChange = render;
    document.addEventListener('gamewall:cloud', render);
    setActive(PHONE.matches);
    PHONE.addEventListener('change', e => setActive(e.matches));
  }

  // Mark phones before app.js starts so it skips desktop-only pop-ups.
  if (PHONE.matches) document.documentElement.classList.add('m-ui-early');
  if (window.GameWallApp) start();
  else window.addEventListener('DOMContentLoaded', start);
})();
