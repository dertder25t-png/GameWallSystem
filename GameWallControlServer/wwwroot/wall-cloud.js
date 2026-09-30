// GameWall cloud link for the phone (GameDay → Wall).
//
// Active only when this page is served from GameDay under /wall/. Served by the
// laptop's own Control Server it does nothing and app.js uses the LAN socket.
//
// How it works:
//  - Pairing: the laptop shows a 6-digit code; entering it here trades the code for a
//    controller token (stored only on this phone).
//  - Commands: POSTed to the `wall` relay with that token. The relay validates them,
//    signs them with the laptop's key and pushes them to the laptop.
//  - State: the laptop publishes its wall state on a Realtime channel; we subscribe
//    and hand each message to app.js exactly as the LAN socket would.
(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const onWallPath = window.location.pathname.startsWith('/wall');
  if (!onWallPath && !params.has('cloud')) return;

  const CFG = Object.assign({
    supabaseUrl: 'https://lilemnoqfikkrykkrrpt.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxpbGVtbm9xZmlra3J5a2tycnB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3Nzg0NzksImV4cCI6MjEwNjM1NDQ3OX0.cEblqDweXieJ1HHsnr_6Jh6u8pnSV5Z9C7x1rVqWsEQ',
  }, window.GAMEWALL_CLOUD_CONFIG || {});
  const FUNCTION_URL = CFG.functionUrl || `${CFG.supabaseUrl}/functions/v1/wall`;
  const STORE_KEY = 'gamewall_cloud_pairing';

  let pairing = loadPairing();
  let handlers = null;
  let client = null;
  let channel = null;
  let agentOnline = false;
  let sessionActive = null;
  let subscribed = false;
  let lastError = '';
  let sendChain = Promise.resolve();
  const volumeTimers = new Map();

  // ------------------------------------------------------------ storage + relay

  function loadPairing() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return value && value.deviceId && value.token && value.stateTopic ? value : null;
    } catch (_) { return null; }
  }

  function savePairing(value) {
    pairing = value;
    try {
      if (value) localStorage.setItem(STORE_KEY, JSON.stringify(value));
      else localStorage.removeItem(STORE_KEY);
    } catch (_) {}
  }

  async function relay(body) {
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: CFG.anonKey },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function defaultPhoneName() {
    const saved = localStorage.getItem('gamewall_device_name');
    if (saved) return saved;
    const ua = navigator.userAgent || '';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android phone';
    return 'Browser';
  }

  // ------------------------------------------------------------ realtime

  function supabaseReady() {
    return new Promise((resolve, reject) => {
      if (window.supabase && window.supabase.createClient) return resolve(window.supabase);
      let tries = 0;
      const timer = setInterval(() => {
        if (window.supabase && window.supabase.createClient) { clearInterval(timer); resolve(window.supabase); }
        else if (++tries > 100) { clearInterval(timer); reject(new Error('Could not load the live connection library. Check your internet connection.')); }
      }, 100);
    });
  }

  async function subscribe() {
    if (!pairing || !handlers) return;
    await unsubscribe();
    let sb;
    try { sb = await supabaseReady(); } catch (err) { lastError = err.message; render(); return; }
    client = client || sb.createClient(CFG.supabaseUrl, CFG.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      ...(CFG.realtimeOptions ? { realtime: CFG.realtimeOptions } : {}),
    });
    const topic = pairing.stateTopic;
    channel = client.channel(topic, { config: { broadcast: { self: false }, presence: { key: '' } } });
    channel
      .on('broadcast', { event: 'state' }, ({ payload }) => {
        if (payload && payload.type === 'wallState') {
          if (typeof payload.sessionActive === 'boolean') sessionActive = payload.sessionActive;
          if (payload.deviceName && pairing && payload.deviceName !== pairing.deviceName) {
            savePairing({ ...pairing, deviceName: payload.deviceName });
          }
        }
        agentOnline = true;
        render();
        if (handlers && handlers.onMessage) handlers.onMessage(payload);
      })
      .on('presence', { event: 'sync' }, () => {
        const presence = channel ? channel.presenceState() : {};
        agentOnline = Object.values(presence).some(list => (list || []).some(p => p && p.role === 'agent'));
        render();
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          subscribed = true;
          lastError = '';
          if (handlers && handlers.onOpen) handlers.onOpen();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          subscribed = false;
          if (status !== 'CLOSED') lastError = 'Live connection interrupted, retrying…';
          if (handlers && handlers.onClose) handlers.onClose();
        }
        render();
      });
  }

  async function unsubscribe() {
    subscribed = false;
    agentOnline = false;
    if (channel && client) {
      try { await client.removeChannel(channel); } catch (_) {}
    }
    channel = null;
  }

  // ------------------------------------------------------------ commands

  function send(cmd) {
    if (!pairing) {
      lastError = 'Pair with your laptop first (code shown on the laptop).';
      render();
      focusCodeInput();
      return;
    }
    // A dragged volume slider fires dozens of events; only the last value per screen matters.
    if (cmd && cmd.action === 'volume' && Number.isInteger(cmd.slot)) {
      clearTimeout(volumeTimers.get(cmd.slot));
      volumeTimers.set(cmd.slot, setTimeout(() => enqueue(cmd), 150));
      return;
    }
    enqueue(cmd);
  }

  // Commands go out one at a time so the laptop sees them in the order you tapped.
  function enqueue(cmd) {
    const current = pairing;
    sendChain = sendChain
      .then(() => relay({ op: 'command', deviceId: current.deviceId, token: current.token, command: cmd }))
      .then(() => { if (lastError && !/Pair/.test(lastError)) { lastError = ''; render(); } })
      .catch(err => {
        if (err.status === 401 || err.status === 404) {
          savePairing(null);
          unsubscribe();
          lastError = 'This phone is no longer paired. Enter a new code from the laptop.';
        } else {
          lastError = `Couldn't send "${cmd.action}": ${err.message}`;
        }
        render();
      });
  }

  // ------------------------------------------------------------ pairing actions

  async function pair(code, name) {
    const digits = String(code || '').replace(/\D/g, '');
    if (digits.length !== 6) {
      lastError = 'Enter the 6-digit code shown on the laptop.';
      render();
      return;
    }
    lastError = '';
    setBusy(true);
    try {
      const phoneName = (name || '').trim() || defaultPhoneName();
      try { localStorage.setItem('gamewall_device_name', phoneName); } catch (_) {}
      const result = await relay({ op: 'claim', code: digits, name: phoneName });
      savePairing({
        deviceId: result.deviceId,
        token: result.token,
        deviceName: result.deviceName,
        stateTopic: result.stateTopic,
        pairedAt: new Date().toISOString(),
      });
      await subscribe();
    } catch (err) {
      lastError = err.message;
    } finally {
      setBusy(false);
      render();
    }
  }

  async function unpair() {
    if (!pairing) return;
    if (!confirm(`Unpair this phone from ${pairing.deviceName || 'the laptop'}?`)) return;
    const current = pairing;
    savePairing(null);
    await unsubscribe();
    if (handlers && handlers.onClose) handlers.onClose();
    render();
    try { await relay({ op: 'unpair', deviceId: current.deviceId, token: current.token }); } catch (_) {}
  }

  async function verifyPairing() {
    if (!pairing) return;
    try {
      const status = await relay({ op: 'status', deviceId: pairing.deviceId, token: pairing.token });
      if (status.deviceName && status.deviceName !== pairing.deviceName) savePairing({ ...pairing, deviceName: status.deviceName });
      render();
    } catch (err) {
      if (err.status === 401 || err.status === 404) {
        savePairing(null);
        await unsubscribe();
        lastError = 'This phone is no longer paired. Enter a new code from the laptop.';
        render();
      }
    }
  }

  // ------------------------------------------------------------ UI

  let bar = null;
  let busy = false;

  function setBusy(value) {
    busy = value;
    const button = bar && bar.querySelector('[data-cloud="pair"]');
    if (button) { button.disabled = value; button.textContent = value ? 'Pairing…' : 'Pair'; }
  }

  function focusCodeInput() {
    const input = bar && bar.querySelector('[data-cloud="code"]');
    if (input) input.focus();
  }

  function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render() {
    if (!bar) return;
    if (!pairing) {
      bar.className = 'cloud-bar cloud-bar--pair';
      bar.innerHTML = `
        <div class="cloud-pair">
          <div class="cloud-pair-text">
            <strong>Pair with your laptop</strong>
            <span>On the laptop: GameWall tray icon → <em>Pair a phone…</em>, then enter the code.</span>
          </div>
          <form class="cloud-pair-form" data-cloud="form" autocomplete="off">
            <input data-cloud="code" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" placeholder="123 456" aria-label="6-digit pairing code" />
            <input data-cloud="name" maxlength="40" placeholder="This phone's name" aria-label="Name for this phone" value="${esc(defaultPhoneName())}" />
            <button type="submit" class="btn-primary" data-cloud="pair">Pair</button>
          </form>
        </div>
        ${lastError ? `<p class="cloud-error" role="alert">${esc(lastError)}</p>` : ''}`;
      bar.querySelector('[data-cloud="form"]').addEventListener('submit', event => {
        event.preventDefault();
        pair(bar.querySelector('[data-cloud="code"]').value, bar.querySelector('[data-cloud="name"]').value);
      });
      if (busy) setBusy(true);
      return;
    }

    const online = agentOnline;
    const statusText = !subscribed ? 'connecting…' : online ? 'online' : 'offline';
    const wallText = !online || sessionActive === null ? '' : sessionActive ? ' · wall showing' : ' · wall hidden';
    bar.className = `cloud-bar ${online ? 'cloud-bar--online' : 'cloud-bar--offline'}`;
    bar.innerHTML = `
      <div class="cloud-device">
        <span class="cloud-dot" aria-hidden="true"></span>
        <span class="cloud-name">${esc(pairing.deviceName || 'GameWall laptop')}</span>
        <span class="cloud-status">${statusText}${wallText}</span>
      </div>
      <div class="cloud-actions">
        <button type="button" class="btn-secondary" data-cloud="identify" title="Show this laptop's name on the wall">Identify</button>
        <button type="button" class="btn-secondary" data-cloud="unpair">Unpair</button>
      </div>
      ${!online && subscribed ? '<p class="cloud-hint">Laptop offline. Open the lid and plug it in; GameWall starts with Windows and reconnects on its own.</p>' : ''}
      ${lastError ? `<p class="cloud-error" role="alert">${esc(lastError)}</p>` : ''}`;
    bar.querySelector('[data-cloud="identify"]').addEventListener('click', () => send({ action: 'identify' }));
    bar.querySelector('[data-cloud="unpair"]').addEventListener('click', unpair);
  }

  function renderNav() {
    // GameDay's bottom tab bar, so the Wall feels like part of GameDay.
    const nav = document.createElement('nav');
    nav.className = 'gd-nav';
    nav.setAttribute('aria-label', 'GameDay');
    // Same tabs and icons as GameDay's own bar, with Wall selected.
    const tabs = [
      ['/#home', 'My Team', '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>'],
      ['/#games', 'Games', '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
      ['/wall/', 'Wall', '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>'],
      ['/#teams', 'Teams', '<path d="M4 6h16M4 12h16M4 18h16"/>'],
      ['/#playoff', 'Playoff', '<path d="M4 5h5v5H4zM4 14h5v5H4zM9 7.5h4v9H9M13 12h7"/>'],
      ['/#settings', 'Alerts', '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'],
    ];
    nav.innerHTML = tabs.map(([href, label, icon]) => `
      <a href="${href}" class="${href === '/wall/' ? 'on' : ''}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>${label}
      </a>`).join('');
    document.body.appendChild(nav);
    document.body.classList.add('has-gd-nav');
  }

  function mount() {
    document.body.classList.add('cloud-mode');
    bar = document.createElement('section');
    bar.id = 'cloudBar';
    bar.setAttribute('aria-live', 'polite');
    const setup = document.getElementById('setupBar');
    if (setup) setup.insertAdjacentElement('beforebegin', bar);
    else document.body.prepend(bar);
    renderNav();
    render();
    verifyPairing();
    document.addEventListener('visibilitychange', () => {
      // Phones freeze background tabs; reconnect when the page comes back.
      if (document.visibilityState === 'visible' && pairing && !subscribed) subscribe();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.GameWallCloud = {
    connect(nextHandlers) {
      handlers = nextHandlers;
      if (pairing) subscribe();
      render();
    },
    send,
    isPaired: () => !!pairing,
  };
})();
