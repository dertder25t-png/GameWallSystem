(() => {
  'use strict';

  const SLOT_COUNT = 8;
  const DISPLAY_HOST_PORT = 5000;
  const pageHost = window.location.hostname || 'localhost';
  const savedHost = localStorage.getItem('gamewall_pc_ip');

  function normalizeHost(value) {
    const raw = String(value || '').trim();
    if (!raw) return pageHost;

    try {
      const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
      const parsed = new URL(withScheme);
      if (!parsed.hostname || parsed.hostname === '0.0.0.0')
        return pageHost === '0.0.0.0' ? 'localhost' : pageHost;
      return parsed.hostname;
    } catch (_) {
      return raw.split('/')[0].split(':')[0] || pageHost;
    }
  }

  const normalizedSavedHost = normalizeHost(savedHost);
  if (savedHost && normalizedSavedHost !== savedHost)
    localStorage.setItem('gamewall_pc_ip', normalizedSavedHost);

  // Visible-slot counts per layout, mirrors Layouts.cs on the Display Host.
  const LAYOUT_VISIBLE_COUNT = { '1': 1, '2': 2, '4': 4, '6': 6, '8': 8, 'featured': 5 };

  const state = {
    // Both apps always run on the same PC, so whatever address was used to
    // load THIS page (localhost, or a LAN IP from a phone) is also the
    // Display Host's address - no manual entry needed. A saved override
    // takes precedence if the user ever types something different.
    pcIp: normalizedSavedHost,
    ws: null,
    wsConnected: false,
    connectAttempts: 0,
    selectedGame: null,
    layout: '4',
    slots: Array.from({ length: SLOT_COUNT }, () => ({
      label: null, network: null, muted: false,
      lastUrl: null, lastLabel: null, lastNetwork: null,
    })),
    schedule: [],
    monitors: [],
  };

  // ---------------- DOM refs ----------------
  const el = {
    pcIpInput: document.getElementById('pcIpInput'),
    pcIpSave: document.getElementById('pcIpSave'),
    connState: document.getElementById('connState'),
    layoutPicker: document.getElementById('layoutPicker'),
    testModeBtn: document.getElementById('testModeBtn'),
    closeAllBtn: document.getElementById('closeAllBtn'),
    scheduleList: document.getElementById('scheduleList'),
    scheduleUpdated: document.getElementById('scheduleUpdated'),
    scheduleWarning: document.getElementById('scheduleWarning'),
    addGameLabel: document.getElementById('addGameLabel'),
    addGameUrl: document.getElementById('addGameUrl'),
    addGameBtn: document.getElementById('addGameBtn'),
    slotGrid: document.getElementById('slotGrid'),
    tickerTrack: document.getElementById('tickerTrack'),
    monitorPicker: document.getElementById('monitorPicker'),
  };

  // ---------------- Manual "add a game" fallback ----------------
  // Used when the schedule source is blocked/unavailable, or for any game
  // not in the auto-fetched list. Persisted so it survives page reloads.

  function loadCustomGames() {
    try { return JSON.parse(localStorage.getItem('gamewall_custom_games') || '[]'); }
    catch (_) { return []; }
  }

  function saveCustomGames(list) {
    localStorage.setItem('gamewall_custom_games', JSON.stringify(list));
  }

  state.customGames = loadCustomGames();

  el.addGameBtn.addEventListener('click', () => {
    const label = el.addGameLabel.value.trim();
    const url = el.addGameUrl.value.trim();
    if (!label || !url) return;
    const game = {
      id: 'custom-' + Date.now(),
      homeTeam: label,
      awayTeam: '',
      state: 'pre',
      statusDetail: '',
      network: 'Custom',
      watchUrl: url,
      custom: true,
    };
    state.customGames.push(game);
    saveCustomGames(state.customGames);
    el.addGameLabel.value = '';
    el.addGameUrl.value = '';
    renderSchedule();
  });

  function removeCustomGame(id) {
    state.customGames = state.customGames.filter(g => g.id !== id);
    saveCustomGames(state.customGames);
    renderSchedule();
  }

  // ---------------- WebSocket to the Display Host ----------------

  function connectWebSocket() {
    if (!state.pcIp) return;
    if (state.ws) { try { state.ws.close(); } catch (_) {} }

    state.pcIp = normalizeHost(state.pcIp);
    el.pcIpInput.value = state.pcIp;
    const ws = new WebSocket(`ws://${state.pcIp}:${DISPLAY_HOST_PORT}/`);
    state.ws = ws;

    ws.onopen = () => {
      state.wsConnected = true;
      state.connectAttempts = 0;
      el.connState.textContent = 'connected';
      el.connState.className = 'conn-state conn-state--on';
      sendCommand({ action: 'displays' });
    };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'displays') updateMonitors(message);
      } catch (_) {}
    };
    ws.onclose = () => {
      state.wsConnected = false;
      state.connectAttempts++;

      // A previously saved address can become stale after the wall PC's
      // DHCP lease changes. If the remote was opened from the wall PC/LAN,
      // retry the address that served this page before asking the user to
      // troubleshoot the firewall.
      if (state.connectAttempts >= 3 && state.pcIp !== pageHost) {
        state.pcIp = pageHost;
        localStorage.setItem('gamewall_pc_ip', pageHost);
        el.pcIpInput.value = pageHost;
        state.connectAttempts = 0;
      }
      el.connState.textContent = state.connectAttempts >= 3
        ? 'not connected — check firewall?'
        : 'not connected';
      el.connState.className = 'conn-state conn-state--off';
      el.connState.title = state.connectAttempts >= 3
        ? `Trying ws://${state.pcIp}:${DISPLAY_HOST_PORT}/ repeatedly with no luck. Make sure GameWallDisplayHost.exe is running on that PC and was allowed through Windows Firewall (Private networks) on first launch.`
        : '';
      setTimeout(connectWebSocket, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function sendCommand(cmd) {
    if (state.ws && state.wsConnected) {
      state.ws.send(JSON.stringify(cmd));
    }
  }

  function updateMonitors(message) {
    state.monitors = message.displays || [];
    el.monitorPicker.innerHTML = '';
    for (const monitor of state.monitors) {
      const option = document.createElement('option');
      option.value = monitor.index;
      option.textContent = `${monitor.name} (${monitor.width}x${monitor.height})`;
      el.monitorPicker.appendChild(option);
    }
    el.monitorPicker.disabled = state.monitors.length === 0;
    if (state.monitors.length) el.monitorPicker.value = String(message.selectedIndex ?? 0);
  }

  el.monitorPicker.addEventListener('change', () => {
    sendCommand({ action: 'monitor', monitor: Number(el.monitorPicker.value) });
  });

  el.pcIpSave.addEventListener('click', () => {
    const value = normalizeHost(el.pcIpInput.value);
    if (!value) return;
    state.pcIp = value;
    state.connectAttempts = 0;
    localStorage.setItem('gamewall_pc_ip', value);
    connectWebSocket();
  });

  // Pre-fill the field with the auto-detected address (editable, in case
  // Display Host and Control Server are ever split across machines) and
  // connect immediately without waiting for the user to click anything.
  el.pcIpInput.value = state.pcIp;
  el.pcIpInput.placeholder = 'auto-detected: ' + state.pcIp;
  connectWebSocket();

  // ---------------- Layout picker ----------------

  el.layoutPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-layout]');
    if (!btn) return;
    state.layout = btn.dataset.layout;
    [...el.layoutPicker.children].forEach(b => b.classList.toggle('active', b === btn));
    sendCommand({ action: 'layout', layout: state.layout });
    renderSlots();
  });

  el.testModeBtn.addEventListener('click', () => {
    state.layout = '8';
    [...el.layoutPicker.children].forEach(b => b.classList.toggle('active', b.dataset.layout === '8'));
    sendCommand({ action: 'test' });
    renderSlots();
  });

  el.closeAllBtn.addEventListener('click', () => {
    sendCommand({ action: 'closeAll' });
    state.slots.forEach(s => { s.label = null; s.network = null; });
    renderSlots();
  });

  // ---------------- Schedule (sidebar) ----------------

  async function loadSchedule() {
    try {
      const res = await fetch('/api/schedule');
      const data = await res.json();
      state.schedule = data.games || [];

      if (data.sourceOk === false) {
        el.scheduleWarning.hidden = false;
        el.scheduleWarning.textContent =
          `ESPN schedule unavailable: ${data.error || 'unknown server error'}. ` +
          'Use "Add a game manually" below in the meantime.';
      } else {
        el.scheduleWarning.hidden = true;
      }

      renderSchedule();
      renderTicker();
      el.scheduleUpdated.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      el.scheduleWarning.hidden = false;
      el.scheduleWarning.textContent = 'Could not reach the Control Server. Retrying…';
    }
  }

  function formatKickoff(iso) {
    const d = new Date(iso);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const dayLabel = isToday ? '' : d.toLocaleDateString([], { weekday: 'short' }) + ' ';
    return dayLabel + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function renderSchedule() {
    const combined = [...state.customGames, ...state.schedule];

    if (!combined.length) {
      el.scheduleList.innerHTML = '<p class="schedule-empty">No games in the next two days.</p>';
      return;
    }

    el.scheduleList.innerHTML = '';
    for (const game of combined) {
      const card = document.createElement('div');
      card.className = 'game-card' + (game.custom ? ' custom-game' : '');
      card.draggable = true;
      card.dataset.gameId = game.id;

      const teams = document.createElement('div');
      teams.className = 'game-card-teams';
      if (game.custom) {
        teams.textContent = game.homeTeam;
      } else {
        const awayLogo = document.createElement('img');
        awayLogo.src = game.awayLogo || '';
        awayLogo.alt = '';
        awayLogo.loading = 'lazy';
        awayLogo.hidden = !game.awayLogo;
        const homeLogo = document.createElement('img');
        homeLogo.src = game.homeLogo || '';
        homeLogo.alt = '';
        homeLogo.loading = 'lazy';
        homeLogo.hidden = !game.homeLogo;
        const label = document.createElement('span');
        label.textContent = `${game.awayTeam} @ ${game.homeTeam}`;
        teams.append(awayLogo, label, homeLogo);
      }

      const meta = document.createElement('div');
      meta.className = 'game-card-meta';

      const left = document.createElement('span');
      if (game.custom) {
        left.textContent = 'Custom';
      } else if (game.state === 'in') {
        left.className = 'live';
        left.textContent = `${game.awayScore ?? 0}-${game.homeScore ?? 0} \u00b7 ${game.statusDetail}`;
      } else if (game.state === 'post') {
        left.textContent = `Final ${game.awayScore ?? 0}-${game.homeScore ?? 0}`;
      } else {
        left.textContent = formatKickoff(game.kickoff);
      }
      meta.appendChild(left);

      if (game.custom) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-custom';
        removeBtn.textContent = 'remove';
        removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeCustomGame(game.id); });
        meta.appendChild(removeBtn);
      } else {
        const right = document.createElement('span');
        right.textContent = game.network;
        meta.appendChild(right);
      }

      card.append(teams, meta);

      card.addEventListener('click', () => selectGame(game, card));
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify(game));
      });

      el.scheduleList.appendChild(card);
    }
  }

  function selectGame(game, cardEl) {
    const alreadySelected = state.selectedGame && state.selectedGame.id === game.id;
    [...el.scheduleList.children].forEach(c => c.classList.remove('selected'));
    if (alreadySelected) {
      state.selectedGame = null;
    } else {
      state.selectedGame = game;
      cardEl.classList.add('selected');
    }
  }

  // ---------------- Slot grid ----------------

  function renderSlots() {
    const visibleCount = LAYOUT_VISIBLE_COUNT[state.layout] ?? 4;
    el.slotGrid.innerHTML = '';

    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = state.slots[i];
      const card = document.createElement('div');
      card.className = 'slot-card' + (i >= visibleCount ? ' hidden-slot' : '');
      card.dataset.slot = String(i);

      const head = document.createElement('div');
      head.className = 'slot-card-head';
      head.innerHTML = `<span class="slot-index">Screen ${i + 1}</span><span class="slot-network">${slot.network ?? ''}</span>`;

      const content = document.createElement('div');
      content.className = 'slot-content' + (slot.label ? '' : ' empty');
      content.textContent = slot.label ?? 'Empty \u2014 tap a game, then tap here';

      const controls = document.createElement('div');
      controls.className = 'slot-controls';

      const muteBtn = document.createElement('button');
      muteBtn.textContent = slot.muted ? 'Unmute' : 'Mute';
      muteBtn.className = slot.muted ? 'muted' : '';
      muteBtn.addEventListener('click', () => {
        slot.muted = !slot.muted;
        sendCommand({ action: 'mute', slot: i, muted: slot.muted });
        renderSlots();
      });

      const volume = document.createElement('input');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '100';
      volume.value = '100';
      volume.addEventListener('input', () => {
        sendCommand({ action: 'volume', slot: i, volume: Number(volume.value) / 100 });
      });

      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', () => {
        sendCommand({ action: 'close', slot: i });
        slot.label = null;
        slot.network = null;
        renderSlots();
      });

      const reopenBtn = document.createElement('button');
      reopenBtn.className = 'reopen';
      reopenBtn.textContent = 'Reopen';
      reopenBtn.disabled = !slot.lastUrl;
      reopenBtn.title = slot.lastUrl ? `Reopen ${slot.lastLabel}` : 'Nothing to reopen yet';
      reopenBtn.addEventListener('click', () => {
        if (!slot.lastUrl) return;
        slot.label = slot.lastLabel;
        slot.network = slot.lastNetwork;
        slot.muted = false;
        sendCommand({ action: 'navigate', slot: i, url: slot.lastUrl });
        sendCommand({ action: 'mute', slot: i, muted: false });
        renderSlots();
      });

      controls.append(muteBtn, volume, closeBtn, reopenBtn);
      card.append(head, content, controls);

      // Tap-to-place (works everywhere, including phones)
      card.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
        if (!state.selectedGame) return;
        assignGameToSlot(state.selectedGame, i);
        state.selectedGame = null;
        [...el.scheduleList.children].forEach(c => c.classList.remove('selected'));
      });

      // Drag-and-drop (desktop enhancement)
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const raw = e.dataTransfer.getData('text/plain');
        if (!raw) return;
        try {
          const game = JSON.parse(raw);
          assignGameToSlot(game, i);
        } catch (_) {}
      });

      el.slotGrid.appendChild(card);
    }
  }

  function assignGameToSlot(game, slotIndex) {
    const slot = state.slots[slotIndex];
    const label = game.custom ? game.homeTeam : `${game.awayTeam} @ ${game.homeTeam}`;
    slot.label = label;
    slot.network = game.network;
    slot.muted = false;
    slot.lastUrl = game.watchUrl;
    slot.lastLabel = label;
    slot.lastNetwork = game.network;
    sendCommand({ action: 'navigate', slot: slotIndex, url: game.watchUrl });
    sendCommand({ action: 'mute', slot: slotIndex, muted: false });
    renderSlots();
  }

  // ---------------- Ticker ----------------

  function renderTicker() {
    const live = state.schedule.filter(g => g.state === 'in');
    const list = live.length ? live : state.schedule.slice(0, 12);

    if (!list.length) {
      el.tickerTrack.textContent = 'No games in the next two days.';
      return;
    }

    const parts = list.map(g => {
      if (g.state === 'in') return `${g.awayTeam} ${g.awayScore ?? 0} \u2014 ${g.homeTeam} ${g.homeScore ?? 0} (${g.statusDetail})`;
      if (g.state === 'post') return `Final: ${g.awayTeam} ${g.awayScore ?? 0} \u2014 ${g.homeTeam} ${g.homeScore ?? 0}`;
      return `${g.awayTeam} @ ${g.homeTeam} \u2014 ${formatKickoff(g.kickoff)}`;
    });

    el.tickerTrack.textContent = parts.join('     \u2022     ');
  }

  // ---------------- init ----------------

  renderSlots();
  loadSchedule();
  setInterval(loadSchedule, 30000);
})();
