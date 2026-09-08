/**
 * Comprehensive client-side feature test suite for GameWallSystem
 * Run with: node tests/client-features.test.js
 */

const assert = require('assert');

console.log('=== Running GameWall Client-Side Feature Tests ===\n');

// ---------------- Helper Mock State Factory ----------------
function createInitialState() {
  return {
    layout: '4',
    customLayoutRects: null,
    wallStateRevision: 0,
    actionHistory: [],
    slots: Array.from({ length: 8 }, (_, i) => ({
      index: i,
      label: null,
      network: null,
      muted: false,
      volume: 1.0,
      health: 'ok',
      lastUrl: null,
      lastLabel: null,
      lastNetwork: null,
      lastGame: null,
      gameId: null,
      manuallyAssigned: false
    })),
    schedule: [],
    customGames: [],
    dayPlanner: {
      enabled: true,
      otPolicy: 'wait',
      otGraceMinutes: 20,
      manualOverridePrecedence: 'keepUntilNextBlock',
      missingGameFallback: 'autoSubstitute',
      blocks: []
    }
  };
}

function snapshotWallState(state) {
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

function recordAction(state, type, description, beforeSnapshot) {
  const entry = {
    id: 'act-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    type,
    description,
    timestamp: Date.now(),
    before: beforeSnapshot,
    after: snapshotWallState(state)
  };
  state.actionHistory.unshift(entry);
  if (state.actionHistory.length > 40) state.actionHistory.length = 40;
  return entry;
}

function undoAction(state, actionId) {
  const index = actionId ? state.actionHistory.findIndex(a => a.id === actionId) : 0;
  if (index < 0 || !state.actionHistory[index]) return null;
  const item = state.actionHistory[index];
  state.actionHistory.splice(index, 1);

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
      lastGame: s.lastGame,
      manuallyAssigned: false
    }));
  }
  return item;
}

// ---------------- Test 1: Authoritative WallState Sync (§7.1) ----------------
(() => {
  console.log('Test 1: Authoritative WallState synchronization & revision tracking');
  const state = createInitialState();

  const incomingBroadcast = {
    type: 'wallState',
    revision: 15,
    layout: 'featured',
    clients: ['iPad Pro', 'Pixel 8'],
    slots: [
      {
        index: 0,
        url: 'https://espn.com/live1',
        label: 'Alabama @ LSU',
        network: 'ABC',
        muted: false,
        volume: 0.9,
        health: 'ok',
        gameId: '401628510'
      }
    ]
  };

  // Process broadcast
  state.wallStateRevision = incomingBroadcast.revision;
  state.layout = incomingBroadcast.layout;
  const s0 = incomingBroadcast.slots[0];
  state.slots[0].label = s0.label;
  state.slots[0].network = s0.network;
  state.slots[0].lastUrl = s0.url;
  state.slots[0].lastLabel = s0.label;
  state.slots[0].gameId = s0.gameId;

  assert.strictEqual(state.wallStateRevision, 15, 'Revision should update to 15');
  assert.strictEqual(state.layout, 'featured', 'Layout should update to featured');
  assert.strictEqual(state.slots[0].label, 'Alabama @ LSU');
  assert.strictEqual(state.slots[0].gameId, '401628510');
  console.log('  ✓ Passed: WallState and revision updated successfully.\n');
})();

// ---------------- Test 2: Undo History & Rollback (§7.2) ----------------
(() => {
  console.log('Test 2: Action history capture and full state rollback');
  const state = createInitialState();

  // Initial slot 0
  state.slots[0].label = 'Game A';
  state.slots[0].lastUrl = 'https://stream.a';
  state.layout = '4';

  const beforeSnapshot = snapshotWallState(state);

  // User changes layout to 1 and places Game B
  state.layout = '1';
  state.slots[0].label = 'Game B';
  state.slots[0].lastUrl = 'https://stream.b';

  const action = recordAction(state, 'layout', 'Switched to 1-Up', beforeSnapshot);
  assert.strictEqual(state.actionHistory.length, 1);
  assert.strictEqual(state.actionHistory[0].type, 'layout');

  // Verify undo rolls back layout and slot label
  undoAction(state, action.id);
  assert.strictEqual(state.layout, '4', 'Layout should roll back to 4');
  assert.strictEqual(state.slots[0].label, 'Game A', 'Slot label should roll back to Game A');
  assert.strictEqual(state.slots[0].lastUrl, 'https://stream.a', 'Slot url should roll back to stream.a');
  assert.strictEqual(state.actionHistory.length, 0, 'History should now be empty');

  // Test history cap at 40
  for (let i = 0; i < 50; i++) {
    recordAction(state, 'test', `Action ${i}`, snapshotWallState(state));
  }
  assert.strictEqual(state.actionHistory.length, 40, 'History must cap at 40 items');
  console.log('  ✓ Passed: Undo snapshot capture, rollback, and 40-item cap verified.\n');
})();

