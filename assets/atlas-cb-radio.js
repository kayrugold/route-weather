(() => {
  'use strict';

  const DEFAULT_SERVER = 'https://atlas-radio.andy-596.workers.dev';
  const STORAGE_KEY = 'route-weather-atlas-cb-v1';
  const MAX_TX_MS = 30_000;
  const VAD_SILENCE_MS = 2_400;
  const VAD_MIN_SPEECH_MS = 700;
  const VAD_THRESHOLD = 0.018;
  const REPLAY_LIMIT = 3;
  const PRIORITY_FLASH_MS = 15_000;
  const ULAW_RATE = 12000;
  const TX_FRAME_SAMPLES = 1920; // 160ms @ 12kHz (~1.9 KB/frame -> ~12 KB/sec)

  // Fast G.711 µ-law codec (zero deps, works identically on Android WebView, Chrome, Safari)
  function encodeUlawSample(sample) {
    let s = Math.max(-1, Math.min(1, sample)) * 32767;
    const sign = s < 0 ? 0x80 : 0x00;
    if (s < 0) s = -s;
    if (s > 32635) s = 32635;
    s += 0x84;
    let exp = 7;
    for (let mask = 0x4000; exp > 0 && !(s & mask); exp--, mask >>= 1) {}
    const mantissa = (s >> (exp + 3)) & 0x0f;
    return (~(sign | (exp << 4) | mantissa)) & 0xff;
  }

  const ULAW_DECODE_TABLE = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = (~i) & 0xff;
    const sign = u & 0x80;
    const exp = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let t = ((mantissa << 3) + 0x84) << exp;
    t -= 0x84;
    ULAW_DECODE_TABLE[i] = (sign ? -t : t) / 32768;
  }

  function randomId(prefix) {
    const arr = new Uint8Array(8);
    try { crypto.getRandomValues(arr); } catch {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return prefix + '_' + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }

  function escHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function normalizeChannelId(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (s === 'FAM' || s === 'FAMILY') return 'FAM';
    if (s === 'CMP' || s === 'COMPANY' || s === 'FLEET') return 'CMP';
    const m = s.match(/^(?:CH\s*|CHANNEL\s*|CUSTOM\s*)?(\d{1,3})$/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > 999) return null;
    return 'CH' + n;
  }

  function formatChannelLabel(ch) {
    if (ch === 'FAM') return 'FAM';
    if (ch === 'CMP') return 'CMP';
    const m = String(ch || '').match(/^CH(\d+)$/);
    return m ? `CH ${m[1]}` : String(ch || 'CH 19');
  }

  function formatRangeLabel(rangeMi, channel) {
    if (channel === 'FAM' || channel === 'CMP') return 'Global';
    return Number(rangeMi) === 0 ? 'Global' : `${Number(rangeMi)} mi`;
  }

  function haversineMiles(lat1, lon1, lat2, lon2) {
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 3958.7613 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function loadState() {
    const defaults = {
      enabled: false,
      channel: 'CH19',
      lastCustomChannel: '',
      rangeMi: 30,
      handle: 'Driver-' + Math.floor(1000 + Math.random() * 9000),
      userId: randomId('drv'),
      rogerBeep: true,
      autoBreakIn: true,
      bgCallMode: 'queue', // 'queue' | 'alert' | 'breakin'
      privatePriority: 'FAM', // 'FAM' | 'CMP'
      wxInterrupt: false, // false = Tone + Flash LED Only (default), true = Interrupt & Speak
      muted: false,
      shareCmpPin: true,
      famGroup: null,
      cmpGroup: null,
      serverUrl: '',
    };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return { ...defaults, ...saved };
    } catch {
      return defaults;
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        enabled: state.enabled,
        channel: state.channel,
        lastCustomChannel: state.lastCustomChannel,
        rangeMi: state.rangeMi,
        handle: state.handle,
        userId: state.userId,
        rogerBeep: state.rogerBeep,
        autoBreakIn: state.autoBreakIn,
        bgCallMode: state.bgCallMode,
        privatePriority: state.privatePriority,
        wxInterrupt: state.wxInterrupt,
        muted: state.muted,
        shareCmpPin: state.shareCmpPin,
        famGroup: state.famGroup,
        cmpGroup: state.cmpGroup,
        serverUrl: state.serverUrl,
      }));
    } catch {}
  }

  function createController(opts = {}) {
    const { map, getGps, getWxImpacts, onToast, onWxTap, onWxInterruptChanged } = opts;
    const state = loadState();
    saveState(state);

    let audioCtx = null;
    let sockets = { pub: null, fam: null, cmp: null };
    let reconnectTimers = { pub: null, fam: null, cmp: null };
    let nearbyCounts = { pub: 0, fam: 0, cmp: 0 };
    let connectedFlags = { pub: false, fam: false, cmp: false };
    let cmpPeers = [];
    let cmpLayerGroup = typeof L !== 'undefined' ? L.layerGroup() : null;
    let cmpMarkers = new Map();

    // TX state
    let txActive = false;
    let txLatched = false;
    let txStartedAt = 0;
    let txTimer = null;
    let txTickTimer = null;
    let txStream = null;
    let txSourceNode = null;
    let txProcNode = null;
    let txSilentGain = null;
    let txLastVoiceAt = 0;
    let txTargetHandle = '';
    let pttDownAt = 0;
    let pttPointerId = null;

    // Live RX state
    let rxTalkers = new Map(); // `${slot}:${slotId}` -> { meta, nextTime, chunks[], gainNode, lastFrameAt }
    let rxMasterGain = null;
    let rxClashCount = 0;
    let rxClashNodes = null; // { noise, osc, gain }
    let activeRxMeta = null;
    let rxIdleTimer = null;
    let replaySource = null;
    let replayRing = []; // [{ samples: Uint8Array, sampleRate, handle, channelLabel, distanceText, groupType, ts }]
    let bgQueue = []; // Buffered background FAM/CMP calls waiting for channel clear or LED tap
    let ttsYieldingPriority = 0; // 1 = WX, 2 = NAV, 0 = none

    // Priority LED state
    let ledPulse = { fam: 0, cmp: 0 };
    let ledPulseTimers = { fam: null, cmp: null };
    let wxState = { count: 0, level: 'none' }; // 'none' | 'severe' | 'extreme'
    let wxPlaying = false;
    let wxLoading = false;
    let wxStationLabel = '';
    let wxCache = null; // { lat, lon, ts, script, label }
    let pendingApprovals = { fam: [], cmp: [] };
    let groupMembers = { fam: [], cmp: [] };
    let posInterval = null;
    let approvalPollInterval = null;
    let activeDialogTab = 'channels';

    const $id = id => document.getElementById(id);

    function serverBase() {
      const custom = String(state.serverUrl || '').trim().replace(/\/+$/, '');
      return custom || DEFAULT_SERVER;
    }

    function wsBase() {
      return serverBase().replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    }

    function ensureAudioCtx() {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    }

    function playRadioTone(kind) {
      const isAlertChime = kind === 'rx_break' || kind === 'rx_break_cmp' || kind === 'busy' || kind === 'wx_alert';
      if (!state.rogerBeep && !isAlertChime) return;
      const ctx = ensureAudioCtx();
      if (!ctx) return;
      try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        if (kind === 'tx_start') {
          osc.type = 'sine';
          osc.frequency.setValueAtTime(620, now);
          osc.frequency.exponentialRampToValueAtTime(880, now + 0.055);
          gain.gain.setValueAtTime(0.08, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(now); osc.stop(now + 0.07);
        } else if (kind === 'roger') {
          osc.type = 'sine';
          osc.frequency.setValueAtTime(1080, now);
          osc.frequency.setValueAtTime(860, now + 0.055);
          gain.gain.setValueAtTime(0.075, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(now); osc.stop(now + 0.12);
        } else if (kind === 'wx_alert') {
          // Crisp 1050 Hz NOAA Weather Radio attention tone (short & clear, non-jarring)
          osc.type = 'sine';
          osc.frequency.setValueAtTime(1050, now);
          gain.gain.setValueAtTime(0.22, now);
          gain.gain.setValueAtTime(0.22, now + 0.42);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(now); osc.stop(now + 0.56);
        } else if (kind === 'rx_break' || kind === 'rx_break_cmp') {
          // Crisp, clearly audible 2-note priority attention chime (FAM = higher, CMP = warm mid)
          const f1 = kind === 'rx_break_cmp' ? 740 : 880;
          const f2 = kind === 'rx_break_cmp' ? 988 : 1175;
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(f1, now);
          osc.frequency.setValueAtTime(f2, now + 0.11);
          gain.gain.setValueAtTime(0.24, now);
          gain.gain.setValueAtTime(0.24, now + 0.18);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(now); osc.stop(now + 0.29);
        } else if (kind === 'busy') {
          osc.type = 'square';
          osc.frequency.setValueAtTime(320, now);
          gain.gain.setValueAtTime(0.06, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(now); osc.stop(now + 0.15);
        }
      } catch {}
    }

    function playSquelchTail() {
      if (!state.rogerBeep) return;
      const ctx = ensureAudioCtx();
      if (!ctx) return;
      try {
        const len = Math.floor(ctx.sampleRate * 0.085);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
          const env = 1 - i / len;
          data[i] = (Math.random() * 2 - 1) * 0.22 * env;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1800;
        bp.Q.value = 1.2;
        const gain = ctx.createGain();
        gain.gain.value = 0.28;
        src.connect(bp); bp.connect(gain); gain.connect(ctx.destination);
        src.start();
      } catch {}
    }

    function setClashNoise(active) {
      if (!active || state.muted || ttsYieldingPriority === 1) {
        if (rxClashNodes) {
          try { rxClashNodes.noise.stop(); } catch {}
          try { rxClashNodes.osc.stop(); } catch {}
          try { rxClashNodes.gain.disconnect(); } catch {}
          rxClashNodes = null;
        }
        return;
      }
      if (rxClashNodes) return;
      const ctx = ensureAudioCtx();
      if (!ctx) return;
      try {
        // Synthetic CB "walking on each other" heterodyne squeal + squelch hash
        const len = ctx.sampleRate;
        const nBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const nd = nBuf.getChannelData(0);
        for (let i = 0; i < len; i++) nd[i] = (Math.random() * 2 - 1) * 0.35;
        const noise = ctx.createBufferSource();
        noise.buffer = nBuf;
        noise.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1650;
        bp.Q.value = 2.0;

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 1140;
        const oscGain = ctx.createGain();
        oscGain.gain.value = 0.032;

        const gain = ctx.createGain();
        gain.gain.value = 0.22;

        noise.connect(bp); bp.connect(gain);
        osc.connect(oscGain); oscGain.connect(gain);
        gain.connect(ctx.destination);
        noise.start();
        osc.start();
        rxClashNodes = { noise, osc, gain };
      } catch {}
    }

    function ensureRxMasterGain() {
      const ctx = ensureAudioCtx();
      if (!ctx) return null;
      if (!rxMasterGain) {
        rxMasterGain = ctx.createGain();
        rxMasterGain.gain.value = ttsYieldingPriority === 2 ? 0.22 : 1.0;
        rxMasterGain.connect(ctx.destination);
      }
      return rxMasterGain;
    }

    function notifyAndroidAudio(mode, priority) {
      if (window.isRouteWeatherAndroid && window.AndroidRoute?.cbSetAudioState) {
        try { window.AndroidRoute.cbSetAudioState(mode, priority); } catch {}
      }
    }

    function toast(msg, isErr = false) {
      if (typeof onToast === 'function') onToast(msg, isErr);
    }

    function currentSlot() {
      if (state.channel === 'FAM') return 'fam';
      if (state.channel === 'CMP') return 'cmp';
      return 'pub';
    }

    function currentPriority() {
      return state.channel === 'FAM' || state.channel === 'CMP' ? 4 : 5;
    }

    function setNeedleAngle(level01) {
      const needle = $id('cbNeedleArm');
      if (!needle) return;
      const clamped = Math.max(0, Math.min(1, level01));
      const deg = -52 + clamped * 104; // -52deg left to +52deg right
      needle.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    }

    function syncStripUi() {
      const strip = $id('cbRadioStrip');
      const menuBtn = $id('menuCbRadio');
      if (menuBtn) {
        menuBtn.classList.toggle('enabled', state.enabled);
        menuBtn.setAttribute('aria-pressed', String(state.enabled));
      }
      document.body.classList.toggle('has-cb-radio', state.enabled);
      if (strip) strip.hidden = !state.enabled;
      if (!state.enabled) return;

      const slot = currentSlot();
      const chanText = $id('cbChanLabel');
      const rangeText = $id('cbRangeMeta');
      if (chanText) chanText.textContent = formatChannelLabel(state.channel);
      if (rangeText) {
        const rng = formatRangeLabel(state.rangeMi, state.channel);
        const cnt = nearbyCounts[slot] || 0;
        const conn = connectedFlags[slot];
        rangeText.textContent = state.muted
          ? 'MUTED'
          : (conn ? `${rng} · ${cnt}` : `${rng} · …`);
      }

      const speakerEl = $id('cbSpeakerText');
      const meterBtn = $id('cbMeterBtn');
      if (meterBtn) {
        meterBtn.classList.toggle('rx-live', Boolean(activeRxMeta || replaySource));
        meterBtn.classList.toggle('tx-live', txActive);
      }
      if (speakerEl) {
        if (txActive) {
          const secs = Math.max(0, Math.floor((Date.now() - txStartedAt) / 1000));
          const modeTxt = rxClashCount >= 2 ? `WALKING ON (${rxClashCount})` : (txLatched ? 'LIVE TX' : 'ON AIR');
          speakerEl.textContent = txTargetHandle
            ? `${modeTxt} → ${txTargetHandle} · ${secs}s`
            : `${modeTxt} · ${String(secs).padStart(2, '0')}s`;
        } else if (wxLoading) {
          speakerEl.textContent = 'WX Radio: Tuning NWS…';
        } else if (wxPlaying) {
          speakerEl.textContent = `WX Radio · ${wxStationLabel || 'NOAA Live'}`;
        } else if (rxClashCount >= 2 && activeRxMeta) {
          speakerEl.textContent = `WALKING ON · ${rxClashCount} TX`;
        } else if (activeRxMeta) {
          const dist = activeRxMeta.distanceText ? ` · ${activeRxMeta.distanceText}` : '';
          const tag = activeRxMeta.groupType === 'FAM' || activeRxMeta.groupType === 'CMP'
            ? `[${activeRxMeta.groupType}] `
            : '';
          speakerEl.textContent = `${tag}${activeRxMeta.handle}${dist}`;
        } else if (state.muted) {
          speakerEl.textContent = 'CB Muted · Tap CH to unmute';
        } else if (replayRing.length) {
          speakerEl.textContent = `Last: ${replayRing[0].handle} · Tap ↺`;
        } else {
          speakerEl.textContent = connectedFlags[slot] ? 'Standby' : 'Connecting…';
        }
      }

      // Priority LEDs (NO green: FAM = Atlas Blue, CMP = Amber-Gold, WX = Alert Red)
      const famLed = $id('cbLedFam');
      const cmpLed = $id('cbLedCmp');
      const wxLed = $id('cbLedWx');
      const now = Date.now();

      if (famLed) {
        const joined = state.famGroup?.status === 'approved';
        const hasQueued = bgQueue.some(q => q.slot === 'fam');
        const pulsing = ledPulse.fam > now || pendingApprovals.fam.length > 0 || hasQueued;
        famLed.classList.toggle('ready', joined);
        famLed.classList.toggle('active', state.channel === 'FAM');
        famLed.classList.toggle('pulse', pulsing);
        famLed.title = hasQueued
          ? 'FAM: Buffered call waiting · Tap to hear & reply'
          : pendingApprovals.fam.length
            ? `FAM: ${pendingApprovals.fam.length} pending approval`
            : (joined ? 'Family channel · Tap to switch/reply' : 'Family channel · Tap to set up');
      }

      if (cmpLed) {
        const joined = state.cmpGroup?.status === 'approved';
        const hasQueued = bgQueue.some(q => q.slot === 'cmp');
        const pulsing = ledPulse.cmp > now || pendingApprovals.cmp.length > 0 || hasQueued;
        cmpLed.classList.toggle('ready', joined);
        cmpLed.classList.toggle('active', state.channel === 'CMP');
        cmpLed.classList.toggle('pulse', pulsing);
        cmpLed.title = hasQueued
          ? 'CMP: Buffered call waiting · Tap to hear & reply'
          : pendingApprovals.cmp.length
            ? `CMP: ${pendingApprovals.cmp.length} pending approval`
            : (joined ? 'Company channel · Tap to switch/reply' : 'Company channel · Tap to set up');
      }

      if (wxLed) {
        wxLed.classList.toggle('playing', wxPlaying || wxLoading);
        wxLed.classList.toggle('severe', wxState.level === 'severe');
        wxLed.classList.toggle('extreme', wxState.level === 'extreme');
        wxLed.classList.toggle('pulse', wxState.level === 'extreme' || wxState.level === 'severe');
        wxLed.title = wxPlaying
          ? 'WX Weather Radio playing · Tap to stop'
          : wxState.count
            ? `${wxState.count} active weather alert(s) · Tap to hear WX Radio`
            : 'Tap for Atlas NOAA Weather Radio';
      }

      const pttBtn = $id('cbPttBtn');
      if (pttBtn) {
        pttBtn.classList.toggle('tx-active', txActive);
        pttBtn.setAttribute('aria-pressed', String(txActive));
        pttBtn.textContent = txActive ? 'STOP' : 'PTT';
      }
    }

    function clearLedPulse(slot) {
      if (slot !== 'fam' && slot !== 'cmp') return;
      ledPulse[slot] = 0;
      clearTimeout(ledPulseTimers[slot]);
      ledPulseTimers[slot] = null;
    }

    function flashLed(slot) {
      if (slot !== 'fam' && slot !== 'cmp') return;
      ledPulse[slot] = Date.now() + PRIORITY_FLASH_MS;
      clearTimeout(ledPulseTimers[slot]);
      ledPulseTimers[slot] = setTimeout(() => {
        ledPulse[slot] = 0;
        syncStripUi();
      }, PRIORITY_FLASH_MS + 100);
      syncStripUi();
    }

    // -------------------------------------------------------------------------
    // WebSocket management (multi-watch: public + FAM + CMP)
    // -------------------------------------------------------------------------
    function closeSocket(slot) {
      clearTimeout(reconnectTimers[slot]);
      reconnectTimers[slot] = null;
      connectedFlags[slot] = false;
      const ws = sockets[slot];
      sockets[slot] = null;
      if (ws) {
        try { ws.onclose = null; ws.close(); } catch {}
      }
      if (slot === 'cmp') {
        cmpPeers = [];
        renderCmpPins();
      }
    }

    function sendPosPayload(ws, slot) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const gps = getGps?.();
      const payload = {
        type: 'pos',
        handle: state.handle,
        lat: gps?.lat ?? null,
        lon: gps?.lon ?? null,
        heading: Number.isFinite(gps?.heading) ? gps.heading : null,
        speedMph: Number.isFinite(gps?.speedMph) ? gps.speedMph : null,
      };
      if (slot === 'pub') payload.rangeMi = state.rangeMi;
      if (slot === 'cmp') payload.sharePin = Boolean(state.shareCmpPin);
      try { ws.send(JSON.stringify(payload)); } catch {}
    }

    function connectSlot(slot) {
      closeSocket(slot);
      if (!state.enabled) return;

      let url = '';
      if (slot === 'pub') {
        const pubCh = state.channel.startsWith('CH') ? state.channel : 'CH19';
        url = `${wsBase()}/ws/public/${encodeURIComponent(pubCh)}?clientId=${encodeURIComponent(state.userId)}&handle=${encodeURIComponent(state.handle)}`;
      } else if (slot === 'fam') {
        if (!state.famGroup || state.famGroup.status !== 'approved' || !state.famGroup.memberToken) return;
        url = `${wsBase()}/ws/private/${encodeURIComponent(state.famGroup.groupId)}?token=${encodeURIComponent(state.famGroup.memberToken)}&handle=${encodeURIComponent(state.handle)}`;
      } else if (slot === 'cmp') {
        if (!state.cmpGroup || state.cmpGroup.status !== 'approved' || !state.cmpGroup.memberToken) return;
        url = `${wsBase()}/ws/private/${encodeURIComponent(state.cmpGroup.groupId)}?token=${encodeURIComponent(state.cmpGroup.memberToken)}&handle=${encodeURIComponent(state.handle)}`;
      }
      if (!url) return;

      let ws;
      try {
        ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
      } catch {
        scheduleReconnect(slot);
        return;
      }
      sockets[slot] = ws;

      ws.onopen = () => {
        if (sockets[slot] !== ws) return;
        connectedFlags[slot] = true;
        sendPosPayload(ws, slot);
        syncStripUi();
      };

      ws.onmessage = ev => {
        if (sockets[slot] !== ws) return;
        if (ev.data instanceof ArrayBuffer) {
          handleLiveRxFrame(slot, new Uint8Array(ev.data));
          return;
        }
        if (typeof ev.data !== 'string') return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        handleWsJson(slot, msg);
      };

      ws.onerror = () => {
        // onclose will handle reconnect
      };

      ws.onclose = () => {
        if (sockets[slot] !== ws) return;
        sockets[slot] = null;
        connectedFlags[slot] = false;
        syncStripUi();
        if (state.enabled) scheduleReconnect(slot);
      };
    }

    function scheduleReconnect(slot) {
      clearTimeout(reconnectTimers[slot]);
      reconnectTimers[slot] = setTimeout(() => {
        if (state.enabled) connectSlot(slot);
      }, 3500);
    }

    function syncConnections() {
      if (!state.enabled) {
        closeSocket('pub');
        closeSocket('fam');
        closeSocket('cmp');
        return;
      }
      if (!sockets.pub && state.channel.startsWith('CH')) connectSlot('pub');
      if (state.famGroup?.status === 'approved' && !sockets.fam) connectSlot('fam');
      if (state.cmpGroup?.status === 'approved' && !sockets.cmp) connectSlot('cmp');
      syncStripUi();
    }

    function handleWsJson(slot, msg) {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'presence': {
          nearbyCounts[slot] = Number(msg.nearbyCount || 0);
          if (slot === 'cmp' && Array.isArray(msg.peers)) {
            cmpPeers = msg.peers;
            renderCmpPins();
          }
          syncStripUi();
          break;
        }
        case 'tx_busy': {
          if (txActive) stopTransmit(false);
          playRadioTone('busy');
          toast(`Channel busy: ${msg.by || 'another driver'} is transmitting`, true);
          break;
        }
        case 'driver_ping': {
          flashLed('cmp');
          playRadioTone('rx_break');
          toast(`CMP: ${msg.fromHandle || 'Fleet driver'} is calling you`);
          break;
        }
        case 'rx_clash': {
          const count = Number(msg.count || 0);
          const isCurrent = slot === currentSlot();
          if (isCurrent) {
            rxClashCount = count;
            setClashNoise(count >= 2 && !txActive);
            syncStripUi();
          }
          break;
        }
        case 'rx_start': {
          const distText = Number.isFinite(msg.distanceMi)
            ? `${msg.distanceMi < 1 ? '<1' : Math.round(msg.distanceMi)} mi${msg.direction ? ' ' + msg.direction : ''}`
            : '';
          const key = `${slot}:${msg.slotId || 1}`;
          const meta = {
            handle: msg.handle || 'Driver',
            targetHandle: msg.targetHandle || '',
            channelId: msg.channelId,
            channelLabel: msg.groupType === 'FAM' ? 'FAM' : msg.groupType === 'CMP' ? 'CMP' : formatChannelLabel(msg.channelId),
            groupType: msg.groupType || 'PUB',
            priority: msg.priority || (slot === 'pub' ? 5 : 4),
            distanceText: distText,
            slot,
            slotId: msg.slotId || 1,
          };
          const isTuned = isOnTunedChannel(meta);
          const isPrivate = meta.groupType === 'FAM' || meta.groupType === 'CMP';
          const busyNow = txActive || Boolean(activeRxMeta) || Boolean(replaySource);

          let livePlayback = false;
          if (!state.muted && ttsYieldingPriority !== 1) {
            if (isTuned) {
              livePlayback = true;
            } else if (isPrivate) {
              flashLed(slot);
              playRadioTone(slot === 'cmp' ? 'rx_break_cmp' : 'rx_break');
              const mode = state.bgCallMode || 'queue';
              if (mode === 'breakin') {
                livePlayback = !txActive;
              } else if (mode === 'queue') {
                // Live immediately when tuned channel is quiet; buffer cleanly if mid-call or transmitting
                livePlayback = !busyNow;
                if (!livePlayback) {
                  toast(`${meta.channelLabel}: ${meta.handle} calling (queued)`);
                }
              } else {
                // LED Alert Only: never interrupt; tap pulsing LED to hear & reply
                livePlayback = false;
                toast(`${meta.channelLabel}: ${meta.handle} calling — tap ${meta.channelLabel} LED`);
              }
            }
          }

          rxTalkers.set(key, {
            meta,
            nextTime: 0,
            chunks: [],
            sampleRate: ULAW_RATE,
            lastFrameAt: Date.now(),
            livePlayback,
          });
          if (livePlayback) {
            activeRxMeta = meta;
            notifyAndroidAudio('rx', meta.priority);
          }
          syncStripUi();
          break;
        }
        case 'rx_end': {
          const key = `${slot}:${msg.slotId || 1}`;
          const rec = rxTalkers.get(key);
          rxTalkers.delete(key);
          if (rec && rec.chunks.length) {
            const totalLen = rec.chunks.reduce((a, b) => a + b.length, 0);
            if (totalLen > 400) {
              const merged = new Uint8Array(totalLen);
              let off = 0;
              for (const c of rec.chunks) { merged.set(c, off); off += c.length; }
              const savedBurst = { ...rec.meta, samples: merged, sampleRate: rec.sampleRate || ULAW_RATE, ts: Date.now() };
              replayRing.unshift(savedBurst);
              if (replayRing.length > REPLAY_LIMIT) replayRing.length = REPLAY_LIMIT;
              // If this was a background FAM/CMP call that was buffered instead of played live, enqueue it
              if (!rec.livePlayback && (rec.meta.groupType === 'FAM' || rec.meta.groupType === 'CMP')) {
                enqueueBgCall(savedBurst);
              }
            }
          }
          const anyLiveTalker = [...rxTalkers.values()].find(r => r.livePlayback);
          if (!anyLiveTalker) {
            rxClashCount = 0;
            setClashNoise(false);
            clearTimeout(rxIdleTimer);
            rxIdleTimer = setTimeout(() => {
              const stillLive = [...rxTalkers.values()].find(r => r.livePlayback);
              if (!stillLive && !replaySource) {
                activeRxMeta = null;
                setNeedleAngle(0);
                if (!txActive) notifyAndroidAudio('idle', 5);
                if (rec?.livePlayback && !state.muted && !txActive) playSquelchTail();
                syncStripUi();
                if ((state.bgCallMode || 'queue') === 'queue' && bgQueue.length && !txActive) {
                  setTimeout(() => drainBgQueue(), 260);
                }
              }
            }, 220);
          } else {
            activeRxMeta = anyLiveTalker.meta;
            syncStripUi();
          }
          break;
        }
      }
    }

    function isOnTunedChannel(meta) {
      return (
        (meta.groupType === 'FAM' && state.channel === 'FAM') ||
        (meta.groupType === 'CMP' && state.channel === 'CMP') ||
        (meta.groupType === 'PUB' && state.channel === meta.channelId)
      );
    }

    function privateRank(groupType) {
      const top = state.privatePriority === 'CMP' ? 'CMP' : 'FAM';
      return groupType === top ? 0 : 1;
    }

    function enqueueBgCall(burst) {
      bgQueue.push(burst);
      bgQueue.sort((a, b) => privateRank(a.groupType) - privateRank(b.groupType) || a.ts - b.ts);
      if (bgQueue.length > 4) bgQueue.length = 4;
      flashLed(burst.slot);
      syncStripUi();
    }

    function playBufferedBurst(burst, onDone) {
      const ctx = ensureAudioCtx();
      const master = ensureRxMasterGain();
      if (!ctx || !master || !burst?.samples?.length) {
        onDone?.();
        return false;
      }
      if (replaySource) {
        try { replaySource.stop(); } catch {}
        replaySource = null;
      }
      const floatData = new Float32Array(burst.samples.length);
      for (let i = 0; i < burst.samples.length; i++) floatData[i] = ULAW_DECODE_TABLE[burst.samples[i]];
      const buf = ctx.createBuffer(1, floatData.length, burst.sampleRate || ULAW_RATE);
      buf.copyToChannel(floatData, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(master);
      replaySource = src;
      activeRxMeta = burst;
      notifyAndroidAudio('rx', burst.priority || 4);
      setNeedleAngle(0.55);
      syncStripUi();
      src.onended = () => {
        if (replaySource === src) {
          replaySource = null;
          activeRxMeta = null;
          setNeedleAngle(0);
          if (!txActive) notifyAndroidAudio('idle', 5);
          playSquelchTail();
          syncStripUi();
          onDone?.();
        }
      };
      src.start();
      return true;
    }

    function drainBgQueue(onlySlot = null) {
      if (state.muted || txActive || replaySource || ttsYieldingPriority === 1) return false;
      const liveNow = [...rxTalkers.values()].some(r => r.livePlayback);
      if (liveNow && !onlySlot) return false;
      const idx = onlySlot ? bgQueue.findIndex(b => b.slot === onlySlot) : 0;
      if (idx < 0 || !bgQueue.length) return false;
      const next = bgQueue.splice(idx, 1)[0];
      syncStripUi();
      return playBufferedBurst(next, () => {
        if ((state.bgCallMode || 'queue') === 'queue' && bgQueue.length && !txActive) {
          setTimeout(() => drainBgQueue(), 300);
        }
      });
    }

    function handleLiveRxFrame(slot, bytes) {
      if (!bytes || bytes.length < 5 || bytes[0] !== 0x01) return;
      const senderSlot = bytes[1];
      const rateHundreds = (bytes[2] << 8) | bytes[3];
      const sampleRate = rateHundreds >= 80 && rateHundreds <= 480 ? rateHundreds * 100 : ULAW_RATE;
      const payload = bytes.subarray(4);
      const key = `${slot}:${senderSlot}`;
      let rec = rxTalkers.get(key);
      if (!rec) {
        const meta = {
          handle: 'Driver',
          channelId: state.channel,
          channelLabel: formatChannelLabel(state.channel),
          groupType: slot === 'fam' ? 'FAM' : slot === 'cmp' ? 'CMP' : 'PUB',
          priority: slot === 'pub' ? 5 : 4,
          distanceText: '',
          slot,
          slotId: senderSlot,
        };
        rec = {
          meta,
          nextTime: 0,
          chunks: [],
          sampleRate,
          lastFrameAt: Date.now(),
          livePlayback: isOnTunedChannel(meta) && !state.muted && ttsYieldingPriority !== 1,
        };
        rxTalkers.set(key, rec);
      }
      rec.sampleRate = sampleRate;
      rec.lastFrameAt = Date.now();
      rec.chunks.push(new Uint8Array(payload));

      // If driver switched onto this channel mid-transmission, join live immediately!
      if (!rec.livePlayback && isOnTunedChannel(rec.meta) && !state.muted && ttsYieldingPriority !== 1) {
        rec.livePlayback = true;
      }
      if (!rec.livePlayback || state.muted || ttsYieldingPriority === 1) return;
      activeRxMeta = rec.meta;

      const ctx = ensureAudioCtx();
      const master = ensureRxMasterGain();
      if (!ctx || !master) return;

      const floatData = new Float32Array(payload.length);
      let sumSq = 0;
      for (let i = 0; i < payload.length; i++) {
        const v = ULAW_DECODE_TABLE[payload[i]];
        floatData[i] = v;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / payload.length);
      if (!txActive) setNeedleAngle(Math.min(1, rms * 4.0));

      const audioBuf = ctx.createBuffer(1, floatData.length, sampleRate);
      audioBuf.copyToChannel(floatData, 0);
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(master);

      const now = ctx.currentTime;
      if (rec.nextTime < now + 0.02 || rec.nextTime > now + 0.8) {
        rec.nextTime = now + 0.045; // 45ms jitter cushion for smooth live speech
      }
      src.start(rec.nextTime);
      rec.nextTime += audioBuf.duration;
      syncStripUi();
    }

    function stopRxPlayback(preserveBackgroundBuffers = false) {
      clearTimeout(rxIdleTimer);
      setClashNoise(false);
      if (replaySource) {
        try { replaySource.stop(); } catch {}
        replaySource = null;
      }
      if (preserveBackgroundBuffers) {
        for (const [k, rec] of rxTalkers.entries()) {
          if (rec.meta.slot === 'fam' || rec.meta.slot === 'cmp') {
            rec.livePlayback = false;
          } else {
            rxTalkers.delete(k);
          }
        }
      } else {
        rxTalkers.clear();
      }
      rxClashCount = 0;
      activeRxMeta = null;
      setNeedleAngle(0);
      if (!txActive) notifyAndroidAudio('idle', 5);
      syncStripUi();
    }

    function replayLast() {
      if (!replayRing.length) {
        toast('No recent CB transmission to replay');
        return false;
      }
      const last = replayRing[0];
      toast(`Replaying ${last.handle} (${last.channelLabel})`);
      return playBufferedBurst(last);
    }

    // -------------------------------------------------------------------------
    // Half-Duplex TX (PTT Hold + Quick-Tap Latch + Voice Command + VAD)
    // -------------------------------------------------------------------------
    async function startTransmit({ latched = false, targetHandle = '' } = {}) {
      if (!state.enabled) setEnabled(true);
      if (txActive) return true;
      if (ttsYieldingPriority === 1) {
        toast('Weather alert active — wait before transmitting', true);
        return false;
      }
      const slot = currentSlot();
      if (slot === 'fam' && state.famGroup?.status !== 'approved') {
        openDialog('fam');
        toast('Join or create a Family channel first', true);
        return false;
      }
      if (slot === 'cmp' && state.cmpGroup?.status !== 'approved') {
        openDialog('cmp');
        toast('Join or create a Company channel first', true);
        return false;
      }
      const ws = sockets[slot];
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectSlot(slot);
        toast('Connecting to CB channel… try again in a second', true);
        return false;
      }

      // Suspend Sherpa wake-word engine + duck YouTube before grabbing mic (preserve any background FAM/CMP buffers!)
      stopRxPlayback(true);
      if (window.isRouteWeatherAndroid && window.AndroidRoute?.cbHasMicPermission && !window.AndroidRoute.cbHasMicPermission()) {
        window.atlasCbMicPermission = granted => {
          window.atlasCbMicPermission = null;
          if (granted) toast('Microphone enabled — tap PTT again to transmit');
          else toast('Microphone permission denied in Android', true);
        };
        window.AndroidRoute.cbEnsureMicPermission?.();
        toast('Allow Microphone permission to transmit');
        return false;
      }
      notifyAndroidAudio('tx', currentPriority());
      if (window.isRouteWeatherAndroid) {
        // Give native SherpaWakeWordEngine AudioRecord a brief moment to release the mic cleanly
        await new Promise(r => setTimeout(r, 140));
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        notifyAndroidAudio('idle', 5);
        toast('Microphone unavailable in this browser', true);
        return false;
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err) {
        notifyAndroidAudio('idle', 5);
        const name = err?.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          if (window.isRouteWeatherAndroid && window.AndroidRoute?.cbEnsureMicPermission) {
            window.AndroidRoute.cbEnsureMicPermission();
          }
          toast('Microphone permission needed to transmit', true);
        } else {
          toast(`Mic unavailable (${name || 'busy'}) — try again`, true);
        }
        return false;
      }

      const ctx = ensureAudioCtx();
      if (!ctx) {
        stream.getTracks().forEach(t => t.stop());
        notifyAndroidAudio('idle', 5);
        toast('Web Audio unavailable on this device', true);
        return false;
      }

      txStream = stream;
      txActive = true;
      txLatched = Boolean(latched);
      txTargetHandle = targetHandle || '';
      txStartedAt = Date.now();
      txLastVoiceAt = Date.now();

      playRadioTone('tx_start');
      try {
        ws.send(JSON.stringify({
          type: 'tx_start',
          codec: 'ulaw-12k',
          targetHandle: txTargetHandle,
        }));
      } catch {}

      // Live real-time 12 kHz µ-law streaming capture + VAD silence auto-release
      const srcNode = ctx.createMediaStreamSource(stream);
      const procNode = ctx.createScriptProcessor(2048, 1, 1);
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0; // Prevents mic loopback echo on local speaker
      txSourceNode = srcNode;
      txProcNode = procNode;
      txSilentGain = silentGain;

      const ratio = ctx.sampleRate / ULAW_RATE;
      const rateHundreds = Math.round(ULAW_RATE / 100);
      let resampleCursor = 0;
      let frameBuf = new Uint8Array(4 + TX_FRAME_SAMPLES);
      frameBuf[0] = 0x01;
      frameBuf[1] = 0x00;
      frameBuf[2] = (rateHundreds >> 8) & 0xff;
      frameBuf[3] = rateHundreds & 0xff;
      let frameIdx = 4;

      const flushFrame = () => {
        if (frameIdx <= 4) return;
        const activeWs = sockets[slot];
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          try { activeWs.send(frameBuf.slice(0, frameIdx).buffer); } catch {}
        }
        frameIdx = 4;
      };

      procNode.onaudioprocess = ev => {
        if (!txActive) return;
        const input = ev.inputBuffer.getChannelData(0);
        let sumSq = 0;
        for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i];
        const rms = Math.sqrt(sumSq / input.length);
        setNeedleAngle(Math.min(1, rms * 4.2));

        const now = Date.now();
        if (rms >= VAD_THRESHOLD) {
          txLastVoiceAt = now;
        } else if (txLatched && (now - txStartedAt) > VAD_MIN_SPEECH_MS && (now - txLastVoiceAt) > VAD_SILENCE_MS) {
          flushFrame();
          stopTransmit(true);
          return;
        } else if (!txLatched && (now - txLastVoiceAt) > 6500) {
          // Dead-key protection: auto-unkey if mic is completely silent for 6.5s
          flushFrame();
          toast('Auto-unkeyed after silence');
          stopTransmit(true);
          return;
        }

        // Linear downsample to 12 kHz and encode 8-bit µ-law
        while (resampleCursor < input.length) {
          const i0 = Math.floor(resampleCursor);
          const i1 = Math.min(input.length - 1, i0 + 1);
          const frac = resampleCursor - i0;
          const sample = input[i0] + (input[i1] - input[i0]) * frac;
          frameBuf[frameIdx++] = encodeUlawSample(sample);
          if (frameIdx >= frameBuf.length) flushFrame();
          resampleCursor += ratio;
        }
        resampleCursor -= input.length;
      };

      srcNode.connect(procNode);
      procNode.connect(silentGain);
      silentGain.connect(ctx.destination);

      clearTimeout(txTimer);
      txTimer = setTimeout(() => {
        if (txActive) {
          toast('30s transmit limit reached — standby');
          stopTransmit(true);
        }
      }, MAX_TX_MS);

      clearInterval(txTickTimer);
      txTickTimer = setInterval(syncStripUi, 500);
      syncStripUi();
      return true;
    }

    function stopTransmit(withRoger = true) {
      if (!txActive) return;
      const slot = currentSlot();
      txActive = false;
      txLatched = false;
      txTargetHandle = '';
      clearTimeout(txTimer);
      clearInterval(txTickTimer);

      if (txProcNode) {
        try { txProcNode.onaudioprocess = null; txProcNode.disconnect(); } catch {}
        txProcNode = null;
      }
      if (txSourceNode) {
        try { txSourceNode.disconnect(); } catch {}
        txSourceNode = null;
      }
      if (txSilentGain) {
        try { txSilentGain.disconnect(); } catch {}
        txSilentGain = null;
      }
      if (txStream) {
        txStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        txStream = null;
      }

      const ws = sockets[slot];
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'tx_end' })); } catch {}
      }

      setNeedleAngle(0);
      notifyAndroidAudio('idle', 5);
      if (withRoger) playRadioTone('roger');
      syncStripUi();
      if ((state.bgCallMode || 'queue') === 'queue' && bgQueue.length) {
        setTimeout(() => drainBgQueue(), 320);
      }
    }

    // -------------------------------------------------------------------------
    // CMP Live Truck Pins on Route Atlas Map
    // -------------------------------------------------------------------------
    function renderCmpPins() {
      if (!map || !cmpLayerGroup) return;
      if (!state.enabled || state.cmpGroup?.status !== 'approved' || !cmpPeers.length) {
        cmpLayerGroup.clearLayers();
        cmpMarkers.clear();
        if (map.hasLayer(cmpLayerGroup)) map.removeLayer(cmpLayerGroup);
        return;
      }
      if (!map.hasLayer(cmpLayerGroup)) cmpLayerGroup.addTo(map);
      const myGps = getGps?.();
      const activeIds = new Set();

      for (const peer of cmpPeers) {
        if (!Number.isFinite(peer.lat) || !Number.isFinite(peer.lon)) continue;
        activeIds.add(peer.clientId);
        const heading = Number.isFinite(peer.heading) ? Math.round(peer.heading) : 0;
        const speedTxt = Number.isFinite(peer.speedMph) ? `${Math.round(peer.speedMph)} mph` : 'Stopped';
        const distMi = myGps ? haversineMiles(myGps.lat, myGps.lon, peer.lat, peer.lon) : null;
        const distTxt = distMi !== null ? `${distMi < 1 ? '<1' : Math.round(distMi)} mi away` : '';

        const icon = L.divIcon({
          className: 'cb-truck-pin',
          iconSize: [40, 46],
          iconAnchor: [20, 23],
          html: `<div class="cb-truck-badge">
            <div class="cb-truck-arrow" style="transform:rotate(${heading}deg)">▲</div>
            <div class="cb-truck-dot">🚛</div>
            <span class="cb-truck-name">${escHtml(peer.handle)}</span>
          </div>`,
        });

        const popupHtml = `<div class="cb-truck-popup">
          <strong>${escHtml(peer.handle)}</strong>
          <small>CMP Fleet · ${escHtml(speedTxt)}${distTxt ? ' · ' + escHtml(distTxt) : ''}</small>
          <button type="button" class="cb-pin-radio-btn" data-client-id="${escHtml(peer.clientId)}" data-handle="${escHtml(peer.handle)}">📻 Radio on CMP</button>
        </div>`;

        let marker = cmpMarkers.get(peer.clientId);
        if (marker) {
          marker.setLatLng([peer.lat, peer.lon]);
          marker.setIcon(icon);
          marker.setPopupContent(popupHtml);
        } else {
          marker = L.marker([peer.lat, peer.lon], { icon, zIndexOffset: 400 });
          marker.bindPopup(popupHtml, { maxWidth: 230, className: 'awareness-popup' });
          marker.on('popupopen', () => {
            const btn = document.querySelector(`.cb-pin-radio-btn[data-client-id="${CSS.escape(peer.clientId)}"]`);
            if (btn) {
              btn.onclick = () => {
                marker.closePopup();
                callCmpDriver(peer.clientId, peer.handle);
              };
            }
          });
          marker.addTo(cmpLayerGroup);
          cmpMarkers.set(peer.clientId, marker);
        }
      }

      for (const [id, marker] of cmpMarkers.entries()) {
        if (!activeIds.has(id)) {
          cmpLayerGroup.removeLayer(marker);
          cmpMarkers.delete(id);
        }
      }
    }

    function callCmpDriver(targetClientId, targetHandle) {
      setChannel('CMP');
      const ws = sockets.cmp;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping_driver', targetClientId })); } catch {}
      }
      toast(`Calling ${targetHandle} on CMP…`);
      startTransmit({ latched: true, targetHandle });
    }

    // -------------------------------------------------------------------------
    // Private Group REST API (FAM & CMP invite-code + 1-tap approval)
    // -------------------------------------------------------------------------
    async function apiJson(path, options = {}) {
      const res = await fetch(serverBase() + path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    async function createPrivateGroup(type, name) {
      const data = await apiJson('/api/groups/create', {
        method: 'POST',
        body: JSON.stringify({ type, name, userId: state.userId, handle: state.handle }),
      });
      if (type === 'FAM') state.famGroup = data;
      else state.cmpGroup = data;
      saveState(state);
      connectSlot(type.toLowerCase());
      renderDialog();
      toast(`${type} group created: ${data.inviteCode}`);
      return data;
    }

    async function joinPrivateGroup(type, inviteCode) {
      const data = await apiJson('/api/groups/join', {
        method: 'POST',
        body: JSON.stringify({ inviteCode: inviteCode.trim().toUpperCase(), userId: state.userId, handle: state.handle }),
      });
      if (data.type !== type) {
        // Store under the group's actual type so FAM code goes to FAM and CMP code goes to CMP
        if (data.type === 'FAM') state.famGroup = data;
        else state.cmpGroup = data;
      } else {
        if (type === 'FAM') state.famGroup = data;
        else state.cmpGroup = data;
      }
      saveState(state);
      if (data.status === 'approved') {
        connectSlot(data.type.toLowerCase());
        toast(`Joined ${data.type}: ${data.name}`);
      } else {
        toast(`Join request sent for ${data.name} — waiting for owner approval`);
      }
      renderDialog();
      return data;
    }

    async function pollGroupStatusAndApprovals() {
      if (!state.enabled) return;
      for (const slot of ['fam', 'cmp']) {
        const grp = slot === 'fam' ? state.famGroup : state.cmpGroup;
        if (!grp) continue;
        try {
          if (grp.status === 'pending') {
            const st = await apiJson(`/api/groups/status?groupId=${encodeURIComponent(grp.groupId)}&userId=${encodeURIComponent(state.userId)}`);
            if (st.status === 'approved' && st.memberToken) {
              const updated = { ...grp, ...st };
              if (slot === 'fam') state.famGroup = updated; else state.cmpGroup = updated;
              saveState(state);
              connectSlot(slot);
              flashLed(slot);
              toast(`Approved for ${updated.type}: ${updated.name}!`);
              renderDialog();
            } else if (st.status === 'rejected') {
              if (slot === 'fam') state.famGroup = null; else state.cmpGroup = null;
              saveState(state);
              toast(`Join request declined for ${grp.name}`, true);
              renderDialog();
            }
          } else if (grp.status === 'approved' && grp.memberToken) {
            const info = await apiJson(`/api/groups/pending?groupId=${encodeURIComponent(grp.groupId)}&token=${encodeURIComponent(grp.memberToken)}`);
            const prevCount = pendingApprovals[slot].length;
            pendingApprovals[slot] = Array.isArray(info.pending) ? info.pending : [];
            groupMembers[slot] = Array.isArray(info.approved) ? info.approved : [];
            if (pendingApprovals[slot].length > prevCount) {
              flashLed(slot);
              toast(`${grp.type}: New join request awaiting your 1-tap approval`);
            }
            syncStripUi();
            if ($id('cbRadioDialog')?.open) renderDialog();
          }
        } catch {}
      }
    }

    async function decideApproval(slot, targetUserId, approve) {
      const grp = slot === 'fam' ? state.famGroup : state.cmpGroup;
      if (!grp?.memberToken) return;
      try {
        await apiJson('/api/groups/approve', {
          method: 'POST',
          body: JSON.stringify({
            groupId: grp.groupId,
            token: grp.memberToken,
            targetUserId,
            approve,
          }),
        });
        toast(approve ? 'Driver approved!' : 'Request declined');
        await pollGroupStatusAndApprovals();
        renderDialog();
      } catch (err) {
        toast(err.message || 'Approval failed', true);
      }
    }

    async function leaveGroup(slot) {
      const grp = slot === 'fam' ? state.famGroup : state.cmpGroup;
      if (!grp) return;
      try {
        if (grp.memberToken) {
          await apiJson('/api/groups/leave', {
            method: 'POST',
            body: JSON.stringify({ groupId: grp.groupId, token: grp.memberToken }),
          });
        }
      } catch {}
      closeSocket(slot);
      if (slot === 'fam') state.famGroup = null; else state.cmpGroup = null;
      pendingApprovals[slot] = [];
      groupMembers[slot] = [];
      if (state.channel === slot.toUpperCase()) state.channel = 'CH19';
      saveState(state);
      syncConnections();
      renderDialog();
      toast(`Left ${slot.toUpperCase()} group`);
    }

    // -------------------------------------------------------------------------
    // Public API Controls
    // -------------------------------------------------------------------------
    function setEnabled(next) {
      state.enabled = Boolean(next);
      saveState(state);
      if (!state.enabled) {
        stopTransmit(false);
        stopRxPlayback();
        syncConnections();
        renderCmpPins();
        syncStripUi();
        return;
      }
      syncStripUi();
      syncConnections();
      pollGroupStatusAndApprovals();
    }

    function setChannel(raw) {
      const norm = normalizeChannelId(raw);
      if (!norm) return false;
      if (txActive) stopTransmit(false);
      state.channel = norm;
      if (norm.startsWith('CH') && norm !== 'CH17' && norm !== 'CH19') {
        state.lastCustomChannel = norm;
      }
      saveState(state);
      if (!state.enabled) setEnabled(true);
      if (norm.startsWith('CH')) {
        clearLedPulse('fam');
        clearLedPulse('cmp');
        connectSlot('pub');
        // Ensure background FAM/CMP monitors stay connected while on public/side channels
        if (state.famGroup?.status === 'approved' && (!sockets.fam || sockets.fam.readyState !== WebSocket.OPEN)) connectSlot('fam');
        if (state.cmpGroup?.status === 'approved' && (!sockets.cmp || sockets.cmp.readyState !== WebSocket.OPEN)) connectSlot('cmp');
      } else if (norm === 'FAM') {
        clearLedPulse('fam');
        if (state.famGroup?.status === 'approved') connectSlot('fam');
        else openDialog('fam');
      } else if (norm === 'CMP') {
        clearLedPulse('cmp');
        if (state.cmpGroup?.status === 'approved') connectSlot('cmp');
        else openDialog('cmp');
      }
      syncStripUi();
      if ($id('cbRadioDialog')?.open) renderDialog();
      return true;
    }

    function setRange(miles) {
      const n = Number(miles);
      if (!Number.isFinite(n) || n < 0) return false;
      state.rangeMi = n === 0 ? 0 : Math.min(500, Math.max(1, Math.round(n)));
      saveState(state);
      if (sockets.pub) sendPosPayload(sockets.pub, 'pub');
      syncStripUi();
      if ($id('cbRadioDialog')?.open) renderDialog();
      return true;
    }

    function setMuted(muted) {
      state.muted = Boolean(muted);
      saveState(state);
      if (state.muted) stopRxPlayback();
      syncStripUi();
      if ($id('cbRadioDialog')?.open) renderDialog();
    }

    function updateWxStatus(impacts) {
      const list = Array.isArray(impacts) ? impacts : [];
      const hasExtreme = list.some(i => i?.alert?.level === 'extreme');
      wxState = {
        count: list.length,
        level: hasExtreme ? 'extreme' : (list.length ? 'severe' : 'none'),
      };
      syncStripUi();
    }

    function setWxInterrupt(enabled) {
      state.wxInterrupt = Boolean(enabled);
      saveState(state);
      onWxInterruptChanged?.(state.wxInterrupt);
      if ($id('cbRadioDialog')?.open) renderDialog();
      return state.wxInterrupt;
    }

    function stopWxRadio() {
      wxLoading = false;
      if (!wxPlaying) { syncStripUi(); return; }
      wxPlaying = false;
      try { window.atlasAudio?.stop?.(window.atlasAudio.PRIORITY.EMERGENCY); } catch {}
      playSquelchTail();
      syncStripUi();
    }

    async function fetchNwsWeatherRadioScript(lat, lon) {
      const fetcher = window.routeProviderFetch || window.fetch;
      const headers = { Accept: 'application/geo+json, application/json' };
      const ptRes = await fetcher(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers });
      if (!ptRes.ok) throw new Error('NWS point lookup failed');
      const pt = await ptRes.json();
      const rel = pt?.properties?.relativeLocation?.properties;
      const city = rel?.city || '';
      const st = rel?.state || '';
      const label = [city, st].filter(Boolean).join(', ') || 'your area';

      const parts = [`Atlas Weather Radio for ${label}.`];

      // Lead with any active NWS Severe / Extreme alerts impacting truck or route
      const impacts = typeof getWxImpacts === 'function' ? (getWxImpacts() || []) : [];
      if (impacts.length) {
        const top = impacts[0];
        const scopeWord = top.scope === 'here' ? 'in your current area' : top.scope === 'nearby' ? 'nearby' : 'ahead on your route';
        parts.push(`Active weather alert ${scopeWord}: ${top.alert.event}.`);
        if (top.alert.headline && top.alert.headline !== top.alert.event) {
          parts.push(top.alert.headline.slice(0, 140) + '.');
        }
      }

      // Fetch live station observation + local NWS forecast in parallel
      const stationsUrl = pt?.properties?.observationStations;
      const forecastUrl = pt?.properties?.forecast;
      const [obsText, fcText] = await Promise.all([
        (async () => {
          if (!stationsUrl) return '';
          try {
            const sRes = await fetcher(stationsUrl, { headers });
            if (!sRes.ok) return '';
            const sJson = await sRes.json();
            const firstId = sJson?.features?.[0]?.id;
            if (!firstId) return '';
            const oRes = await fetcher(`${firstId}/observations/latest`, { headers });
            if (!oRes.ok) return '';
            const o = (await oRes.json())?.properties;
            if (!o) return '';
            const bits = [];
            if (Number.isFinite(o.temperature?.value)) {
              bits.push(`${Math.round(o.temperature.value * 9 / 5 + 32)} degrees`);
            }
            if (o.textDescription) bits.push(o.textDescription.toLowerCase());
            if (Number.isFinite(o.windSpeed?.value) && o.windSpeed.value > 0) {
              const mph = Math.round(o.windSpeed.value * 0.621371);
              const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
              const dir = Number.isFinite(o.windDirection?.value) ? dirs[Math.round(((o.windDirection.value % 360) / 45)) % 8] + ' ' : '';
              bits.push(`wind ${dir}at ${mph} miles per hour`);
            }
            if (Number.isFinite(o.windGust?.value) && o.windGust.value > 0) {
              bits.push(`gusting to ${Math.round(o.windGust.value * 0.621371)}`);
            }
            if (Number.isFinite(o.visibility?.value) && o.visibility.value < 16000) {
              const visMi = Math.max(0.25, Math.round((o.visibility.value / 1609.34) * 4) / 4);
              bits.push(`visibility ${visMi} miles`);
            }
            return bits.length ? `Currently ${bits.join(', ')}.` : '';
          } catch { return ''; }
        })(),
        (async () => {
          if (!forecastUrl) return '';
          try {
            const fRes = await fetcher(forecastUrl, { headers });
            if (!fRes.ok) return '';
            const periods = (await fRes.json())?.properties?.periods || [];
            return periods.slice(0, 2).map(p => `${p.name}: ${p.shortForecast}, ${p.isDaytime ? 'high' : 'low'} near ${p.temperature}.`).join(' ');
          } catch { return ''; }
        })(),
      ]);

      if (obsText) parts.push(obsText);
      if (fcText) parts.push(fcText);
      if (!impacts.length) parts.push('No severe trucker weather alerts active.');
      return { label, script: parts.join(' ').slice(0, 580) };
    }

    async function toggleWxRadio() {
      if (wxPlaying || wxLoading) {
        stopWxRadio();
        return;
      }
      if (!state.enabled) setEnabled(true);
      const gps = getGps?.();
      const center = map?.getCenter?.();
      const lat = Number.isFinite(gps?.lat) ? gps.lat : center?.lat;
      const lon = Number.isFinite(gps?.lon) ? gps.lon : center?.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        toast('Waiting for location for WX Weather Radio', true);
        return;
      }
      playRadioTone(wxState.count ? 'wx_alert' : 'tx_start');
      wxLoading = true;
      syncStripUi();
      try {
        let result;
        const cacheFresh = wxCache && (Date.now() - wxCache.ts < 180_000)
          && haversineMiles(lat, lon, wxCache.lat, wxCache.lon) < 10;
        if (cacheFresh) {
          result = wxCache;
        } else {
          const fetched = await fetchNwsWeatherRadioScript(lat, lon);
          wxCache = { lat, lon, ts: Date.now(), ...fetched };
          result = wxCache;
        }
        if (!wxLoading) return; // user cancelled while fetching
        wxLoading = false;
        wxPlaying = true;
        wxStationLabel = result.label;
        syncStripUi();
        if (window.atlasAudio?.speak) {
          window.atlasAudio.speak(result.script, {
            priority: window.atlasAudio.PRIORITY.VOICE_CMD,
            key: 'wx-radio:' + Date.now(),
            interrupt: true,
            pauseMedia: false,
          });
        } else {
          wxPlaying = false;
          syncStripUi();
          toast(result.script);
        }
      } catch {
        wxLoading = false;
        wxPlaying = false;
        syncStripUi();
        toast('Could not reach NOAA NWS right now', true);
      }
    }

    function onAtlasAudioEvent(event, priority) {
      if (event === 'start' && priority <= 2) {
        ttsYieldingPriority = priority;
        if (priority === 1 && txActive) {
          stopTransmit(false);
          toast('TX yielded for emergency weather alert', true);
        }
        if (priority === 1) {
          stopRxPlayback();
        } else if (rxMasterGain) {
          rxMasterGain.gain.value = 0.22;
        }
      } else if (event === 'done' || event === 'error' || event === 'idle') {
        ttsYieldingPriority = 0;
        if (wxPlaying && (event === 'done' || event === 'error' || event === 'idle')) {
          wxPlaying = false;
          playSquelchTail();
          syncStripUi();
        }
        if (rxMasterGain) rxMasterGain.gain.value = 1.0;
      }
    }

    // -------------------------------------------------------------------------
    // Dialog UI Rendering
    // -------------------------------------------------------------------------
    function openDialog(tab = 'channels') {
      activeDialogTab = tab;
      const dlg = $id('cbRadioDialog');
      if (!dlg) return;
      renderDialog();
      if (!dlg.open) dlg.showModal();
    }

    function renderGroupTab(slot) {
      const type = slot.toUpperCase();
      const grp = slot === 'fam' ? state.famGroup : state.cmpGroup;
      const label = type === 'FAM' ? 'Family' : 'Company Fleet';

      if (!grp) {
        return `
          <p class="cb-help">Private ${label} channel with invite-code &amp; 1-tap owner approval.${type === 'CMP' ? ' Includes live fleet truck pins directly on the Route Atlas map.' : ''}</p>
          <div class="cb-card">
            <h3>Create ${label} Channel</h3>
            <div class="cb-stack">
              <input id="cbNewGroupName" type="text" maxlength="40" placeholder="${type === 'FAM' ? 'e.g. Smith Family' : 'e.g. Sierra Freight'}">
              <button type="button" id="cbCreateGroupBtn" class="primary">Create ${label} Channel</button>
            </div>
          </div>
          <div class="cb-card">
            <h3>Join with Invite Code</h3>
            <div class="cb-stack">
              <input id="cbJoinCodeInput" type="text" maxlength="16" placeholder="${type}-XXXXXX" autocapitalize="characters">
              <button type="button" id="cbJoinGroupBtn">Request Join</button>
            </div>
          </div>
        `;
      }

      if (grp.status === 'pending') {
        return `
          <div class="cb-card">
            <h3>${escHtml(grp.name)} (${type})</h3>
            <p class="cb-help">Invite code <strong>${escHtml(grp.inviteCode)}</strong> — waiting for the owner to tap Approve…</p>
            <div class="cb-actions-2">
              <button type="button" id="cbCheckApprovalBtn">Check Status</button>
              <button type="button" id="cbLeaveGroupBtn">Cancel Request</button>
            </div>
          </div>
        `;
      }

      const pending = pendingApprovals[slot] || [];
      const members = groupMembers[slot] || [];
      const pendingHtml = pending.length
        ? `<div class="cb-card cb-pending-card">
            <h3>Pending Approvals (${pending.length})</h3>
            ${pending.map(p => `
              <div class="cb-member-row">
                <span>${escHtml(p.handle)}</span>
                <div class="cb-row-tight">
                  <button type="button" class="cb-approve-btn primary" data-uid="${escHtml(p.user_id)}">Approve</button>
                  <button type="button" class="cb-deny-btn" data-uid="${escHtml(p.user_id)}">Deny</button>
                </div>
              </div>
            `).join('')}
          </div>`
        : '';

      const cmpPinHtml = type === 'CMP'
        ? `<label class="cb-toggle-row"><input type="checkbox" id="cbSharePinChk" ${state.shareCmpPin ? 'checked' : ''}> Share my truck pin on map (${cmpPeers.length} other truck${cmpPeers.length === 1 ? '' : 's'} visible)</label>`
        : '';

      return `
        <div class="cb-card">
          <div class="cb-row-between">
            <div>
              <h3>${escHtml(grp.name)}</h3>
              <small class="cb-muted">Invite Code: <strong id="cbInviteCodeVal">${escHtml(grp.inviteCode)}</strong> · Global Range</small>
            </div>
            <button type="button" id="cbCopyCodeBtn">Copy Code</button>
          </div>
          ${cmpPinHtml}
          <div class="cb-actions-2" style="margin-top:8px">
            <button type="button" id="cbTuneGroupBtn" class="primary">Tune to ${type}</button>
            <button type="button" id="cbLeaveGroupBtn">Leave</button>
          </div>
        </div>
        ${pendingHtml}
        <div class="cb-card">
          <h3>Approved Members (${members.length || 1})</h3>
          <div class="cb-member-list">
            ${(members.length ? members : [{ handle: state.handle, role: grp.role }]).map(m =>
              `<div class="cb-member-row"><span>${escHtml(m.handle)}</span><small class="cb-muted">${escHtml(m.role)}</small></div>`
            ).join('')}
          </div>
        </div>
      `;
    }

    function renderDialog() {
      const body = $id('cbDialogBody');
      if (!body) return;
      document.querySelectorAll('#cbDialogTabs button').forEach(b => {
        b.classList.toggle('active', b.dataset.cbtab === activeDialogTab);
      });

      if (activeDialogTab === 'channels') {
        const customVal = state.channel.startsWith('CH') && state.channel !== 'CH17' && state.channel !== 'CH19'
          ? state.channel.slice(2)
          : (state.lastCustomChannel ? state.lastCustomChannel.slice(2) : '');
        const lastCustomChip = state.lastCustomChannel
          ? `<button type="button" class="cb-pill ${state.channel === state.lastCustomChannel ? 'active' : ''}" data-ch="${escHtml(state.lastCustomChannel)}" style="margin-top:8px">Side Channel: ${escHtml(formatChannelLabel(state.lastCustomChannel))}<small>Tap to jump back</small></button>`
          : '';
        body.innerHTML = `
          <div class="cb-section-title">Channel</div>
          <div class="cb-grid-4">
            <button type="button" class="cb-pill ${state.channel === 'CH17' ? 'active' : ''}" data-ch="CH17">CH 17<small>I-5 / West</small></button>
            <button type="button" class="cb-pill ${state.channel === 'CH19' ? 'active' : ''}" data-ch="CH19">CH 19<small>Interstate</small></button>
            <button type="button" class="cb-pill cb-pill-fam ${state.channel === 'FAM' ? 'active' : ''}" data-ch="FAM">FAM<small>${state.famGroup?.status === 'approved' ? 'Connected' : 'Setup'}</small></button>
            <button type="button" class="cb-pill cb-pill-cmp ${state.channel === 'CMP' ? 'active' : ''}" data-ch="CMP">CMP<small>${state.cmpGroup?.status === 'approved' ? 'Connected' : 'Setup'}</small></button>
          </div>
          ${lastCustomChip}
          <div class="cb-row" style="margin-top:8px">
            <input id="cbCustomChanInput" type="number" min="1" max="999" placeholder="Custom CH # (1–999)" value="${escHtml(customVal)}">
            <button type="button" id="cbCustomChanBtn">Tune #</button>
          </div>
          <div class="cb-section-title" style="margin-top:10px">Reception Range (Public Channels)</div>
          <div class="cb-grid-4">
            ${[10, 30, 100, 0].map(r => `
              <button type="button" class="cb-pill ${state.rangeMi === r ? 'active' : ''}" data-range="${r}">${r === 0 ? 'Global' : r + ' mi'}</button>
            `).join('')}
          </div>
          <div class="cb-actions-2" style="margin-top:10px">
            <button type="button" id="cbMuteToggleBtn">${state.muted ? '🔇 Unmute CB' : '🔊 Mute / Squelch'}</button>
            <button type="button" id="cbReplayBtn" ${replayRing.length ? '' : 'disabled'}>↺ Say Again (${replayRing.length})</button>
          </div>
        `;
        body.querySelectorAll('[data-ch]').forEach(btn => {
          btn.onclick = () => setChannel(btn.dataset.ch);
        });
        body.querySelectorAll('[data-range]').forEach(btn => {
          btn.onclick = () => setRange(Number(btn.dataset.range));
        });
        const customBtn = $id('cbCustomChanBtn');
        if (customBtn) {
          customBtn.onclick = () => {
            const val = $id('cbCustomChanInput')?.value;
            if (!setChannel(val)) toast('Enter a channel number from 1 to 999', true);
          };
        }
        if ($id('cbMuteToggleBtn')) $id('cbMuteToggleBtn').onclick = () => setMuted(!state.muted);
        if ($id('cbReplayBtn')) $id('cbReplayBtn').onclick = () => replayLast();
        return;
      }

      if (activeDialogTab === 'fam' || activeDialogTab === 'cmp') {
        const slot = activeDialogTab;
        const type = slot.toUpperCase();
        body.innerHTML = renderGroupTab(slot);
        if ($id('cbCreateGroupBtn')) {
          $id('cbCreateGroupBtn').onclick = async () => {
            const name = $id('cbNewGroupName')?.value.trim() || (type === 'FAM' ? 'My Family' : 'My Fleet');
            try { await createPrivateGroup(type, name); } catch (e) { toast(e.message, true); }
          };
        }
        if ($id('cbJoinGroupBtn')) {
          $id('cbJoinGroupBtn').onclick = async () => {
            const code = $id('cbJoinCodeInput')?.value.trim();
            if (!code) { toast('Enter an invite code', true); return; }
            try { await joinPrivateGroup(type, code); } catch (e) { toast(e.message, true); }
          };
        }
        if ($id('cbCheckApprovalBtn')) $id('cbCheckApprovalBtn').onclick = () => pollGroupStatusAndApprovals();
        if ($id('cbLeaveGroupBtn')) $id('cbLeaveGroupBtn').onclick = () => leaveGroup(slot);
        if ($id('cbTuneGroupBtn')) $id('cbTuneGroupBtn').onclick = () => { setChannel(type); $id('cbRadioDialog')?.close(); };
        if ($id('cbCopyCodeBtn')) {
          $id('cbCopyCodeBtn').onclick = () => {
            const code = $id('cbInviteCodeVal')?.textContent || '';
            navigator.clipboard?.writeText(code).then(() => toast('Invite code copied: ' + code)).catch(() => toast(code));
          };
        }
        if ($id('cbSharePinChk')) {
          $id('cbSharePinChk').onchange = e => {
            state.shareCmpPin = Boolean(e.target.checked);
            saveState(state);
            if (sockets.cmp) sendPosPayload(sockets.cmp, 'cmp');
          };
        }
        body.querySelectorAll('.cb-approve-btn').forEach(b => {
          b.onclick = () => decideApproval(slot, b.dataset.uid, true);
        });
        body.querySelectorAll('.cb-deny-btn').forEach(b => {
          b.onclick = () => decideApproval(slot, b.dataset.uid, false);
        });
        return;
      }

      // Settings tab
      const bgMode = state.bgCallMode || 'queue';
      const pri = state.privatePriority === 'CMP' ? 'CMP' : 'FAM';
      body.innerHTML = `
        <div class="cb-card">
          <label for="cbHandleInput">CB Handle</label>
          <div class="cb-stack">
            <input id="cbHandleInput" type="text" maxlength="24" value="${escHtml(state.handle)}">
            <button type="button" id="cbSaveHandleBtn" class="primary">Save Handle</button>
          </div>
          <label class="cb-toggle-row"><input type="checkbox" id="cbRogerChk" ${state.rogerBeep ? 'checked' : ''}> Subtle radio squelch &amp; roger beep</label>
          <label class="cb-toggle-row"><input type="checkbox" id="cbWxInterruptChk" ${state.wxInterrupt ? 'checked' : ''}> WX Auto-Interrupt &amp; Speak urgent alerts (off = Tone + Flash WX LED)</label>
        </div>
        <div class="cb-card">
          <h3>Background Calls (FAM / CMP)</h3>
          <select id="cbBgModeSelect">
            <option value="queue" ${bgMode === 'queue' ? 'selected' : ''}>Smart Queue (Wait for clear, live if standby)</option>
            <option value="alert" ${bgMode === 'alert' ? 'selected' : ''}>LED + Chime Only (Tap LED to hear)</option>
            <option value="breakin" ${bgMode === 'breakin' ? 'selected' : ''}>Instant Break-In (Cut in live)</option>
          </select>
          <label for="cbPrioritySelect" style="margin-top:4px">Private Channel Priority</label>
          <select id="cbPrioritySelect">
            <option value="FAM" ${pri === 'FAM' ? 'selected' : ''}>FAM over CMP</option>
            <option value="CMP" ${pri === 'CMP' ? 'selected' : ''}>CMP over FAM</option>
          </select>
        </div>
        <div class="cb-card">
          <h3>Hands-Free "Router" Voice Commands</h3>
          <p class="cb-help">"Router, channel 19" · "Router, channel 22" · "Router, family channel" · "Router, company channel" · "Router, range 30 miles" · "Router, transmit" · "Router, say again"</p>
        </div>
      `;
      if ($id('cbSaveHandleBtn')) {
        $id('cbSaveHandleBtn').onclick = async () => {
          const next = ($id('cbHandleInput')?.value || '').trim().slice(0, 24);
          if (!next) return;
          state.handle = next;
          saveState(state);
          for (const slot of ['pub', 'fam', 'cmp']) {
            if (sockets[slot]) sendPosPayload(sockets[slot], slot);
          }
          for (const grp of [state.famGroup, state.cmpGroup]) {
            if (grp?.groupId && grp?.memberToken) {
              try {
                await apiJson('/api/groups/update-handle', {
                  method: 'POST',
                  body: JSON.stringify({ groupId: grp.groupId, token: grp.memberToken, handle: next }),
                });
              } catch {}
            }
          }
          await pollGroupStatusAndApprovals();
          toast('CB handle saved: ' + next);
        };
      }
      if ($id('cbRogerChk')) {
        $id('cbRogerChk').onchange = e => { state.rogerBeep = Boolean(e.target.checked); saveState(state); };
      }
      if ($id('cbWxInterruptChk')) {
        $id('cbWxInterruptChk').onchange = e => {
          setWxInterrupt(Boolean(e.target.checked));
          toast(state.wxInterrupt ? 'WX Alerts: Interrupt & Speak' : 'WX Alerts: Tone + Flash LED Only');
        };
      }
      if ($id('cbBgModeSelect')) {
        $id('cbBgModeSelect').onchange = e => {
          state.bgCallMode = e.target.value;
          saveState(state);
          toast('Background calls: ' + (state.bgCallMode === 'queue' ? 'Smart Queue' : state.bgCallMode === 'alert' ? 'LED Alert Only' : 'Instant Break-In'));
        };
      }
      if ($id('cbPrioritySelect')) {
        $id('cbPrioritySelect').onchange = e => {
          state.privatePriority = e.target.value === 'CMP' ? 'CMP' : 'FAM';
          saveState(state);
          toast(`Priority: ${state.privatePriority === 'CMP' ? 'CMP over FAM' : 'FAM over CMP'}`);
        };
      }
    }

    // -------------------------------------------------------------------------
    // Bind Strip & Dialog DOM events
    // -------------------------------------------------------------------------
    function bindDom() {
      const chanBtn = $id('cbChanBtn');
      if (chanBtn) chanBtn.onclick = () => openDialog('channels');

      const meterBtn = $id('cbMeterBtn');
      if (meterBtn) meterBtn.onclick = () => replayLast();

      const famLed = $id('cbLedFam');
      if (famLed) {
        famLed.onclick = () => {
          if (pendingApprovals.fam.length || state.famGroup?.status !== 'approved') {
            openDialog('fam');
          } else {
            setChannel('FAM');
            drainBgQueue('fam');
          }
        };
      }

      const cmpLed = $id('cbLedCmp');
      if (cmpLed) {
        cmpLed.onclick = () => {
          if (pendingApprovals.cmp.length || state.cmpGroup?.status !== 'approved') {
            openDialog('cmp');
          } else {
            setChannel('CMP');
            drainBgQueue('cmp');
          }
        };
      }

      const wxLed = $id('cbLedWx');
      if (wxLed) {
        wxLed.onclick = () => {
          toggleWxRadio();
          if (typeof onWxTap === 'function' && wxState.count) onWxTap();
        };
      }

      // PTT button: hold-to-talk (>350ms) OR quick-tap-to-latch (<350ms with VAD silence auto-release)
      const pttBtn = $id('cbPttBtn');
      if (pttBtn) {
        pttBtn.addEventListener('pointerdown', ev => {
          ev.preventDefault();
          pttPointerId = ev.pointerId;
          try { pttBtn.setPointerCapture(ev.pointerId); } catch {}
          if (txActive) {
            // Tapping while latched stops TX immediately
            pttDownAt = 0;
            stopTransmit(true);
            return;
          }
          pttDownAt = Date.now();
          startTransmit({ latched: false });
        });
        const onRelease = ev => {
          if (pttPointerId !== null && ev.pointerId !== pttPointerId) return;
          pttPointerId = null;
          if (!pttDownAt || !txActive) return;
          const heldMs = Date.now() - pttDownAt;
          pttDownAt = 0;
          if (heldMs < 350) {
            // Quick tap -> switch into hands-free latched mode with VAD auto-release
            txLatched = true;
            txLastVoiceAt = Date.now();
            syncStripUi();
          } else {
            stopTransmit(true);
          }
        };
        pttBtn.addEventListener('pointerup', onRelease);
        pttBtn.addEventListener('pointercancel', onRelease);
      }

      document.querySelectorAll('#cbDialogTabs button').forEach(b => {
        b.onclick = () => {
          activeDialogTab = b.dataset.cbtab;
          renderDialog();
        };
      });

      const closeBtn = $id('cbDialogClose');
      if (closeBtn) closeBtn.onclick = () => $id('cbRadioDialog')?.close();

      // Periodic GPS & keepalive check (also auto-heals any dropped background FAM/CMP monitor)
      posInterval = setInterval(() => {
        if (!state.enabled) return;
        syncConnections();
        for (const slot of ['pub', 'fam', 'cmp']) {
          if (sockets[slot]?.readyState === WebSocket.OPEN) sendPosPayload(sockets[slot], slot);
        }
      }, 8000);

      approvalPollInterval = setInterval(() => {
        if (state.enabled) pollGroupStatusAndApprovals();
      }, 15000);

      syncStripUi();
      if (state.enabled) {
        syncConnections();
        pollGroupStatusAndApprovals();
      }
    }

    bindDom();

    return {
      isEnabled: () => state.enabled,
      getState: () => ({ ...state }),
      setEnabled,
      toggle: () => setEnabled(!state.enabled),
      setChannel,
      setRange,
      setMuted,
      startTransmit: () => startTransmit({ latched: true }),
      stopTransmit: () => stopTransmit(true),
      replayLast,
      openDialog,
      updateWxStatus,
      toggleWxRadio,
      stopWxRadio,
      isWxInterruptEnabled: () => Boolean(state.wxInterrupt),
      setWxInterrupt,
      playWxTone: () => playRadioTone('wx_alert'),
      onAtlasAudioEvent,
      destroy() {
        clearInterval(posInterval);
        clearInterval(approvalPollInterval);
        stopTransmit(false);
        stopRxPlayback();
        closeSocket('pub');
        closeSocket('fam');
        closeSocket('cmp');
      },
    };
  }

  globalThis.atlasCbRadio = {
    createController,
    normalizeChannelId,
    formatChannelLabel,
    formatRangeLabel,
  };
})();
