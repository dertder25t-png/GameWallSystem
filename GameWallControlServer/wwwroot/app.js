(() => {
  'use strict';

  const SLOT_COUNT = 8;
  const DISPLAY_HOST_PORT = 5000;
  // Served from GameDay (gameday-cfb.vercel.app/wall/) = cloud mode: commands go through
  // the GameWall relay to a paired laptop (wall-cloud.js). Served by the laptop's own
  // Control Server = local mode: talk straight to the Display Host over the LAN socket.
  const CLOUD = window.GameWallCloud || null;
  const ON_WALL_PATH = window.location.pathname.startsWith('/wall');
  const API_BASE = ON_WALL_PATH ? '/api/wall' : '/api';
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
    wsConnectTimer: null,
    wsConnected: false,
    connectAttempts: 0,
    reconnectTimer: null,
    selectedGame: null,
    layout: '4',
    customLayoutRects: loadCustomLayoutRects(),
    customLayoutPresets: loadCustomLayoutPresets(),
    slots: Array.from({ length: SLOT_COUNT }, () => ({
      label: null, network: null, muted: false,
      lastUrl: null, lastLabel: null, lastNetwork: null, lastGame: null,
    })),
    schedule: [],
    monitors: [],
    networksData: null,
    subscriptions: loadSubscriptions(),
    signedInServices: loadJsonArray('gamewall_signed_in_services'),
    customServices: loadJsonObject('gamewall_custom_services'),
    presets: loadPresets(),
    clients: [],
    health: Array.from({ length: SLOT_COUNT }, () => 'ok'),
    pinnedTeams: loadJsonArray('gamewall_pinned_teams'),
    lastScreenByTeam: loadJsonObject('gamewall_last_screen_by_team'),
    dayPlanner: loadDayPlanner(),
    actionHistory: loadJsonArray('gamewall_action_history'),
    wallStateRevision: 0,
    selectedSlotForStats: null,
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
    subscriptionsBtn: document.getElementById('subscriptionsBtn'),
    subscriptionsModal: document.getElementById('subscriptionsModal'),
    subscriptionsList: document.getElementById('subscriptionsList'),
    subscriptionsError: document.getElementById('subscriptionsError'),
    subscriptionsCloseBtn: document.getElementById('subscriptionsCloseBtn'),
    subscriptionsSkipBtn: document.getElementById('subscriptionsSkipBtn'),
    subscriptionsSaveBtn: document.getElementById('subscriptionsSaveBtn'),
    customServiceName: document.getElementById('customServiceName'),
    customServiceLogin: document.getElementById('customServiceLogin'),
    customServiceWatch: document.getElementById('customServiceWatch'),
    addCustomServiceBtn: document.getElementById('addCustomServiceBtn'),
    presetPicker: document.getElementById('presetPicker'),
    savePresetBtn: document.getElementById('savePresetBtn'),
    applyPresetBtn: document.getElementById('applyPresetBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    clientsStatus: document.getElementById('clientsStatus'),
    pinnedTeamsInput: document.getElementById('pinnedTeamsInput'),
    pinnedTeamsSave: document.getElementById('pinnedTeamsSave'),
    pinnedTeamsTags: document.getElementById('pinnedTeamsTags'),
    teamSuggestions: document.getElementById('teamSuggestions'),
    autoFillBtn: document.getElementById('autoFillBtn'),
    customLayoutBtn: document.getElementById('customLayoutBtn'),
    layoutEditorModal: document.getElementById('layoutEditorModal'),
    layoutEditorCloseBtn: document.getElementById('layoutEditorCloseBtn'),
    layoutEditorCancelBtn: document.getElementById('layoutEditorCancelBtn'),
    applyLayoutToWallBtn: document.getElementById('applyLayoutToWallBtn'),
    minimapScreen: document.getElementById('minimapScreen'),
    snapGridToggle: document.getElementById('snapGridToggle'),
    addEditorSlotBtn: document.getElementById('addEditorSlotBtn'),
    clearEditorSlotsBtn: document.getElementById('clearEditorSlotsBtn'),
    customLayoutNameInput: document.getElementById('customLayoutNameInput'),
    saveCustomPresetBtn: document.getElementById('saveCustomPresetBtn'),
    customPresetSelect: document.getElementById('customPresetSelect'),
    loadCustomPresetBtn: document.getElementById('loadCustomPresetBtn'),
    deleteCustomPresetBtn: document.getElementById('deleteCustomPresetBtn'),
    dayPlannerBtn: document.getElementById('dayPlannerBtn'),
    dayPlannerBadge: document.getElementById('dayPlannerBadge'),
    dayPlannerModal: document.getElementById('dayPlannerModal'),
    dayPlannerCloseBtn: document.getElementById('dayPlannerCloseBtn'),
    dayPlannerSaveCloseBtn: document.getElementById('dayPlannerSaveCloseBtn'),
    plannerMasterToggle: document.getElementById('plannerMasterToggle'),
    plannerActiveStatus: document.getElementById('plannerActiveStatus'),
    plannerPolicyAutoSwitch: document.getElementById('plannerPolicyAutoSwitch'),
    plannerPolicyOtDelay: document.getElementById('plannerPolicyOtDelay'),
    plannerPolicyProtectPinned: document.getElementById('plannerPolicyProtectPinned'),
    plannerPolicyAudioFocus: document.getElementById('plannerPolicyAudioFocus'),
    plannerOtPolicy: document.getElementById('plannerOtPolicy'),
    plannerOtGraceMinutes: document.getElementById('plannerOtGraceMinutes'),
    plannerManualOverridePrecedence: document.getElementById('plannerManualOverridePrecedence'),
    plannerMissingGameFallback: document.getElementById('plannerMissingGameFallback'),
    plannerGenerateTodayBtn: document.getElementById('plannerGenerateTodayBtn'),
    plannerClearPlanBtn: document.getElementById('plannerClearPlanBtn'),
    plannerBlocksList: document.getElementById('plannerBlocksList'),
    addPlannerBlockBtn: document.getElementById('addPlannerBlockBtn'),
    historyBtn: document.getElementById('historyBtn'),
    historyBadge: document.getElementById('historyBadge'),
    historyModal: document.getElementById('historyModal'),
    historyCloseBtn: document.getElementById('historyCloseBtn'),
    historyList: document.getElementById('historyList'),
    undoLatestBtn: document.getElementById('undoLatestBtn'),
    clearHistoryBtn: document.getElementById('clearHistoryBtn'),
    toastContainer: document.getElementById('toastContainer'),
  };

  function loadJsonArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }

  function loadJsonObject(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  }

  const PRESET_RECTS = {
    '1': [
      { x: 0, y: 0, width: 1, height: 1 }
    ],
    '2': [
      { x: 0, y: 0, width: 0.5, height: 1 },
      { x: 0.5, y: 0, width: 0.5, height: 1 }
    ],
    '4': [
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
    ],
    '6': [
      { x: 0, y: 0, width: 1 / 3, height: 0.5 },
      { x: 1 / 3, y: 0, width: 1 / 3, height: 0.5 },
      { x: 2 / 3, y: 0, width: 1 / 3, height: 0.5 },
      { x: 0, y: 0.5, width: 1 / 3, height: 0.5 },
      { x: 1 / 3, y: 0.5, width: 1 / 3, height: 0.5 },
      { x: 2 / 3, y: 0.5, width: 1 / 3, height: 0.5 }
    ],
    '8': [
      { x: 0, y: 0, width: 0.25, height: 0.5 },
      { x: 0.25, y: 0, width: 0.25, height: 0.5 },
      { x: 0.5, y: 0, width: 0.25, height: 0.5 },
      { x: 0.75, y: 0, width: 0.25, height: 0.5 },
      { x: 0, y: 0.5, width: 0.25, height: 0.5 },
      { x: 0.25, y: 0.5, width: 0.25, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.25, height: 0.5 },
      { x: 0.75, y: 0.5, width: 0.25, height: 0.5 }
    ],
    'featured': [
      { x: 0, y: 0, width: 2 / 3, height: 1 },
      { x: 2 / 3, y: 0, width: 1 / 3, height: 0.25 },
      { x: 2 / 3, y: 0.25, width: 1 / 3, height: 0.25 },
      { x: 2 / 3, y: 0.5, width: 1 / 3, height: 0.25 },
      { x: 2 / 3, y: 0.75, width: 1 / 3, height: 0.25 }
    ],
    'pip': [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0.68, y: 0.68, width: 0.30, height: 0.30 }
    ],
    'split3': [
      { x: 0, y: 0, width: 2 / 3, height: 1 },
      { x: 2 / 3, y: 0, width: 1 / 3, height: 0.5 },
      { x: 2 / 3, y: 0.5, width: 1 / 3, height: 0.5 }
    ]
  };

  function loadCustomLayoutRects() {
    try {
      const v = JSON.parse(localStorage.getItem('gamewall_active_custom_layout') || '[]');
      return Array.isArray(v) && v.length ? v : [
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0.5, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
      ];
    } catch (_) {
      return [
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0.5, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
      ];
    }
  }

  function loadCustomLayoutPresets() {
    try {
      const v = JSON.parse(localStorage.getItem('gamewall_custom_layouts') || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (_) { return {}; }
  }

  function loadDayPlanner() {
    try {
      const v = JSON.parse(localStorage.getItem('gamewall_day_planner') || '{}');
      if (v && Array.isArray(v.blocks)) {
        if (!v.otPolicy) v.otPolicy = 'wait';
        if (!v.otGraceMinutes) v.otGraceMinutes = 20;
        if (!v.manualOverridePrecedence) v.manualOverridePrecedence = 'keepUntilNextBlock';
        if (!v.missingGameFallback) v.missingGameFallback = 'autoSubstitute';
        return v;
      }
    } catch (_) {}
    return {
      enabled: false,
      autoSwitchCompleted: true,
      otDelay: true,
      protectPinned: true,
      audioFocus: false,
      otPolicy: 'wait',
      otGraceMinutes: 20,
      manualOverridePrecedence: 'keepUntilNextBlock',
      missingGameFallback: 'autoSubstitute',
      blocks: [
        {
          id: 'block-noon',
          time: '12:00',
          name: 'Noon Kickoff Slate',
          layout: '4',
          slotRules: [
            { type: 'pinned', value: '' },
            { type: 'auto', value: '' },
            { type: 'auto', value: '' },
            { type: 'auto', value: '' }
          ],
          executedDate: null
        },
        {
          id: 'block-afternoon',
          time: '15:30',
          name: 'Afternoon Slate',
          layout: '4',
          slotRules: [
            { type: 'pinned', value: '' },
            { type: 'auto', value: '' },
            { type: 'auto', value: '' },
            { type: 'auto', value: '' }
          ],
          executedDate: null
        },
        {
          id: 'block-primetime',
          time: '19:00',
          name: 'Saturday Primetime',
          layout: 'featured',
          slotRules: [
            { type: 'pinned', value: '' },
            { type: 'auto', value: '' },
            { type: 'auto', value: '' },
            { type: 'auto', value: '' },
            { type: 'auto', value: '' }
          ],
          executedDate: null
        }
      ]
    };
  }

  function showToast(title, message, isLive = false, timeout = 8000, onUndo = null) {
    if (!el.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast' + (isLive ? ' toast--live' : '');
    const head = document.createElement('div');
    head.className = 'toast-head';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;

    const rightHead = document.createElement('div');
    rightHead.style.display = 'flex';
    rightHead.style.alignItems = 'center';
    rightHead.style.gap = '6px';

    if (onUndo) {
      const undoBtn = document.createElement('button');
      undoBtn.className = 'toast-undo-btn';
      undoBtn.textContent = 'Undo';
      undoBtn.type = 'button';
      undoBtn.title = 'Roll back this action';
      undoBtn.addEventListener('click', () => {
        onUndo();
        toast.remove();
      });
      rightHead.appendChild(undoBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => toast.remove());
    rightHead.appendChild(closeBtn);

    head.append(titleSpan, rightHead);

    if (message) {
      const msg = document.createElement('div');
      msg.className = 'toast-msg';
      msg.textContent = message;
      toast.append(head, msg);
    } else {
      toast.appendChild(head);
    }

    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, timeout);
  }

  // ---------------- Action History & Undo (§7.2) ----------------
  function snapshotWallState() {
    return {
      layout: state.layout,
      customLayoutRects: state.customLayoutRects ? JSON.parse(JSON.stringify(state.customLayoutRects)) : null,
      slots: state.slots.map(s => ({
        url: s.url ?? (s.label ? s.lastUrl : null),
        label: s.label,
        network: s.network,
        muted: Boolean(s.muted),
        volume: s.volume ?? 1.0,
        health: s.health || 'ok',
        gameId: s.gameId ?? s.lastGame?.id,
        lastUrl: s.lastUrl,
        lastLabel: s.lastLabel,
        lastNetwork: s.lastNetwork,
        lastGame: s.lastGame ? JSON.parse(JSON.stringify(s.lastGame)) : null
      }))
    };
  }

  function recordAction(type, description, beforeSnapshot) {
    const afterSnapshot = snapshotWallState();
    const entry = {
      id: 'act-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      type,
      description,
      timestamp: Date.now(),
      before: beforeSnapshot,
      after: afterSnapshot
    };
    state.actionHistory.unshift(entry);
    if (state.actionHistory.length > 40) state.actionHistory.length = 40;
    localStorage.setItem('gamewall_action_history', JSON.stringify(state.actionHistory));
    updateHistoryUI();
    showToast(description, '', false, 8000, () => undoAction(entry.id));
  }

  function undoAction(actionId) {
    const index = actionId ? state.actionHistory.findIndex(a => a.id === actionId) : 0;
    if (index < 0 || !state.actionHistory[index]) return;
    const item = state.actionHistory[index];
    state.actionHistory.splice(index, 1);
    localStorage.setItem('gamewall_action_history', JSON.stringify(state.actionHistory));
    updateHistoryUI();

    if (item.before) {
      state.layout = item.before.layout || '4';
      state.customLayoutRects = item.before.customLayoutRects;
      state.slots = item.before.slots.map(s => ({
        label: s.label,
        network: s.network,
        muted: Boolean(s.muted),
        volume: s.volume ?? 1.0,
        health: s.health || 'ok',
        gameId: s.gameId,
        lastUrl: s.lastUrl,
        lastLabel: s.lastLabel,
        lastNetwork: s.lastNetwork,
        lastGame: s.lastGame
      }));

      sendCommand({
        action: 'restoreSnapshot',
        snapshot: {
          type: 'wallState',
          layout: item.before.layout,
          customRects: item.before.customLayoutRects,
          slots: item.before.slots
        }
      });

      [...el.layoutPicker.children].forEach(b => b.classList.toggle('active', b.dataset.layout === state.layout));
      if (el.customLayoutBtn) el.customLayoutBtn.classList.toggle('active', state.layout === 'custom');

      renderSlots();
      showToast(`Reverted: ${item.description}`, 'Previous state restored on GameWall.', true);
    }
  }

  function updateHistoryUI() {
    notifyChange();
    if (el.historyBadge) {
      el.historyBadge.textContent = String(state.actionHistory.length);
    }
    if (el.undoLatestBtn) {
      el.undoLatestBtn.disabled = state.actionHistory.length === 0;
    }
    if (el.historyList && el.historyModal && !el.historyModal.hidden) {
      renderHistoryList();
    }
  }

  function renderHistoryList() {
    if (!el.historyList) return;
    el.historyList.innerHTML = '';
    if (!state.actionHistory.length) {
      el.historyList.innerHTML = '<p class="schedule-empty">No recorded actions yet.</p>';
      return;
    }

    state.actionHistory.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'history-item' + (idx === 0 ? ' latest' : '');

      const meta = document.createElement('div');
      meta.className = 'history-item-meta';
      const time = new Date(item.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      meta.innerHTML = `<span class="history-item-time">${time}</span><span class="history-item-desc">${item.description}</span>`;

      const undoBtn = document.createElement('button');
      undoBtn.className = 'history-undo-btn';
      undoBtn.type = 'button';
      undoBtn.textContent = 'Undo';
      undoBtn.addEventListener('click', () => {
        undoAction(item.id);
        renderHistoryList();
      });

      card.append(meta, undoBtn);
      el.historyList.appendChild(card);
    });
  }

  function openHistoryModal() {
    renderHistoryList();
    if (el.historyModal) el.historyModal.hidden = false;
  }

  function closeHistoryModal() {
    if (el.historyModal) el.historyModal.hidden = true;
  }

  if (el.historyBtn) el.historyBtn.addEventListener('click', openHistoryModal);
  if (el.historyCloseBtn) el.historyCloseBtn.addEventListener('click', closeHistoryModal);
  if (el.undoLatestBtn) el.undoLatestBtn.addEventListener('click', () => { undoAction(); renderHistoryList(); });
  if (el.clearHistoryBtn) {
    el.clearHistoryBtn.addEventListener('click', () => {
      state.actionHistory = [];
      localStorage.setItem('gamewall_action_history', JSON.stringify([]));
      updateHistoryUI();
      renderHistoryList();
    });
  }

  function renderPinnedTeamsTags() {
    if (!el.pinnedTeamsTags) return;
    el.pinnedTeamsTags.innerHTML = '';
    for (const team of state.pinnedTeams) {
      const tag = document.createElement('span');
      tag.className = 'pinned-tag';
      tag.textContent = team;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'pinned-tag-remove';
      removeBtn.type = 'button';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = `Unpin ${team}`;
      removeBtn.addEventListener('click', () => togglePinTeam(team));
      tag.appendChild(removeBtn);
      el.pinnedTeamsTags.appendChild(tag);
    }
  }

  function togglePinTeam(teamName) {
    if (!teamName) return;
    const clean = teamName.trim();
    const existingIndex = state.pinnedTeams.findIndex(t => t.toLowerCase() === clean.toLowerCase());
    if (existingIndex >= 0) {
      state.pinnedTeams.splice(existingIndex, 1);
    } else {
      state.pinnedTeams.push(clean);
    }
    localStorage.setItem('gamewall_pinned_teams', JSON.stringify(state.pinnedTeams));
    el.pinnedTeamsInput.value = state.pinnedTeams.join(', ');
    renderPinnedTeamsTags();
    renderSchedule();
    renderTicker();
  }

  function updateTeamSuggestions() {
    if (!el.teamSuggestions) return;
    const names = new Set();
    for (const game of state.schedule) {
      for (const t of gameTeams(game)) {
        if (t && t.length > 1) names.add(t);
      }
    }
    el.teamSuggestions.innerHTML = '';
    for (const name of [...names].sort()) {
      const opt = document.createElement('option');
      opt.value = name;
      el.teamSuggestions.appendChild(opt);
    }
  }

  el.pinnedTeamsInput.value = state.pinnedTeams.join(', ');
  el.pinnedTeamsSave.addEventListener('click', () => {
    state.pinnedTeams = el.pinnedTeamsInput.value.split(',').map(team => team.trim()).filter(Boolean);
    localStorage.setItem('gamewall_pinned_teams', JSON.stringify(state.pinnedTeams));
    renderPinnedTeamsTags();
    renderSchedule();
    renderTicker();
  });
  renderPinnedTeamsTags();

  function rankGame(game) {
    let score = 0;
    if (isPinnedGame(game)) score += 300;
    if (game.state === 'in') {
      score += 100;
      if (!game.isRace && Number.isInteger(game.homeScore) && Number.isInteger(game.awayScore)) {
        const diff = Math.abs(game.homeScore - game.awayScore);
        if (diff <= 8) score += 50;
        else if (diff <= 14) score += 25;
      }
    } else if (game.state === 'pre') {
      if (game.kickoff) {
        const diffMinutes = (new Date(game.kickoff) - Date.now()) / (1000 * 60);
        if (diffMinutes >= 0 && diffMinutes <= 30) score += 60;
        else if (diffMinutes > 30 && diffMinutes <= 120) score += 30;
      }
    }
    return score;
  }

  function autoFillSlots() {
    const before = snapshotWallState();
    const visibleCount = state.layout === 'custom'
      ? (state.customLayoutRects?.length ?? 4)
      : (LAYOUT_VISIBLE_COUNT[state.layout] ?? 4);
    const assignedIds = new Set(state.slots.map(s => s.lastGame?.id).filter(Boolean));

    const candidates = [...state.customGames, ...state.schedule]
      .filter(g => !assignedIds.has(g.id))
      .sort((a, b) => rankGame(b) - rankGame(a));

    let placedCount = 0;
    // Phase 1: Try placing candidates into their remembered usual slots if that slot is empty and visible
    for (let cIdx = candidates.length - 1; cIdx >= 0; cIdx--) {
      const game = candidates[cIdx];
      const usual = findUsualSlot(game);
      if (usual !== null && usual < visibleCount && !state.slots[usual].label) {
        assignGameToSlot(game, usual, false);
        assignedIds.add(game.id);
        candidates.splice(cIdx, 1);
        placedCount++;
      }
    }

    // Phase 2: Fill remaining empty visible slots with top available games
    let candidateIndex = 0;
    for (let i = 0; i < visibleCount; i++) {
      if (state.slots[i].label) continue;
      if (candidateIndex >= candidates.length) break;

      const nextGame = candidates[candidateIndex++];
      assignGameToSlot(nextGame, i, false);
      assignedIds.add(nextGame.id);
      placedCount++;
    }

    if (placedCount > 0) {
      recordAction('autoFill', `Auto-Filled ${placedCount} screen${placedCount === 1 ? '' : 's'} with top live games`, before);
    }
  }

  if (el.autoFillBtn) {
    el.autoFillBtn.addEventListener('click', autoFillSlots);
  }

  function gameTeams(game) {
    return [game.homeTeam, game.awayTeam].filter(Boolean);
  }

  function findUsualSlot(game) {
    const slots = gameTeams(game).map(team => state.lastScreenByTeam[team]).filter(Number.isInteger);
    return slots.length ? slots[0] : null;
  }

  function isPinnedGame(game) {
    return gameTeams(game).some(team => state.pinnedTeams.some(pinned =>
      team.toLowerCase().includes(pinned.toLowerCase())));
  }

  function showPinnedAlert(message) {
    el.scheduleWarning.hidden = false;
    el.scheduleWarning.textContent = message;
    clearTimeout(showPinnedAlert.timer);
    showPinnedAlert.timer = setTimeout(() => {
      el.scheduleWarning.hidden = true;
      showPinnedAlert.timer = null;
    }, 8000);
  }

  function comparePinnedSchedule(previous, current) {
    const before = new Map(previous.filter(isPinnedGame).map(game => [game.id, `${game.state}|${game.statusDetail}`]));
    for (const game of current.filter(isPinnedGame)) {
      const next = `${game.state}|${game.statusDetail}`;
      if (before.has(game.id) && before.get(game.id) !== next)
        showPinnedAlert(`${game.awayTeam} @ ${game.homeTeam}: ${game.statusDetail || game.state}`);
    }
  }

  function loadPresets() {
    try {
      const value = JSON.parse(localStorage.getItem('gamewall_presets') || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) { return {}; }
  }

  function snapshotSlots() {
    return state.slots.map(slot => ({
      label: slot.label, network: slot.network, muted: slot.muted,
      lastUrl: slot.lastUrl, lastLabel: slot.lastLabel,
      lastNetwork: slot.lastNetwork, lastGame: slot.lastGame,
    }));
  }

  function renderPresetPicker() {
    el.presetPicker.innerHTML = '<option value="">Presets</option>';
    for (const name of Object.keys(state.presets).sort()) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      el.presetPicker.appendChild(option);
    }
    el.applyPresetBtn.disabled = !el.presetPicker.value;
  }

  function restorePreset(name) {
    const snapshot = state.presets[name];
    if (!Array.isArray(snapshot)) return;
    const before = snapshotWallState();
    state.slots = snapshot.map(slot => ({
      label: slot.label ?? null, network: slot.network ?? null,
      muted: Boolean(slot.muted), lastUrl: slot.lastUrl ?? null,
      lastLabel: slot.lastLabel ?? null, lastNetwork: slot.lastNetwork ?? null,
      lastGame: slot.lastGame ?? null,
    }));
    state.slots.forEach((slot, index) => {
      if (slot.label && slot.lastUrl) {
        sendCommand({
          action: 'navigate',
          slot: index,
          url: slot.lastUrl,
          label: slot.label,
          network: slot.network,
          lastGameJson: slot.lastGame ? JSON.stringify(slot.lastGame) : null
        });
        sendCommand({ action: 'mute', slot: index, muted: slot.muted });
      } else {
        sendCommand({ action: 'close', slot: index });
      }
    });
    renderSlots();
    recordAction('preset', `Restored preset "${name}"`, before);
  }

  el.presetPicker.addEventListener('change', () => {
    el.applyPresetBtn.disabled = !el.presetPicker.value;
  });
  el.savePresetBtn.addEventListener('click', () => {
    const name = window.prompt('Name this layout');
    if (!name?.trim()) return;
    state.presets[name.trim()] = snapshotSlots();
    localStorage.setItem('gamewall_presets', JSON.stringify(state.presets));
    renderPresetPicker();
    el.presetPicker.value = name.trim();
    el.applyPresetBtn.disabled = false;
  });
  el.applyPresetBtn.addEventListener('click', () => restorePreset(el.presetPicker.value));

  function applyTheme(theme) {
    document.body.classList.toggle('theme-light', theme === 'light');
    el.themeToggleBtn.textContent = theme === 'light' ? 'Dark theme' : 'Light theme';
    localStorage.setItem('gamewall_theme', theme);
  }
  el.themeToggleBtn.addEventListener('click', () => {
    applyTheme(document.body.classList.contains('theme-light') ? 'dark' : 'light');
  });
  applyTheme(localStorage.getItem('gamewall_theme') || 'dark');
  renderPresetPicker();

  function loadSubscriptions() {
    try {
      const value = JSON.parse(localStorage.getItem('gamewall_subscriptions') || 'null');
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }

  function pickWatchUrl(networkName, userServiceIds, networksData, fallbackUrl) {
    if (state.customServices && networkName) {
      for (const [id, cs] of Object.entries(state.customServices)) {
        if (userServiceIds.includes(id) && cs.label.toLowerCase().includes(networkName.toLowerCase())) {
          return cs.defaultUrl || cs.loginUrl;
        }
      }
    }
    if (!networksData) return fallbackUrl;
    const entry = networksData.networks?.[networkName];
    if (entry) {
      for (const serviceId of networksData.priority || []) {
        if (userServiceIds.includes(serviceId) && entry[serviceId]) return entry[serviceId];
      }
      for (const serviceId of userServiceIds) {
        if (entry[serviceId]) return entry[serviceId];
      }
    }
    for (const serviceId of networksData.priority || []) {
      if (userServiceIds.includes(serviceId)) {
        const url = networksData.services?.[serviceId]?.defaultUrl;
        if (url) return url;
      }
    }
    return networksData.default || fallbackUrl;
  }

  function renderSubscriptionOptions() {
    const services = {
      ...(state.networksData?.services || {}),
      ...(state.customServices || {})
    };
    if (!Object.keys(services).length) {
      el.subscriptionsList.innerHTML = '<p>Loading services...</p>';
      return;
    }
    el.subscriptionsList.innerHTML = '';
    for (const [id, service] of Object.entries(services)) {
      const card = document.createElement('div');
      card.className = 'subscription-card';

      const left = document.createElement('div');
      left.className = 'subscription-card-left';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = id;
      checkbox.checked = state.subscriptions.includes(id);
      checkbox.id = `sub-${id}`;

      checkbox.addEventListener('change', () => {
        if (checkbox.checked && !state.signedInServices.includes(id)) {
          showToast(
            'Authentication Recommended',
            `You enabled ${service.label || id}. If you haven't signed into this service on your wall yet, click "Log in on Wall (Screen 1)" to log in once for all screens.`
          );
        }
      });

      const label = document.createElement('label');
      label.htmlFor = `sub-${id}`;
      label.className = 'subscription-title';
      label.textContent = service.label || id;
      left.append(checkbox, label);

      const right = document.createElement('div');
      right.className = 'subscription-card-right';

      const isSignedIn = state.signedInServices.includes(id);
      const authPill = document.createElement('span');
      authPill.className = `auth-pill ${isSignedIn ? 'auth-pill--signed-in' : 'auth-pill--not-signed-in'}`;
      authPill.textContent = isSignedIn ? '✓ Signed in' : 'Not signed in';

      const wallLoginBtn = document.createElement('button');
      wallLoginBtn.className = 'btn-auth-wall';
      wallLoginBtn.type = 'button';
      wallLoginBtn.textContent = 'Log in on Wall (Screen 1)';
      wallLoginBtn.title = `Bring up ${service.label || id} login page on Screen 1 of your GameWall`;
      wallLoginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        loginServiceOnWall(id, service);
      });

      const loginUrl = service.loginUrl || service.defaultUrl;
      const tabLink = document.createElement('a');
      tabLink.className = 'btn-auth-tab';
      tabLink.href = loginUrl;
      tabLink.target = '_blank';
      tabLink.rel = 'noopener noreferrer';
      tabLink.textContent = 'Open login ↗';
      tabLink.title = `Open ${service.label || id} login in a new browser tab`;

      const toggleAuthBtn = document.createElement('button');
      toggleAuthBtn.className = 'btn-auth-toggle';
      toggleAuthBtn.type = 'button';
      toggleAuthBtn.textContent = isSignedIn ? 'Mark unauthenticated' : 'Mark signed in';
      toggleAuthBtn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleServiceSignedIn(id);
      });

      right.append(authPill, wallLoginBtn, tabLink, toggleAuthBtn);
      card.append(left, right);
      el.subscriptionsList.appendChild(card);
    }
  }

  function loginServiceOnWall(serviceId, service) {
    const loginUrl = service.loginUrl || service.defaultUrl;
    if (!loginUrl) return;

    // Switch wall to 1-Up so the user has full screen to enter credentials on Screen 1
    state.layout = '1';
    [...el.layoutPicker.children].forEach(b => b.classList.toggle('active', b.dataset.layout === '1'));
    if (el.customLayoutBtn) el.customLayoutBtn.classList.remove('active');
    sendCommand({ action: 'layout', layout: '1' });

    // Navigate slot 0
    state.slots[0].label = `${service.label || serviceId} Login`;
    state.slots[0].network = service.label || serviceId;
    state.slots[0].lastUrl = loginUrl;
    sendCommand({ action: 'navigate', slot: 0, url: loginUrl });
    renderSlots();

    // Mark as signed in and subscribed
    if (!state.signedInServices.includes(serviceId)) {
      state.signedInServices.push(serviceId);
      localStorage.setItem('gamewall_signed_in_services', JSON.stringify(state.signedInServices));
    }
    if (!state.subscriptions.includes(serviceId)) {
      state.subscriptions.push(serviceId);
      localStorage.setItem('gamewall_subscriptions', JSON.stringify(state.subscriptions));
    }
    renderSubscriptionOptions();

    showToast(
      'Wall Login Started',
      `Screen 1 set to ${service.label || serviceId} login. Log in once on your display PC and all 8 screens are authenticated!`,
      true,
      9000
    );
  }

  function toggleServiceSignedIn(serviceId) {
    const idx = state.signedInServices.indexOf(serviceId);
    if (idx >= 0) state.signedInServices.splice(idx, 1);
    else state.signedInServices.push(serviceId);
    localStorage.setItem('gamewall_signed_in_services', JSON.stringify(state.signedInServices));
    renderSubscriptionOptions();
  }

  if (el.addCustomServiceBtn) {
    el.addCustomServiceBtn.addEventListener('click', () => {
      const name = (el.customServiceName?.value || '').trim();
      const login = (el.customServiceLogin?.value || '').trim();
      const watch = (el.customServiceWatch?.value || '').trim();
      if (!name) return;
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      state.customServices[id] = {
        label: name,
        loginUrl: login || watch,
        defaultUrl: watch || login,
      };
      localStorage.setItem('gamewall_custom_services', JSON.stringify(state.customServices));
      if (el.customServiceName) el.customServiceName.value = '';
      if (el.customServiceLogin) el.customServiceLogin.value = '';
      if (el.customServiceWatch) el.customServiceWatch.value = '';
      renderSubscriptionOptions();
      showToast('Custom Service Added', `Added ${name} to your streaming options.`);
    });
  }

  function openSubscriptionsModal() {
    renderSubscriptionOptions();
    el.subscriptionsError.hidden = true;
    el.subscriptionsModal.hidden = false;
  }

  function closeSubscriptionsModal() {
    el.subscriptionsModal.hidden = true;
  }

  function saveSubscriptions(serviceIds) {
    state.subscriptions = serviceIds;
    localStorage.setItem('gamewall_subscriptions', JSON.stringify(serviceIds));
    closeSubscriptionsModal();
    renderSchedule();
    for (const slot of state.slots) {
      if (!slot.lastGame || slot.lastGame.custom) continue;
      const url = pickWatchUrl(slot.lastGame.network, state.subscriptions, state.networksData, slot.lastGame.watchUrl);
      slot.lastUrl = url;
      if (slot.label) sendCommand({ action: 'navigate', slot: state.slots.indexOf(slot), url });
    }
    renderSlots();
  }

  el.subscriptionsBtn.addEventListener('click', openSubscriptionsModal);
  el.subscriptionsCloseBtn.addEventListener('click', closeSubscriptionsModal);
  el.subscriptionsSkipBtn.addEventListener('click', () => saveSubscriptions([]));
  el.subscriptionsSaveBtn.addEventListener('click', () => {
    const selected = [...el.subscriptionsList.querySelectorAll('input:checked')].map(input => input.value);
    saveSubscriptions(selected);
  });

  async function loadNetworks() {
    try {
      const res = await fetch(`${API_BASE}/networks`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.networksData = await res.json();
      renderSubscriptionOptions();
    } catch (err) {
      el.subscriptionsError.hidden = false;
      el.subscriptionsError.textContent = 'Could not load subscription services. The generic schedule links will still work.';
    }
    // Phones show a gentle "pick your services" card instead of a pop-up.
    if (localStorage.getItem('gamewall_subscriptions') === null && !document.documentElement.classList.contains('m-ui-early')) openSubscriptionsModal();
  }

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
    if (CLOUD) { connectCloud(); return; }
    if (!state.pcIp) return;
    if (state.ws) { try { state.ws.close(); } catch (_) {} }

    state.pcIp = normalizeHost(state.pcIp);
    el.pcIpInput.value = state.pcIp;
    const ws = new WebSocket(`ws://${state.pcIp}:${DISPLAY_HOST_PORT}/`);
    state.ws = ws;
    clearTimeout(state.wsConnectTimer);
    state.wsConnectTimer = setTimeout(() => {
      if (state.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, 5000);

    ws.onopen = () => {
      clearTimeout(state.wsConnectTimer);
      state.wsConnected = true;
      state.connectAttempts = 0;
      el.connState.textContent = 'connected';
      el.connState.className = 'conn-state conn-state--on';
      sendCommand({ action: 'hello', name: localStorage.getItem('gamewall_device_name') || 'Unnamed remote' });
      sendCommand({ action: 'displays' });
    };
    ws.onmessage = (event) => {
      try {
        handleIncoming(JSON.parse(event.data));
      } catch (_) {}
    };

  // Every message from the Display Host, whether it came over the LAN socket or
  // through the cloud relay, lands here.
  function handleIncoming(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'wallState') {
      handleWallStateBroadcast(message);
    }
    if (message.type === 'displays') updateMonitors(message);
    if (message.type === 'clients') {
      state.clients = message.names || [];
      el.clientsStatus.textContent = state.clients.length
        ? `${state.clients.length} remote${state.clients.length === 1 ? '' : 's'} connected: ${state.clients.join(', ')}`
        : '';
    }
    if (message.type === 'slotHealth' && Number.isInteger(message.slot)) {
      state.health[message.slot] = message.status || 'ok';
      renderSlots();
    }
  }

  function connectCloud() {
    CLOUD.connect({
      onOpen: () => {
        state.wsConnected = true;
        state.connectAttempts = 0;
        el.connState.textContent = 'connected';
        el.connState.className = 'conn-state conn-state--on';
        sendCommand({ action: 'hello', name: localStorage.getItem('gamewall_device_name') || 'Unnamed remote' });
        sendCommand({ action: 'displays' });
      },
      onMessage: handleIncoming,
      onClose: () => {
        state.wsConnected = false;
        el.connState.textContent = 'not connected';
        el.connState.className = 'conn-state conn-state--off';
      },
    });
  }

  function handleWallStateBroadcast(wsState) {
    if (!wsState) return;
    state.wallStateRevision = wsState.revision || state.wallStateRevision;

    // Sync layout
    if (wsState.layout) {
      state.layout = wsState.layout;
      if (wsState.layout === 'custom' && Array.isArray(wsState.customRects) && wsState.customRects.length) {
        state.customLayoutRects = wsState.customRects;
      }
      [...el.layoutPicker.children].forEach(b => b.classList.toggle('active', b.dataset.layout === state.layout));
      if (el.customLayoutBtn) el.customLayoutBtn.classList.toggle('active', state.layout === 'custom');
    }

    // Sync clients
    if (Array.isArray(wsState.clients)) {
      state.clients = wsState.clients;
      el.clientsStatus.textContent = state.clients.length
        ? `${state.clients.length} remote${state.clients.length === 1 ? '' : 's'} connected: ${state.clients.join(', ')}`
        : '';
    }

    // Sync slots
    if (Array.isArray(wsState.slots)) {
      wsState.slots.forEach(s => {
        if (s.index >= 0 && s.index < SLOT_COUNT) {
          const slot = state.slots[s.index];
          slot.url = s.url;
          slot.label = s.label;
          slot.network = s.network;
          slot.muted = Boolean(s.muted);
          slot.volume = s.volume ?? 1.0;
          slot.health = s.health || 'ok';
          state.health[s.index] = s.health || 'ok';
          if (s.gameId) slot.gameId = s.gameId;
          if (s.lastUrl) slot.lastUrl = s.lastUrl;
          if (s.lastLabel) slot.lastLabel = s.lastLabel;
          if (s.lastNetwork) slot.lastNetwork = s.lastNetwork;
          if (s.lastGameJson) {
            try { slot.lastGame = JSON.parse(s.lastGameJson); } catch (_) {}
          }
        }
      });
    }

    renderSlots();
  }
    ws.onclose = () => {
      clearTimeout(state.wsConnectTimer);
      if (state.ws === ws) state.ws = null;
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
      const delay = Math.min(30000, 1000 * 2 ** Math.min(state.connectAttempts - 1, 5));
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connectWebSocket, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function sendCommand(cmd) {
    if (CLOUD) {
      CLOUD.send(cmd);
      return;
    }
    if (state.ws && state.wsConnected) {
      state.ws.send(JSON.stringify(cmd));
    }
  }

  function updateMonitors(message) {
    state.monitors = message.displays || [];
    state.selectedMonitor = message.selectedIndex ?? 0;
    notifyChange();
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
    if (state.layout === btn.dataset.layout) return;
    const before = snapshotWallState();
    state.layout = btn.dataset.layout;
    [...el.layoutPicker.children].forEach(b => b.classList.toggle('active', b === btn));
    if (el.customLayoutBtn) el.customLayoutBtn.classList.remove('active');
    sendCommand({ action: 'layout', layout: state.layout });
    renderSlots();
    recordAction('layout', `Switched layout to ${btn.textContent.trim() || state.layout}`, before);
  });

  el.testModeBtn.addEventListener('click', () => {
    state.layout = '8';
    [...el.layoutPicker.children].forEach(b => b.classList.toggle('active', b.dataset.layout === '8'));
    sendCommand({ action: 'test' });
    renderSlots();
  });

  // End session: clear every screen, hide the wall and let the laptop sleep again.
  const endSessionBtn = document.getElementById('endSessionBtn');
  if (endSessionBtn) {
    endSessionBtn.addEventListener('click', () => {
      if (!confirm('End the session? This clears every screen and hides the wall.')) return;
      sendCommand({ action: 'endSession' });
      showToast('Session ended', 'The wall is hidden until you start it again.', false, 4000);
    });
  }

  el.closeAllBtn.addEventListener('click', () => {
    const before = snapshotWallState();
    sendCommand({ action: 'closeAll' });
    state.slots.forEach(s => { s.label = null; s.network = null; });
    renderSlots();
    recordAction('closeAll', 'Closed all screens', before);
  });

  // ---------------- Schedule (sidebar) ----------------

  async function loadSchedule() {
    try {
      const res = await fetch(`${API_BASE}/schedule`);
      const data = await res.json();
      const previousSchedule = state.schedule;
      state.schedule = data.games || [];
      comparePinnedSchedule(previousSchedule, state.schedule);
      updateTeamSuggestions();

      if (data.sourceOk === false) {
        el.scheduleWarning.hidden = false;
        el.scheduleWarning.textContent =
          `ESPN schedule unavailable: ${data.error || 'unknown server error'}. ` +
          'Use "Add a game manually" below in the meantime.';
      } else {
        if (!showPinnedAlert.timer) el.scheduleWarning.hidden = true;
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
    notifyChange();
    const combined = [
      ...state.customGames,
      ...state.schedule,
    ];

    if (!combined.length) {
      el.scheduleList.innerHTML = '<p class="schedule-empty">No games this week or next.</p>';
      return;
    }

    el.scheduleList.innerHTML = '';
    for (const game of combined) {
      const pinned = isPinnedGame(game);
      const card = document.createElement('div');
      card.className = 'game-card' + (game.custom ? ' custom-game' : '') + (pinned ? ' pinned-card' : '');
      card.draggable = true;
      card.dataset.gameId = game.id;

      const teams = document.createElement('div');
      teams.className = 'game-card-teams';
      if (game.custom || game.isRace) {
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

      if (!game.custom) {
        const statsBtn = document.createElement('button');
        statsBtn.className = 'btn-stats-panel';
        statsBtn.type = 'button';
        statsBtn.title = 'Display live Win Probability & Weather stats panel on a screen';
        statsBtn.textContent = '📊 Stats';
        statsBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const visibleCount = state.layout === 'custom'
            ? (state.customLayoutRects?.length ?? 4)
            : (LAYOUT_VISIBLE_COUNT[state.layout] ?? 4);
          let target = -1;
          for (let s = 0; s < visibleCount; s++) {
            if (!state.slots[s].label) { target = s; break; }
          }
          if (target < 0) target = 0;
          openStatsPanelForGame(game, target);
        });

        const pinBtn = document.createElement('button');
        pinBtn.className = 'pin-btn' + (pinned ? ' pinned' : '');
        pinBtn.type = 'button';
        pinBtn.title = pinned ? 'Unpin favorite' : 'Pin team as favorite';
        pinBtn.innerHTML = pinned ? '&#9733;' : '&#9734;';
        pinBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const target = game.homeTeam || game.awayTeam;
          togglePinTeam(target);
        });
        teams.append(statsBtn, pinBtn);
      }

      const meta = document.createElement('div');
      meta.className = 'game-card-meta';

      const left = document.createElement('span');
      if (game.custom) {
        left.textContent = 'Custom';
      } else if (game.state === 'in' && !game.isRace) {
        left.className = 'live';
        left.textContent = `${game.awayScore ?? 0}-${game.homeScore ?? 0} \u00b7 ${game.statusDetail}`;
      } else if (game.state === 'post') {
        left.textContent = game.isRace ? `Final \u00b7 ${game.statusDetail}` : `Final ${game.awayScore ?? 0}-${game.homeScore ?? 0}`;
      } else if (game.state === 'in' && game.isRace) {
        left.className = 'live';
        left.textContent = game.statusDetail || 'Live race';
      } else {
        left.textContent = formatKickoff(game.kickoff);
      }
      meta.appendChild(left);

      if (pinned) {
        const pinnedBadge = document.createElement('span');
        pinnedBadge.className = 'pinned-badge';
        pinnedBadge.textContent = '\u2605 Pinned';
        meta.appendChild(pinnedBadge);
      }

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

      const usualSlot = game.custom ? null : findUsualSlot(game);
      if (usualSlot !== null) {
        const hint = document.createElement('div');
        hint.className = 'game-card-hint';
        hint.textContent = `Usually Screen ${usualSlot + 1}`;
        if (!state.slots[usualSlot].label) {
          const placeBtn = document.createElement('button');
          placeBtn.className = 'place-usual-btn';
          placeBtn.type = 'button';
          placeBtn.textContent = `Place on Screen ${usualSlot + 1}`;
          placeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            assignGameToSlot(game, usualSlot);
            state.selectedGame = null;
            [...el.scheduleList.children].forEach(c => c.classList.remove('selected'));
            updatePreferredSlotHighlights(null);
          });
          hint.appendChild(placeBtn);
        }
        card.appendChild(hint);
      }

      card.addEventListener('click', () => selectGame(game, card));
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify(game));
      });

      el.scheduleList.appendChild(card);
    }
  }

  function updatePreferredSlotHighlights(game) {
    const usual = game ? findUsualSlot(game) : null;
    document.querySelectorAll('.slot-card').forEach((slotEl) => {
      const slotIndex = Number(slotEl.dataset.slot);
      slotEl.classList.toggle('slot-preferred', usual !== null && slotIndex === usual);
    });
  }

  function selectGame(game, cardEl) {
    const alreadySelected = state.selectedGame && state.selectedGame.id === game.id;
    [...el.scheduleList.children].forEach(c => c.classList.remove('selected'));
    if (alreadySelected) {
      state.selectedGame = null;
      updatePreferredSlotHighlights(null);
    } else {
      state.selectedGame = game;
      cardEl.classList.add('selected');
      updatePreferredSlotHighlights(game);
      // On a phone the screens sit above the game list: bring them into view so
      // "tap a game, then tap a screen" doesn't need a manual scroll.
      if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches && el.slotGrid) {
        el.slotGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  // ---------------- Slot grid & Lifecycle (§7.3) ----------------

  function closeSlot(slotIndex) {
    const before = snapshotWallState();
    const slot = state.slots[slotIndex];
    const oldLabel = slot.label || `Screen ${slotIndex + 1}`;
    slot.label = null;
    slot.network = null;
    sendCommand({ action: 'close', slot: slotIndex });
    renderSlots();
    recordAction('slotClose', `Closed ${oldLabel}`, before);
  }

  function clearSlot(slotIndex, isAuto = false) {
    const before = snapshotWallState();
    const slot = state.slots[slotIndex];
    const oldLabel = slot.lastLabel || slot.label || `Screen ${slotIndex + 1}`;
    slot.label = null;
    slot.network = null;
    slot.lastUrl = null;
    slot.lastLabel = null;
    slot.lastNetwork = null;
    slot.lastGame = null;
    slot.gameId = null;
    sendCommand({ action: 'clear', slot: slotIndex });
    renderSlots();
    if (!isAuto) {
      recordAction('slotClear', `Cleared memory for ${oldLabel}`, before);
    }
  }

  function openStatsPanelForGame(game, targetSlot) {
    const before = snapshotWallState();
    const slot = state.slots[targetSlot];
    const label = `📊 ${game.awayTeam ? `${game.awayTeam} @ ` : ''}${game.homeTeam} Stats`;
    const hostIp = state.pcIp || pageHost;
    const panelQuery = `gameId=${encodeURIComponent(game.id)}&sport=${encodeURIComponent(game.sport || 'football')}`;
    const panelUrl = ON_WALL_PATH
      ? `${window.location.origin}/wall/panel.html?${panelQuery}`
      : `http://${hostIp}:5050/panel.html?${panelQuery}`;
    slot.label = label;
    slot.network = 'GameWall Stats';
    slot.muted = true;
    slot.lastUrl = panelUrl;
    slot.lastLabel = label;
    slot.lastNetwork = 'GameWall Stats';
    slot.lastGame = game;
    slot.gameId = game.id;

    sendCommand({
      action: 'navigate',
      slot: targetSlot,
      url: panelUrl,
      label,
      network: 'GameWall Stats',
      gameId: game.id,
      lastGameJson: JSON.stringify(game)
    });
    sendCommand({ action: 'mute', slot: targetSlot, muted: true });
    renderSlots();
    recordAction('statsPanel', `Placed ${game.homeTeam} Stats Panel on Screen ${targetSlot + 1}`, before);
  }

  // The phone screen (mobile.js) redraws itself whenever the remote's state changes.
  let notifyQueued = false;
  function notifyChange() {
    if (notifyQueued) return;
    notifyQueued = true;
    requestAnimationFrame(() => {
      notifyQueued = false;
      const api = window.GameWallApp;
      if (api && typeof api.onChange === 'function') {
        try { api.onChange(); } catch (err) { console.error(err); }
      }
    });
  }

  function renderSlots() {
    notifyChange();
    const visibleCount = state.layout === 'custom'
      ? (state.customLayoutRects?.length ?? 4)
      : (LAYOUT_VISIBLE_COUNT[state.layout] ?? 4);
    el.slotGrid.innerHTML = '';

    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = state.slots[i];
      const card = document.createElement('div');
      card.className = 'slot-card' + (i >= visibleCount ? ' hidden-slot' : '');
      card.dataset.slot = String(i);

      const head = document.createElement('div');
      head.className = 'slot-card-head';
      const health = document.createElement('span');
      health.className = `slot-health slot-health--${state.health[i] || 'ok'}`;
      health.title = state.health[i] === 'recovered' ? 'Recovered automatically' : 'Healthy';
      const indexLabel = document.createElement('span');
      indexLabel.className = 'slot-index';
      indexLabel.textContent = `Screen ${i + 1}`;
      const network = document.createElement('span');
      network.className = 'slot-network';
      network.textContent = slot.network ?? '';
      head.append(indexLabel, health, network);

      const content = document.createElement('div');
      content.className = 'slot-content' + (slot.label ? '' : ' empty');
      if (slot.label) {
        content.textContent = slot.label;
      } else {
        content.textContent = 'Empty \u2014 tap a game, then tap here';
        const upcoming = state.schedule
          .filter(game => game.kickoff && new Date(game.kickoff) > new Date() && game.state === 'pre')
          .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
          .slice(0, 2);
        for (const game of upcoming) {
          const item = document.createElement('small');
          item.className = 'empty-upcoming';
          item.textContent = `${formatKickoff(game.kickoff)}  ${game.awayTeam} @ ${game.homeTeam}`;
          content.append(document.createElement('br'), item);
        }
      }

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
      volume.value = String(Math.round((slot.volume ?? 1.0) * 100));
      volume.addEventListener('input', () => {
        const v = Number(volume.value) / 100;
        slot.volume = v;
        sendCommand({ action: 'volume', slot: i, volume: v });
      });

      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', () => closeSlot(i));

      if (slot.lastUrl) {
        const reopenWrap = document.createElement('div');
        reopenWrap.className = 'reopen-wrapper';

        const reopenBtn = document.createElement('button');
        reopenBtn.className = 'reopen';
        reopenBtn.textContent = 'Reopen';
        reopenBtn.title = `Reopen ${slot.lastLabel || 'stream'}`;
        reopenBtn.addEventListener('click', () => {
          if (!slot.lastUrl) return;
          const before = snapshotWallState();
          slot.label = slot.lastLabel;
          slot.network = slot.lastNetwork;
          slot.muted = false;
          sendCommand({
            action: 'navigate',
            slot: i,
            url: slot.lastUrl,
            label: slot.lastLabel,
            network: slot.lastNetwork,
            lastGameJson: slot.lastGame ? JSON.stringify(slot.lastGame) : null
          });
          sendCommand({ action: 'mute', slot: i, muted: false });
          renderSlots();
          recordAction('reopen', `Reopened ${slot.label} on Screen ${i + 1}`, before);
        });

        const clearBtn = document.createElement('button');
        clearBtn.className = 'reopen-clear-btn';
        clearBtn.innerHTML = '&times;';
        clearBtn.title = `Clear Screen ${i + 1} memory completely`;
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          clearSlot(i);
        });

        reopenWrap.append(reopenBtn, clearBtn);
        controls.append(muteBtn, volume, closeBtn, reopenWrap);
      } else {
        const reopenBtn = document.createElement('button');
        reopenBtn.className = 'reopen';
        reopenBtn.textContent = 'Reopen';
        reopenBtn.disabled = true;
        controls.append(muteBtn, volume, closeBtn, reopenBtn);
      }

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
          const payload = JSON.parse(raw);
          if (payload.type === 'slot') swapSlots(payload.index, i);
          else assignGameToSlot(payload, i);
        } catch (_) {}
      });

      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'slot', index: i }));
      });

      el.slotGrid.appendChild(card);
    }
  }

  function assignGameToSlot(game, slotIndex, recordHistory = true) {
    const before = snapshotWallState();
    const slot = state.slots[slotIndex];
    const label = game.custom ? game.homeTeam : `${game.awayTeam} @ ${game.homeTeam}`;
    const watchUrl = game.custom
      ? game.watchUrl
      : pickWatchUrl(game.network, state.subscriptions, state.networksData, game.watchUrl);
    slot.label = label;
    slot.network = game.network;
    slot.muted = false;
    slot.lastUrl = watchUrl;
    slot.lastLabel = label;
    slot.lastNetwork = game.network;
    slot.lastGame = game;
    slot.gameId = game.id;
    slot.manuallyAssigned = recordHistory;
    for (const team of gameTeams(game)) state.lastScreenByTeam[team] = slotIndex;
    localStorage.setItem('gamewall_last_screen_by_team', JSON.stringify(state.lastScreenByTeam));
    sendCommand({
      action: 'navigate',
      slot: slotIndex,
      url: watchUrl,
      label,
      network: game.network,
      gameId: game.id,
      lastGameJson: JSON.stringify(game)
    });
    sendCommand({ action: 'mute', slot: slotIndex, muted: false });
    updatePreferredSlotHighlights(null);
    renderSlots();
    if (recordHistory) {
      recordAction('slotAssignment', `Placed ${label} on Screen ${slotIndex + 1}`, before);
    }
  }

  function swapSlots(indexA, indexB) {
    if (indexA === indexB || !state.slots[indexA] || !state.slots[indexB]) return;
    const before = snapshotWallState();
    [state.slots[indexA], state.slots[indexB]] = [state.slots[indexB], state.slots[indexA]];
    for (const index of [indexA, indexB]) {
      const slot = state.slots[index];
      if (slot.lastUrl) {
        sendCommand({
          action: 'navigate',
          slot: index,
          url: slot.lastUrl,
          label: slot.lastLabel,
          network: slot.lastNetwork,
          lastGameJson: slot.lastGame ? JSON.stringify(slot.lastGame) : null
        });
      } else {
        sendCommand({ action: 'close', slot: index });
      }
      sendCommand({ action: 'mute', slot: index, muted: slot.muted });
    }
    renderSlots();
    recordAction('swap', `Swapped Screen ${indexA + 1} and Screen ${indexB + 1}`, before);
  }

  // ---------------- Custom Visual Layout Editor ----------------
  let activeEditorSlots = []; // array of { slot: 0..7, x, y, width, height }

  function openLayoutEditor() {
    if (state.layout === 'custom' && state.customLayoutRects && state.customLayoutRects.length) {
      activeEditorSlots = state.customLayoutRects.map((r, i) => ({
        slot: i,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }));
    } else if (PRESET_RECTS[state.layout]) {
      activeEditorSlots = PRESET_RECTS[state.layout].map((r, i) => ({
        slot: i,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }));
    } else {
      activeEditorSlots = PRESET_RECTS['4'].map((r, i) => ({
        slot: i,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }));
    }

    renderCustomPresetsSelect();
    renderMinimap();
    el.layoutEditorModal.hidden = false;
  }

  function closeLayoutEditor() {
    el.layoutEditorModal.hidden = true;
  }

  function renderCustomPresetsSelect() {
    if (!el.customPresetSelect) return;
    el.customPresetSelect.innerHTML = '<option value="">Saved Presets...</option>';
    for (const name of Object.keys(state.customLayoutPresets).sort()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      el.customPresetSelect.appendChild(opt);
    }
    if (el.loadCustomPresetBtn) el.loadCustomPresetBtn.disabled = !el.customPresetSelect.value;
    if (el.deleteCustomPresetBtn) el.deleteCustomPresetBtn.disabled = !el.customPresetSelect.value;
  }

  if (el.customPresetSelect) {
    el.customPresetSelect.addEventListener('change', () => {
      el.loadCustomPresetBtn.disabled = !el.customPresetSelect.value;
      el.deleteCustomPresetBtn.disabled = !el.customPresetSelect.value;
    });
  }

  if (el.loadCustomPresetBtn) {
    el.loadCustomPresetBtn.addEventListener('click', () => {
      const name = el.customPresetSelect.value;
      if (!name || !state.customLayoutPresets[name]) return;
      activeEditorSlots = state.customLayoutPresets[name].map((r, i) => ({
        slot: i,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }));
      renderMinimap();
      showToast('Preset Loaded', `Loaded custom preset "${name}".`);
    });
  }

  if (el.deleteCustomPresetBtn) {
    el.deleteCustomPresetBtn.addEventListener('click', () => {
      const name = el.customPresetSelect.value;
      if (!name) return;
      delete state.customLayoutPresets[name];
      localStorage.setItem('gamewall_custom_layouts', JSON.stringify(state.customLayoutPresets));
      renderCustomPresetsSelect();
      showToast('Preset Deleted', `Deleted preset "${name}".`);
    });
  }

  if (el.saveCustomPresetBtn) {
    el.saveCustomPresetBtn.addEventListener('click', () => {
      const name = (el.customLayoutNameInput?.value || '').trim();
      if (!name) return;
      state.customLayoutPresets[name] = activeEditorSlots.map(s => ({
        x: Math.round(s.x * 1000) / 1000,
        y: Math.round(s.y * 1000) / 1000,
        width: Math.round(s.width * 1000) / 1000,
        height: Math.round(s.height * 1000) / 1000,
      }));
      localStorage.setItem('gamewall_custom_layouts', JSON.stringify(state.customLayoutPresets));
      renderCustomPresetsSelect();
      el.customPresetSelect.value = name;
      el.loadCustomPresetBtn.disabled = false;
      el.deleteCustomPresetBtn.disabled = false;
      showToast('Preset Saved', `Saved custom layout preset "${name}".`);
    });
  }

  function renderMinimap() {
    if (!el.minimapScreen) return;
    el.minimapScreen.innerHTML = '';
    activeEditorSlots.forEach((item, index) => {
      const slotDiv = document.createElement('div');
      slotDiv.className = 'minimap-slot';
      slotDiv.style.left = `${item.x * 100}%`;
      slotDiv.style.top = `${item.y * 100}%`;
      slotDiv.style.width = `${item.width * 100}%`;
      slotDiv.style.height = `${item.height * 100}%`;

      const head = document.createElement('div');
      head.className = 'minimap-slot-head';
      head.innerHTML = `<span>Screen ${item.slot + 1}</span>`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'minimap-slot-remove';
      removeBtn.type = 'button';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = 'Remove screen from layout';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeEditorSlots.splice(index, 1);
        renderMinimap();
      });
      head.appendChild(removeBtn);

      const body = document.createElement('div');
      body.className = 'minimap-slot-body';
      const label = state.slots[item.slot]?.label || 'Empty';
      body.innerHTML = `<div>${label}</div><div class="minimap-slot-dims">${Math.round(item.width * 100)}% × ${Math.round(item.height * 100)}%</div>`;

      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'minimap-slot-resize';
      resizeHandle.title = 'Drag corner to resize';

      slotDiv.append(head, body, resizeHandle);

      // Drag positioning
      let isDragging = false;
      let dragStartX = 0, dragStartY = 0;
      let slotStartX = 0, slotStartY = 0;

      slotDiv.addEventListener('pointerdown', (e) => {
        if (e.target === resizeHandle || e.target === removeBtn) return;
        isDragging = true;
        slotDiv.classList.add('dragging');
        slotDiv.setPointerCapture(e.pointerId);
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        slotStartX = item.x;
        slotStartY = item.y;
        e.stopPropagation();
      });

      slotDiv.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const rect = el.minimapScreen.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const deltaX = (e.clientX - dragStartX) / rect.width;
        const deltaY = (e.clientY - dragStartY) / rect.height;

        let newX = slotStartX + deltaX;
        let newY = slotStartY + deltaY;

        if (el.snapGridToggle && el.snapGridToggle.checked) {
          const snapStep = 0.05;
          newX = Math.round(newX / snapStep) * snapStep;
          newY = Math.round(newY / snapStep) * snapStep;
        }

        newX = Math.max(0, Math.min(1 - item.width, newX));
        newY = Math.max(0, Math.min(1 - item.height, newY));

        item.x = newX;
        item.y = newY;
        slotDiv.style.left = `${newX * 100}%`;
        slotDiv.style.top = `${newY * 100}%`;
      });

      const onPointerUp = (e) => {
        if (isDragging) {
          isDragging = false;
          slotDiv.classList.remove('dragging');
          try { slotDiv.releasePointerCapture(e.pointerId); } catch (_) {}
          renderMinimap();
        }
      };
      slotDiv.addEventListener('pointerup', onPointerUp);
      slotDiv.addEventListener('pointercancel', onPointerUp);

      // Corner resize
      let isResizing = false;
      let resizeStartX = 0, resizeStartY = 0;
      let slotStartW = 0, slotStartH = 0;

      resizeHandle.addEventListener('pointerdown', (e) => {
        isResizing = true;
        resizeHandle.setPointerCapture(e.pointerId);
        resizeStartX = e.clientX;
        resizeStartY = e.clientY;
        slotStartW = item.width;
        slotStartH = item.height;
        e.stopPropagation();
      });

      resizeHandle.addEventListener('pointermove', (e) => {
        if (!isResizing) return;
        const rect = el.minimapScreen.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const deltaW = (e.clientX - resizeStartX) / rect.width;
        const deltaH = (e.clientY - resizeStartY) / rect.height;

        let newW = slotStartW + deltaW;
        let newH = slotStartH + deltaH;

        if (el.snapGridToggle && el.snapGridToggle.checked) {
          const snapStep = 0.05;
          newW = Math.round(newW / snapStep) * snapStep;
          newH = Math.round(newH / snapStep) * snapStep;
        }

        newW = Math.max(0.12, Math.min(1 - item.x, newW));
        newH = Math.max(0.12, Math.min(1 - item.y, newH));

        item.width = newW;
        item.height = newH;
        slotDiv.style.width = `${newW * 100}%`;
        slotDiv.style.height = `${newH * 100}%`;
        const dims = slotDiv.querySelector('.minimap-slot-dims');
        if (dims) dims.textContent = `${Math.round(newW * 100)}% × ${Math.round(newH * 100)}%`;
      });

      const onResizeUp = (e) => {
        if (isResizing) {
          isResizing = false;
          try { resizeHandle.releasePointerCapture(e.pointerId); } catch (_) {}
          renderMinimap();
        }
      };
      resizeHandle.addEventListener('pointerup', onResizeUp);
      resizeHandle.addEventListener('pointercancel', onResizeUp);

      el.minimapScreen.appendChild(slotDiv);
    });
  }

  // Preset buttons in Layout Editor
  document.querySelectorAll('#editorPresetButtons .btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      if (!PRESET_RECTS[p]) return;
      activeEditorSlots = PRESET_RECTS[p].map((r, i) => ({
        slot: i,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }));
      renderMinimap();
    });
  });

  if (el.addEditorSlotBtn) {
    el.addEditorSlotBtn.addEventListener('click', () => {
      if (activeEditorSlots.length >= SLOT_COUNT) {
        showToast('Limit Reached', 'Maximum 8 screens supported.');
        return;
      }
      const used = new Set(activeEditorSlots.map(s => s.slot));
      let nextSlot = 0;
      while (used.has(nextSlot) && nextSlot < SLOT_COUNT) nextSlot++;
      if (nextSlot >= SLOT_COUNT) nextSlot = activeEditorSlots.length;

      activeEditorSlots.push({
        slot: nextSlot,
        x: 0.08 * (activeEditorSlots.length % 5),
        y: 0.08 * (activeEditorSlots.length % 5),
        width: 0.35,
        height: 0.35,
      });
      renderMinimap();
    });
  }

  if (el.clearEditorSlotsBtn) {
    el.clearEditorSlotsBtn.addEventListener('click', () => {
      activeEditorSlots = [
        { slot: 0, x: 0, y: 0, width: 1, height: 1 }
      ];
      renderMinimap();
    });
  }

  if (el.applyLayoutToWallBtn) {
    el.applyLayoutToWallBtn.addEventListener('click', () => {
      if (!activeEditorSlots.length) {
        showToast('Empty Layout', 'Add at least one screen to apply.');
        return;
      }
      const before = snapshotWallState();
      activeEditorSlots.sort((a, b) => a.slot - b.slot);
      const rects = activeEditorSlots.map(s => ({
        x: Math.round(s.x * 1000) / 1000,
        y: Math.round(s.y * 1000) / 1000,
        width: Math.round(s.width * 1000) / 1000,
        height: Math.round(s.height * 1000) / 1000,
      }));

      state.layout = 'custom';
      state.customLayoutRects = rects;
      localStorage.setItem('gamewall_active_custom_layout', JSON.stringify(rects));

      [...el.layoutPicker.children].forEach(b => b.classList.remove('active'));
      if (el.customLayoutBtn) el.customLayoutBtn.classList.add('active');

      sendCommand({ action: 'layout', layout: 'custom', rects: rects });
      renderSlots();
      closeLayoutEditor();
      showToast('Custom Layout Active', `Applied layout with ${rects.length} screens to GameWall.`);
      recordAction('customLayout', `Applied custom layout (${rects.length} screens)`, before);
    });
  }

  if (el.customLayoutBtn) el.customLayoutBtn.addEventListener('click', openLayoutEditor);
  if (el.layoutEditorCloseBtn) el.layoutEditorCloseBtn.addEventListener('click', closeLayoutEditor);
  if (el.layoutEditorCancelBtn) el.layoutEditorCancelBtn.addEventListener('click', closeLayoutEditor);

  // ---------------- Game Day Scheduling System (Day Planner) ----------------
  function openDayPlanner() {
    renderDayPlannerModal();
    el.dayPlannerModal.hidden = false;
  }

  function closeDayPlanner() {
    el.dayPlannerModal.hidden = true;
  }

  function updatePlannerBadge() {
    if (!el.dayPlannerBadge) return;
    const active = Boolean(state.dayPlanner && state.dayPlanner.enabled);
    el.dayPlannerBadge.textContent = active ? 'Active' : 'Off';
    el.dayPlannerBadge.classList.toggle('active', active);
    if (el.plannerActiveStatus) {
      el.plannerActiveStatus.textContent = active ? 'Auto-Pilot Running' : 'Auto-Pilot Inactive';
      el.plannerActiveStatus.className = `planner-status-badge ${active ? 'planner-status-badge--on' : 'planner-status-badge--off'}`;
    }
    if (el.plannerMasterToggle) {
      el.plannerMasterToggle.checked = active;
    }
  }

  function renderDayPlannerModal() {
    updatePlannerBadge();
    if (el.plannerPolicyAutoSwitch) el.plannerPolicyAutoSwitch.checked = state.dayPlanner.autoSwitchCompleted !== false;
    if (el.plannerPolicyOtDelay) el.plannerPolicyOtDelay.checked = state.dayPlanner.otDelay !== false;
    if (el.plannerPolicyProtectPinned) el.plannerPolicyProtectPinned.checked = state.dayPlanner.protectPinned !== false;
    if (el.plannerPolicyAudioFocus) el.plannerPolicyAudioFocus.checked = Boolean(state.dayPlanner.audioFocus);
    if (el.plannerOtPolicy) el.plannerOtPolicy.value = state.dayPlanner.otPolicy || 'wait';
    if (el.plannerOtGraceMinutes) el.plannerOtGraceMinutes.value = String(state.dayPlanner.otGraceMinutes ?? 20);
    if (el.plannerManualOverridePrecedence) el.plannerManualOverridePrecedence.value = state.dayPlanner.manualOverridePrecedence || 'keepUntilNextBlock';
    if (el.plannerMissingGameFallback) el.plannerMissingGameFallback.value = state.dayPlanner.missingGameFallback || 'autoSubstitute';

    renderPlannerBlocksList();
  }

  function renderPlannerBlocksList() {
    if (!el.plannerBlocksList) return;
    el.plannerBlocksList.innerHTML = '';
    if (!state.dayPlanner.blocks || !state.dayPlanner.blocks.length) {
      el.plannerBlocksList.innerHTML = '<p class="schedule-empty">No time blocks planned. Click "+ Add Time Block" or "Auto-Generate" above.</p>';
      return;
    }

    state.dayPlanner.blocks.forEach((block, bIdx) => {
      const card = document.createElement('div');
      card.className = 'planner-block-card';

      const head = document.createElement('div');
      head.className = 'planner-block-head';

      const timeInput = document.createElement('input');
      timeInput.type = 'time';
      timeInput.value = block.time || '12:00';
      timeInput.addEventListener('change', () => {
        block.time = timeInput.value;
      });

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'block-title-input';
      titleInput.placeholder = 'Block Name (e.g. Afternoon Slate)';
      titleInput.value = block.name || '';
      titleInput.addEventListener('input', () => {
        block.name = titleInput.value;
      });

      const layoutSelect = document.createElement('select');
      layoutSelect.innerHTML = `
        <option value="1">1-Up (Solo)</option>
        <option value="2">2-Up (Side-by-Side)</option>
        <option value="4">4-Up (2x2 Quad)</option>
        <option value="6">6-Up (2x3)</option>
        <option value="8">8-Up (2x4)</option>
        <option value="featured">Featured 1+4</option>
        <option value="pip">PiP Corner</option>
        <option value="split3">3-Split</option>
      `;
      for (const customName of Object.keys(state.customLayoutPresets)) {
        const opt = document.createElement('option');
        opt.value = `custom:${customName}`;
        opt.textContent = `Custom: ${customName}`;
        layoutSelect.appendChild(opt);
      }
      layoutSelect.value = block.layout || '4';
      layoutSelect.addEventListener('change', () => {
        block.layout = layoutSelect.value;
        syncBlockRulesCount(block);
        renderPlannerBlocksList();
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-danger';
      removeBtn.type = 'button';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = 'Delete Block';
      removeBtn.addEventListener('click', () => {
        state.dayPlanner.blocks.splice(bIdx, 1);
        renderPlannerBlocksList();
      });

      head.append(timeInput, titleInput, layoutSelect, removeBtn);

      // Slot rules
      const slotsContainer = document.createElement('div');
      slotsContainer.className = 'planner-block-slots';
      syncBlockRulesCount(block);

      block.slotRules.forEach((rule, sIdx) => {
        const ruleDiv = document.createElement('div');
        ruleDiv.className = 'planner-slot-rule';

        const ruleHead = document.createElement('div');
        ruleHead.className = 'planner-slot-rule-head';
        ruleHead.textContent = `Screen ${sIdx + 1} Rule`;

        const typeSelect = document.createElement('select');
        typeSelect.innerHTML = `
          <option value="auto">Auto-Pick Top Live Game</option>
          <option value="pinned">Favorite / Pinned Team First</option>
          <option value="team">Specific Team...</option>
          <option value="network">Specific Network...</option>
          <option value="keep">Keep Current Game Running</option>
        `;
        typeSelect.value = rule.type || 'auto';

        const valInput = document.createElement('input');
        valInput.type = 'text';
        valInput.value = rule.value || '';
        valInput.placeholder = rule.type === 'team' ? 'e.g. Georgia' : rule.type === 'network' ? 'ABC / FOX / CBS' : 'Filter value';
        valInput.hidden = rule.type === 'auto' || rule.type === 'pinned' || rule.type === 'keep';

        typeSelect.addEventListener('change', () => {
          rule.type = typeSelect.value;
          valInput.hidden = rule.type === 'auto' || rule.type === 'pinned' || rule.type === 'keep';
          valInput.placeholder = rule.type === 'team' ? 'e.g. Georgia' : rule.type === 'network' ? 'ABC / FOX / CBS' : 'Filter value';
        });

        valInput.addEventListener('input', () => {
          rule.value = valInput.value.trim();
        });

        ruleDiv.append(ruleHead, typeSelect, valInput);
        slotsContainer.appendChild(ruleDiv);
      });

      card.append(head, slotsContainer);
      el.plannerBlocksList.appendChild(card);
    });
  }

  function getLayoutScreenCount(layoutStr) {
    if (!layoutStr) return 4;
    if (layoutStr.startsWith('custom:')) {
      const name = layoutStr.replace('custom:', '');
      const preset = state.customLayoutPresets[name];
      return preset ? preset.length : 4;
    }
    if (layoutStr === 'pip') return 2;
    if (layoutStr === 'split3') return 3;
    return LAYOUT_VISIBLE_COUNT[layoutStr] ?? 4;
  }

  function syncBlockRulesCount(block) {
    const count = getLayoutScreenCount(block.layout || '4');
    if (!block.slotRules) block.slotRules = [];
    while (block.slotRules.length < count) {
      block.slotRules.push({ type: 'auto', value: '' });
    }
    if (block.slotRules.length > count) {
      block.slotRules.length = count;
    }
  }

  if (el.addPlannerBlockBtn) {
    el.addPlannerBlockBtn.addEventListener('click', () => {
      state.dayPlanner.blocks.push({
        id: 'block-' + Date.now(),
        time: '14:00',
        name: 'Custom Slate',
        layout: '4',
        slotRules: [
          { type: 'pinned', value: '' },
          { type: 'auto', value: '' },
          { type: 'auto', value: '' },
          { type: 'auto', value: '' }
        ],
        executedDate: null
      });
      renderPlannerBlocksList();
    });
  }

  if (el.plannerMasterToggle) {
    el.plannerMasterToggle.addEventListener('change', () => {
      state.dayPlanner.enabled = el.plannerMasterToggle.checked;
      updatePlannerBadge();
      saveDayPlanner();
      showToast(
        state.dayPlanner.enabled ? 'Day Planner Active' : 'Day Planner Disabled',
        state.dayPlanner.enabled ? 'Auto-Pilot will manage layouts, favorite teams, and auto-switches all day.' : 'Auto-Pilot turned off. Manual control restored.'
      );
    });
  }

  if (el.plannerClearPlanBtn) {
    el.plannerClearPlanBtn.addEventListener('click', () => {
      state.dayPlanner.blocks = [];
      renderPlannerBlocksList();
      saveDayPlanner();
    });
  }

  if (el.plannerGenerateTodayBtn) {
    el.plannerGenerateTodayBtn.addEventListener('click', () => {
      autoGenerateTodayPlan();
    });
  }

  function autoGenerateTodayPlan() {
    state.dayPlanner.blocks = [
      {
        id: 'block-noon',
        time: '12:00',
        name: 'Noon Kickoff Slate',
        layout: '4',
        slotRules: [
          { type: 'pinned', value: '' },
          { type: 'auto', value: '' },
          { type: 'auto', value: '' },
          { type: 'auto', value: '' }
        ],
        executedDate: null
      },
      {
        id: 'block-afternoon',
        time: '15:30',
        name: 'Afternoon SEC / Big Ten Slate',
        layout: '4',
        slotRules: [
          { type: 'pinned', value: '' },
          { type: 'auto', value: '' },
          { type: 'auto', value: '' },
          { type: 'auto', value: '' }
        ],
        executedDate: null
      },
      {
        id: 'block-primetime',
        time: '19:00',
        name: 'Primetime Football',
        layout: 'featured',
        slotRules: [
          { type: 'pinned', value: '' },
          { type: 'auto', value: '' },
          { type: 'auto', value: '' },
          { type: 'auto', value: '' },
          { type: 'auto', value: '' }
        ],
        executedDate: null
      },
      {
        id: 'block-latenight',
        time: '22:30',
        name: 'Late Night Pac-12 & UFC Main Event',
        layout: '2',
        slotRules: [
          { type: 'auto', value: '' },
          { type: 'auto', value: '' }
        ],
        executedDate: null
      }
    ];

    state.dayPlanner.enabled = true;
    renderDayPlannerModal();
    saveDayPlanner();
    showToast('Day Plan Generated', 'Created 4-stage game day timeline (Noon, 3:30, 7:00, 10:30 PM). Auto-Pilot enabled!', true);
  }

  function saveDayPlanner() {
    if (el.plannerPolicyAutoSwitch) state.dayPlanner.autoSwitchCompleted = el.plannerPolicyAutoSwitch.checked;
    if (el.plannerPolicyOtDelay) state.dayPlanner.otDelay = el.plannerPolicyOtDelay.checked;
    if (el.plannerPolicyProtectPinned) state.dayPlanner.protectPinned = el.plannerPolicyProtectPinned.checked;
    if (el.plannerPolicyAudioFocus) state.dayPlanner.audioFocus = el.plannerPolicyAudioFocus.checked;
    if (el.plannerOtPolicy) state.dayPlanner.otPolicy = el.plannerOtPolicy.value;
    if (el.plannerOtGraceMinutes) state.dayPlanner.otGraceMinutes = parseInt(el.plannerOtGraceMinutes.value, 10) || 20;
    if (el.plannerManualOverridePrecedence) state.dayPlanner.manualOverridePrecedence = el.plannerManualOverridePrecedence.value;
    if (el.plannerMissingGameFallback) state.dayPlanner.missingGameFallback = el.plannerMissingGameFallback.value;
    localStorage.setItem('gamewall_day_planner', JSON.stringify(state.dayPlanner));
  }

  if (el.dayPlannerSaveCloseBtn) {
    el.dayPlannerSaveCloseBtn.addEventListener('click', () => {
      saveDayPlanner();
      closeDayPlanner();
      updatePlannerBadge();
      showToast('Day Plan Saved', 'Schedule saved and running in background.');
    });
  }

  if (el.dayPlannerBtn) el.dayPlannerBtn.addEventListener('click', openDayPlanner);
  if (el.dayPlannerCloseBtn) el.dayPlannerCloseBtn.addEventListener('click', closeDayPlanner);

  // ---------------- Day Planner & Auto-Switch Automation Loop ----------------
  function dayPlannerTick() {
    // 1. Evaluate auto-switch for completed games
    if (state.dayPlanner && state.dayPlanner.autoSwitchCompleted !== false) {
      checkAutoSwitchFinishedGames();
    }

    // 2. Evaluate audio focus
    if (state.dayPlanner && state.dayPlanner.audioFocus) {
      checkAudioFocus();
    }

    // 3. Evaluate Timeline Block Execution
    if (!state.dayPlanner || !state.dayPlanner.enabled || !state.dayPlanner.blocks || !state.dayPlanner.blocks.length) {
      return;
    }

    const now = new Date();
    const todayStr = now.toDateString();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const readyBlocks = state.dayPlanner.blocks.filter(b => {
      if (b.executedDate === todayStr) return false;
      const [bh, bm] = (b.time || '00:00').split(':').map(Number);
      const bMinutes = bh * 60 + (bm || 0);
      return currentMinutes >= bMinutes;
    });

    if (!readyBlocks.length) return;

    readyBlocks.sort((a, b) => {
      const [ah, am] = (a.time || '00:00').split(':').map(Number);
      const [bh, bm] = (b.time || '00:00').split(':').map(Number);
      return (ah * 60 + (am || 0)) - (bh * 60 + (bm || 0));
    });

    const activeBlock = readyBlocks[readyBlocks.length - 1];

    // Check overtime / close game delay policies (§6)
    const otPolicy = state.dayPlanner.otPolicy || (state.dayPlanner.otDelay !== false ? 'wait' : 'cutover');
    if (otPolicy !== 'cutover') {
      const hasCloseLiveGame = state.slots.some(slot => {
        if (!slot.lastGame || slot.lastGame.state !== 'in') return false;
        const diff = Math.abs((slot.lastGame.homeScore ?? 0) - (slot.lastGame.awayScore ?? 0));
        const status = (slot.lastGame.statusDetail || '').toLowerCase();
        return status.includes('ot') || (status.includes('4th') && diff <= 8);
      });

      if (hasCloseLiveGame) {
        const [ah, am] = (activeBlock.time || '00:00').split(':').map(Number);
        const blockMinutes = ah * 60 + (am || 0);
        const elapsed = currentMinutes - blockMinutes;
        const graceMinutes = state.dayPlanner.otGraceMinutes ?? 20;

        if (otPolicy === 'wait') {
          return; // Hold slate transition until OT finishes
        } else if (otPolicy === 'grace') {
          if (elapsed < graceMinutes) {
            return; // Hold slate transition within grace period
          }
          // Grace exceeded -> fall through to execute block
        }
      }
    }

    executeDayPlanBlock(activeBlock);
    readyBlocks.forEach(b => { b.executedDate = todayStr; });
    localStorage.setItem('gamewall_day_planner', JSON.stringify(state.dayPlanner));
  }

  function executeDayPlanBlock(block) {
    const before = snapshotWallState();
    showToast('Day Planner Slate Change', `Transitioning to "${block.name || 'Next Slate'}" (${block.time}).`, true, 8000);

    // Apply layout
    if (block.layout && block.layout.startsWith('custom:')) {
      const name = block.layout.replace('custom:', '');
      const rects = state.customLayoutPresets[name];
      if (rects) {
        state.layout = 'custom';
        state.customLayoutRects = rects;
        sendCommand({ action: 'layout', layout: 'custom', rects });
      }
    } else if (PRESET_RECTS[block.layout]) {
      state.layout = block.layout;
      [...el.layoutPicker.children].forEach(b => b.classList.toggle('active', b.dataset.layout === block.layout));
      if (el.customLayoutBtn) el.customLayoutBtn.classList.remove('active');
      sendCommand({ action: 'layout', layout: block.layout });
    } else {
      state.layout = block.layout;
      sendCommand({ action: 'layout', layout: block.layout });
    }

    const visibleCount = getLayoutScreenCount(block.layout);
    const assignedIds = new Set();
    const fallback = state.dayPlanner.missingGameFallback || 'autoSubstitute';
    const manualPrecedence = state.dayPlanner.manualOverridePrecedence || 'keepUntilNextBlock';

    // Pass 1: 'keep' rules and manual override protection
    for (let i = 0; i < visibleCount; i++) {
      const rule = block.slotRules?.[i];
      if ((rule && rule.type === 'keep') || (manualPrecedence === 'protectUserAssigned' && state.slots[i].manuallyAssigned)) {
        if (state.slots[i].lastGame) {
          assignedIds.add(state.slots[i].lastGame.id);
        }
      }
    }

    // Pass 2: pinned, team, sport, network
    for (let i = 0; i < visibleCount; i++) {
      const rule = block.slotRules?.[i];
      if (!rule || rule.type === 'keep') continue;
      if (manualPrecedence === 'protectUserAssigned' && state.slots[i].manuallyAssigned) continue;

      let candidate = null;
      if (rule.type === 'pinned') {
        candidate = state.schedule.find(g => isPinnedGame(g) && !assignedIds.has(g.id));
      } else if (rule.type === 'team' && rule.value) {
        const val = rule.value.toLowerCase();
        candidate = state.schedule.find(g => gameTeams(g).some(t => t.toLowerCase().includes(val)) && !assignedIds.has(g.id));
      } else if (rule.type === 'sport' && rule.value) {
        const sport = rule.value.toLowerCase();
        candidate = state.schedule
          .filter(g => (g.sport || 'football') === sport && !assignedIds.has(g.id))
          .sort((a, b) => rankGame(b) - rankGame(a))[0];
      } else if (rule.type === 'network' && rule.value) {
        const net = rule.value.toLowerCase();
        candidate = state.schedule.find(g => (g.network || '').toLowerCase().includes(net) && !assignedIds.has(g.id));
      }

      if (candidate) {
        assignGameToSlot(candidate, i, false);
        assignedIds.add(candidate.id);
      } else {
        if (fallback === 'blank') {
          closeSlot(i);
        } else if (fallback === 'keepCurrent') {
          if (state.slots[i].lastGame) assignedIds.add(state.slots[i].lastGame.id);
        }
      }
    }

    // Pass 3: auto-fill remaining slots
    if (fallback === 'autoSubstitute') {
      const topRemaining = [...state.customGames, ...state.schedule]
        .filter(g => !assignedIds.has(g.id))
        .sort((a, b) => rankGame(b) - rankGame(a));

      let candidateIdx = 0;
      for (let i = 0; i < visibleCount; i++) {
        const rule = block.slotRules?.[i];
        if (rule && rule.type === 'keep' && state.slots[i].label) continue;
        if (manualPrecedence === 'protectUserAssigned' && state.slots[i].manuallyAssigned) continue;
        if (state.slots[i].lastGame && assignedIds.has(state.slots[i].lastGame.id)) continue;

        if (candidateIdx < topRemaining.length) {
          const nextGame = topRemaining[candidateIdx++];
          assignGameToSlot(nextGame, i, false);
          assignedIds.add(nextGame.id);
        }
      }
    }

    renderSlots();
    recordAction('dayPlannerSlate', `Day Planner: Applied "${block.name || 'Slate'}" (${block.time})`, before);
  }

  function checkAutoSwitchFinishedGames() {
    const visibleCount = state.layout === 'custom'
      ? (state.customLayoutRects?.length ?? 4)
      : (LAYOUT_VISIBLE_COUNT[state.layout] ?? 4);

    const assignedIds = new Set(state.slots.map(s => s.lastGame?.id).filter(Boolean));

    for (let i = 0; i < visibleCount; i++) {
      const slot = state.slots[i];
      if (!slot.label || !slot.lastGame || slot.lastGame.custom) continue;

      const liveGame = state.schedule.find(g => g.id === slot.lastGame.id);
      if (!liveGame) continue;

      slot.lastGame.state = liveGame.state;
      slot.lastGame.statusDetail = liveGame.statusDetail;
      slot.lastGame.homeScore = liveGame.homeScore;
      slot.lastGame.awayScore = liveGame.awayScore;

      if (liveGame.state === 'post' || (liveGame.statusDetail || '').toLowerCase().startsWith('final')) {
        if (!slot.lastGame.endedAt) slot.lastGame.endedAt = Date.now();
        if (state.dayPlanner && state.dayPlanner.protectPinned && isPinnedGame(liveGame)) {
          continue;
        }

        const candidate = [...state.customGames, ...state.schedule]
          .filter(g => !assignedIds.has(g.id) && g.state !== 'post')
          .sort((a, b) => rankGame(b) - rankGame(a))[0];

        if (candidate) {
          const before = snapshotWallState();
          const oldLabel = slot.label;
          assignGameToSlot(candidate, i, false);
          assignedIds.add(candidate.id);
          showToast(
            'Game Ended — Auto-Switched',
            `Screen ${i + 1}: Replaced completed "${oldLabel}" with "${slot.label}".`,
            true,
            8000
          );
          recordAction('autoSwitch', `Auto-Switched: Replaced completed "${oldLabel}" on Screen ${i + 1}`, before);
        }
      }
    }
  }

  function checkAutoClearFinishedGames() {
    const now = Date.now();
    const AUTO_CLEAR_MS = 60 * 60 * 1000; // 60 minutes
    for (let i = 0; i < state.slots.length; i++) {
      const slot = state.slots[i];
      if (!slot.label && slot.lastGame) {
        if (slot.lastGame.state === 'post' && !slot.lastGame.endedAt) {
          slot.lastGame.endedAt = now;
        }
        if (slot.lastGame.endedAt && (now - slot.lastGame.endedAt >= AUTO_CLEAR_MS)) {
          clearSlot(i, true);
        }
      }
    }
  }

  function checkAudioFocus() {
    const visibleCount = state.layout === 'custom'
      ? (state.customLayoutRects?.length ?? 4)
      : (LAYOUT_VISIBLE_COUNT[state.layout] ?? 4);

    let closestSlot = -1;
    let minDiff = 999;

    for (let i = 0; i < visibleCount; i++) {
      const slot = state.slots[i];
      if (!slot.lastGame || slot.lastGame.state !== 'in') continue;
      const status = (slot.lastGame.statusDetail || '').toLowerCase();
      if (status.includes('ot') || status.includes('4th')) {
        const diff = Math.abs((slot.lastGame.homeScore ?? 0) - (slot.lastGame.awayScore ?? 0));
        if (diff < minDiff) {
          minDiff = diff;
          closestSlot = i;
        }
      }
    }

    if (closestSlot >= 0 && state.slots[closestSlot].muted) {
      state.slots.forEach((s, idx) => {
        const shouldMute = idx !== closestSlot;
        if (s.muted !== shouldMute) {
          s.muted = shouldMute;
          sendCommand({ action: 'mute', slot: idx, muted: shouldMute });
        }
      });
      renderSlots();
      showToast('Audio Focus Auto-Switched', `Unmuted Screen ${closestSlot + 1} (${state.slots[closestSlot].label}) in close 4th quarter.`);
    }
  }

  function renderTicker() {
    const filtered = state.schedule;
    const live = filtered.filter(g => g.state === 'in');
    const list = live.length ? live : filtered.slice(0, 12);

    if (!list.length) {
      el.tickerTrack.textContent = 'No games this week or next.';
      return;
    }

    const parts = list.map(g => {
      if (g.isRace) return `${g.homeTeam} \u2014 ${g.statusDetail || formatKickoff(g.kickoff)}`;
      if (g.state === 'in') return `${g.awayTeam} ${g.awayScore ?? 0} \u2014 ${g.homeTeam} ${g.homeScore ?? 0} (${g.statusDetail})`;
      if (g.state === 'post') return `Final: ${g.awayTeam} ${g.awayScore ?? 0} \u2014 ${g.homeTeam} ${g.homeScore ?? 0}`;
      return `${g.awayTeam} @ ${g.homeTeam} \u2014 ${formatKickoff(g.kickoff)}`;
    });

    el.tickerTrack.textContent = parts.join('     \u2022     ');
  }

  // ---------------- init ----------------

  renderSlots();
  loadNetworks();
  loadSchedule();
  updatePlannerBadge();
  dayPlannerTick();
  checkAutoClearFinishedGames();
  setInterval(loadSchedule, 30000);
  setInterval(dayPlannerTick, 12000);
  setInterval(checkAutoClearFinishedGames, 60000);

  // ---------------- API for the phone screen (mobile.js) ----------------
  // The phone UI is a different presentation of the same remote: it calls these
  // functions and the existing buttons, so every feature behaves identically.
  function visibleSlotCount() {
    return state.layout === 'custom'
      ? (state.customLayoutRects?.length ?? 4)
      : (LAYOUT_VISIBLE_COUNT[state.layout] ?? 4);
  }

  function layoutRects() {
    if (state.layout === 'custom' && Array.isArray(state.customLayoutRects) && state.customLayoutRects.length)
      return state.customLayoutRects;
    return PRESET_RECTS[state.layout] || PRESET_RECTS['4'];
  }

  function serviceLabelFor(game) {
    if (!game || game.custom) return game?.network || '';
    const url = pickWatchUrl(game.network, state.subscriptions, state.networksData, game.watchUrl);
    const services = { ...(state.networksData?.services || {}), ...(state.customServices || {}) };
    for (const [, svc] of Object.entries(services)) {
      if (svc && (svc.defaultUrl === url || svc.loginUrl === url)) return svc.label;
    }
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }

  window.GameWallApp = {
    state,
    SLOT_COUNT,
    PRESET_RECTS,
    onChange: null,
    visibleSlotCount,
    layoutRects,
    formatKickoff,
    isPinnedGame,
    findUsualSlot,
    rankGame,
    serviceLabelFor,
    sendCommand,
    setLayout(layout) {
      const button = el.layoutPicker.querySelector(`button[data-layout="${layout}"]`);
      if (button) button.click();
    },
    assignGame(game, slotIndex) { assignGameToSlot(game, slotIndex); },
    showStats(game, slotIndex) { openStatsPanelForGame(game, slotIndex); },
    closeSlot,
    clearSlot,
    swapSlots,
    setMuted(slotIndex, muted) {
      state.slots[slotIndex].muted = muted;
      sendCommand({ action: 'mute', slot: slotIndex, muted });
      renderSlots();
    },
    setVolume(slotIndex, volume) {
      state.slots[slotIndex].volume = volume;
      sendCommand({ action: 'volume', slot: slotIndex, volume });
    },
    reopenSlot(slotIndex) {
      const slot = state.slots[slotIndex];
      if (!slot.lastUrl) return;
      const before = snapshotWallState();
      slot.label = slot.lastLabel;
      slot.network = slot.lastNetwork;
      slot.muted = false;
      sendCommand({ action: 'navigate', slot: slotIndex, url: slot.lastUrl, label: slot.lastLabel, network: slot.lastNetwork,
        lastGameJson: slot.lastGame ? JSON.stringify(slot.lastGame) : null });
      sendCommand({ action: 'mute', slot: slotIndex, muted: false });
      renderSlots();
      recordAction('reopen', `Reopened ${slot.label} on Screen ${slotIndex + 1}`, before);
    },
    autoFill: autoFillSlots,
    undo() { undoAction(); },
    applyPreset: restorePreset,
    savePreset(name) {
      if (!name?.trim()) return;
      state.presets[name.trim()] = snapshotSlots();
      localStorage.setItem('gamewall_presets', JSON.stringify(state.presets));
      renderPresetPicker();
      notifyChange();
    },
    deletePreset(name) {
      delete state.presets[name];
      localStorage.setItem('gamewall_presets', JSON.stringify(state.presets));
      renderPresetPicker();
      notifyChange();
    },
    togglePinTeam,
    addCustomGame(label, url) {
      el.addGameLabel.value = label;
      el.addGameUrl.value = url;
      el.addGameBtn.click();
    },
    removeCustomGame,
    setMonitor(index) {
      el.monitorPicker.value = String(index);
      el.monitorPicker.dispatchEvent(new Event('change'));
      state.selectedMonitor = index;
      notifyChange();
    },
    testMode() { el.testModeBtn.click(); },
    closeAll() { el.closeAllBtn.click(); },
    endSession() { document.getElementById('endSessionBtn')?.click(); },
    openSubscriptions: openSubscriptionsModal,
    openLayoutEditor: () => el.customLayoutBtn.click(),
    openDayPlanner: () => el.dayPlannerBtn.click(),
    openHistory: () => el.historyBtn.click(),
    refreshSchedule: loadSchedule,
  };
  notifyChange();
})();