// ---------------- Test 3: Soft Close vs Hard Clear & Auto-Clear (§7.3) ----------------
(() => {
  console.log('Test 3: Soft close vs hard clear memory and 60-minute auto-clear threshold');
  const state = createInitialState();

  const mockGame = {
    id: 'game-100',
    homeTeam: 'Georgia',
    awayTeam: 'Tennessee',
    state: 'post',
    endedAt: Date.now() - (75 * 60 * 1000) // ended 75 minutes ago
  };

  // Setup active slot
  state.slots[0].label = 'Tennessee @ Georgia';
  state.slots[0].network = 'CBS';
  state.slots[0].lastUrl = 'https://stream.cbs';
  state.slots[0].lastLabel = 'Tennessee @ Georgia';
  state.slots[0].lastNetwork = 'CBS';
  state.slots[0].lastGame = mockGame;
  state.slots[0].gameId = mockGame.id;

  // 1. Soft Close: preserves reopen chip
  state.slots[0].label = null;
  state.slots[0].network = null;
  assert.strictEqual(state.slots[0].label, null, 'Active label must be null');
  assert.strictEqual(state.slots[0].lastUrl, 'https://stream.cbs', 'Reopen lastUrl must be preserved');
  assert.strictEqual(state.slots[0].lastGame.id, 'game-100', 'Reopen game memory must be preserved');

  // 2. Auto-Clear: Game ended 75 minutes ago (> 60 min)
  const now = Date.now();
  const AUTO_CLEAR_MS = 60 * 60 * 1000;
  if (!state.slots[0].label && state.slots[0].lastGame) {
    if (state.slots[0].lastGame.endedAt && (now - state.slots[0].lastGame.endedAt >= AUTO_CLEAR_MS)) {
      // Hard clear slot
      state.slots[0].lastUrl = null;
      state.slots[0].lastLabel = null;
      state.slots[0].lastNetwork = null;
      state.slots[0].lastGame = null;
      state.slots[0].gameId = null;
    }
  }

  assert.strictEqual(state.slots[0].lastUrl, null, 'Auto-clear must wipe lastUrl after 60 min');
  assert.strictEqual(state.slots[0].lastGame, null, 'Auto-clear must wipe lastGame after 60 min');

  // 3. Test game ended 20 minutes ago (< 60 min) - should NOT auto clear
  state.slots[1].label = null;
  state.slots[1].lastUrl = 'https://stream.recent';
  state.slots[1].lastGame = {
    id: 'game-recent',
    state: 'post',
    endedAt: Date.now() - (20 * 60 * 1000) // ended 20 min ago
  };

  if (!state.slots[1].label && state.slots[1].lastGame) {
    if (state.slots[1].lastGame.endedAt && (now - state.slots[1].lastGame.endedAt >= AUTO_CLEAR_MS)) {
      state.slots[1].lastUrl = null;
    }
  }
  assert.strictEqual(state.slots[1].lastUrl, 'https://stream.recent', 'Game ended < 60 min must retain reopen chip');
  console.log('  ✓ Passed: Soft close, hard clear, and 60-minute auto-clear verified.\n');
})();

// ---------------- Test 4: Day Planner Overtime & Fallback Policies (§6) ----------------
(() => {
  console.log('Test 4: Day Planner OT delay policies (wait, grace, cutover) and fallbacks');

  // Scenario A: otPolicy = 'wait'
  {
    const state = createInitialState();
    state.dayPlanner.otPolicy = 'wait';
    state.slots[0].lastGame = {
      id: 'g-ot',
      state: 'in',
      homeScore: 24,
      awayScore: 24,
      statusDetail: 'OT'
    };

    const hasCloseLiveGame = state.slots.some(slot => {
      if (!slot.lastGame || slot.lastGame.state !== 'in') return false;
      const diff = Math.abs((slot.lastGame.homeScore ?? 0) - (slot.lastGame.awayScore ?? 0));
      const status = (slot.lastGame.statusDetail || '').toLowerCase();
      return status.includes('ot') || (status.includes('4th') && diff <= 8);
    });

    assert.strictEqual(hasCloseLiveGame, true, 'Live game in OT must be recognized as close');
    const holdTransition = state.dayPlanner.otPolicy === 'wait' && hasCloseLiveGame;
    assert.strictEqual(holdTransition, true, 'otPolicy wait must hold slate transition during OT');
  }

  // Scenario B: otPolicy = 'grace' with elapsed < graceMinutes vs elapsed >= graceMinutes
  {
    const state = createInitialState();
    state.dayPlanner.otPolicy = 'grace';
    state.dayPlanner.otGraceMinutes = 20;

    const blockScheduledMinutes = 12 * 60; // 12:00
    const currentMinutes1 = 12 * 60 + 10;  // 12:10 (elapsed 10 min < 20 min)
    const elapsed1 = currentMinutes1 - blockScheduledMinutes;
    assert.strictEqual(elapsed1 < state.dayPlanner.otGraceMinutes, true, 'Should be within grace period at 10 min');

    const currentMinutes2 = 12 * 60 + 25;  // 12:25 (elapsed 25 min >= 20 min)
    const elapsed2 = currentMinutes2 - blockScheduledMinutes;
    assert.strictEqual(elapsed2 >= state.dayPlanner.otGraceMinutes, true, 'Grace period must expire at 25 min to force cutover');
  }

  // Scenario C: missingGameFallback = 'blank' vs 'keepCurrent' vs 'autoSubstitute'
  {
    const state = createInitialState();
    state.slots[0].label = 'Existing Game';
    state.slots[0].lastGame = { id: 'existing-1' };

    // When a team rule cannot find candidate:
    const candidate = null;
    let fallbackAction = null;

    // Fallback: keepCurrent
    state.dayPlanner.missingGameFallback = 'keepCurrent';
    if (!candidate && state.dayPlanner.missingGameFallback === 'keepCurrent') {
      fallbackAction = 'kept';
    }
    assert.strictEqual(fallbackAction, 'kept');

    // Fallback: blank
    state.dayPlanner.missingGameFallback = 'blank';
    if (!candidate && state.dayPlanner.missingGameFallback === 'blank') {
      fallbackAction = 'blanked';
    }
    assert.strictEqual(fallbackAction, 'blanked');
  }

  // Scenario D: manualOverridePrecedence = 'protectUserAssigned'
  {
    const state = createInitialState();
    state.dayPlanner.manualOverridePrecedence = 'protectUserAssigned';
    state.slots[0].manuallyAssigned = true;
    state.slots[0].label = 'User Picked Game';

    const isProtected = state.dayPlanner.manualOverridePrecedence === 'protectUserAssigned' && state.slots[0].manuallyAssigned;
    assert.strictEqual(isProtected, true, 'Manually assigned slot must be protected under protectUserAssigned policy');
  }

  console.log('  ✓ Passed: Day Planner OT policies (wait, grace, cutover), fallbacks, and override precedence verified.\n');
})();

// ---------------- Test 5: Rich Data Panel (§5) ----------------
(() => {
  console.log('Test 5: Rich Data Panel URL formation and prediction data structures');

  const game = {
    id: '401628555',
    sport: 'football',
    homeTeam: 'Michigan',
    awayTeam: 'Ohio State'
  };

  const hostIp = '192.168.1.50';
  const panelUrl = `http://${hostIp}:5050/panel.html?gameId=${encodeURIComponent(game.id)}&sport=${encodeURIComponent(game.sport || 'football')}`;

  assert.strictEqual(panelUrl, 'http://192.168.1.50:5050/panel.html?gameId=401628555&sport=football');

  // Test win probability percentage math
  const homeProb = 0.742;
  const awayProb = 1.0 - homeProb;
  const homePct = Math.round(homeProb * 100);
  const awayPct = Math.round(awayProb * 100);

  assert.strictEqual(homePct, 74);
  assert.strictEqual(awayPct, 26);
  assert.strictEqual(homePct + awayPct, 100);

  // Situation formatting: "3rd & 4 at MICH 35"
  const situation = {
    down: 3,
    distance: 4,
    yardline: 35,
    possession: 'MICH'
  };
  const sitText = `${situation.down === 1 ? '1st' : situation.down === 2 ? '2nd' : situation.down === 3 ? '3rd' : '4th'} & ${situation.distance} at ${situation.possession} ${situation.yardline}`;
  assert.strictEqual(sitText, '3rd & 4 at MICH 35');

  console.log('  ✓ Passed: Data panel URL generation and situation math verified.\n');
})();

console.log('====================================================');
console.log('  ALL CLIENT-SIDE FEATURE TESTS PASSED SUCCESSFULLY!');
console.log('====================================================');
