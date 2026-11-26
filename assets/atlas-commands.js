(() => {
  'use strict';

  const WAKE_WORD_RE = /^(?:hey\s+|ok(?:ay)?\s+)?(?:router|route\s*atlas|atlas)\b[\s,.:;-]*/i;

  const WORD_NUMBERS = {
    zero: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
    fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
    twenty: '20', thirty: '30', forty: '40', fifty: '50', hundred: '100',
  };

  function normalizeNumbers(text) {
    return String(text || '').replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)\b/gi,
      m => WORD_NUMBERS[m.toLowerCase()] || m);
  }

  /**
   * Parse a spoken transcript into a deterministic Route Weather command.
   * Supports both wake-prefixed ("Router, pause YouTube") and direct ("pause YouTube") forms,
   * plus wake-only ("Router") to trigger sequential listening.
   */
  function parseCommand(rawTranscript, { requireWakeWord = false } = {}) {
    if (!rawTranscript || typeof rawTranscript !== 'string') return null;
    const trimmed = rawTranscript.trim();
    if (!trimmed) return null;

    const hasWake = WAKE_WORD_RE.test(trimmed);
    if (requireWakeWord && !hasWake) return null;

    const body = hasWake ? trimmed.replace(WAKE_WORD_RE, '').trim() : trimmed;
    if (!body) {
      return hasWake ? { action: 'wake', label: 'Listening…' } : null;
    }

    const lower = body.toLowerCase().replace(/[.!?]+$/g, '').trim();
    const normNum = normalizeNumbers(lower);

    // 1. Trip planning & destination
    let m = body.match(/^(?:set\s+)?(?:destination|navigate\s+to|route\s+to|drive\s+to|go\s+to|take\s+me\s+to)\s+(.+)$/i);
    if (m && m[1].trim()) {
      const dest = m[1].trim().replace(/[.!?]+$/, '');
      return { action: 'destination', value: dest, label: 'Destination: ' + dest };
    }
    if (/^(?:plan(?:\s+a)?\s+trip|open\s+planner|plan\s+route|trip\s+planner)$/.test(lower)) {
      return { action: 'plan_trip', label: 'Trip planner' };
    }
    if (/^(?:start\s+navigation|start\s+route|calculate\s+route|go|begin\s+navigation|start\s+driving)$/.test(lower)) {
      return { action: 'start_navigation', label: 'Start navigation' };
    }
    if (/^(?:clear\s+route|cancel\s+route|stop\s+navigation|end\s+trip)$/.test(lower)) {
      return { action: 'clear_route', label: 'Clear route' };
    }

    // 2. YouTube / Entertainment media controls
    if (/^(?:stop|pause)\s+(?:youtube|video|music|media|playback|entertainment)$/.test(lower) || /^(?:pause|stop\s+playing)$/.test(lower)) {
      return { action: 'media_pause', label: 'Media paused' };
    }
    if (/^(?:play|resume|start)\s+(?:youtube|video|music|media|playback|entertainment)$/.test(lower) || /^(?:play|resume)$/.test(lower)) {
      return { action: 'media_play', label: 'Media playing' };
    }
    if (/^(?:next|skip)(?:\s+(?:track|video|song))?$/.test(lower)) {
      return { action: 'media_next', label: 'Next track' };
    }
    if (/^(?:previous|prev|back|last)\s+(?:track|video|song)$/.test(lower)) {
      return { action: 'media_prev', label: 'Previous track' };
    }
    if (/^(?:show|open)\s+(?:youtube|entertainment)$/.test(lower)) {
      return { action: 'media_show', label: 'YouTube on' };
    }
    if (/^(?:hide|close)\s+(?:youtube|entertainment)$/.test(lower)) {
      return { action: 'media_hide', label: 'YouTube hidden' };
    }

    // 3. Voice guidance / directions
    if (/^(?:mute|stop|silence|disable|turn\s+off)\s+(?:directions|voice|guidance|voice\s+directions)$/.test(lower)) {
      return { action: 'voice_off', label: 'Directions muted' };
    }
    if (/^(?:unmute|enable|turn\s+on)\s+(?:directions|voice|guidance|voice\s+directions)$/.test(lower)) {
      return { action: 'voice_on', label: 'Directions on' };
    }

    // 4. Map layers, radar, alerts, zoom, follow, theme
    if (/^(?:weather\s+radar|toggle\s+radar|show\s+radar|radar(?:\s+on)?)$/.test(lower)) {
      return { action: 'radar_toggle', label: 'Radar toggled' };
    }
    if (/^(?:hide|turn\s+off|close)\s+(?:weather\s+)?radar$/.test(lower)) {
      return { action: 'radar_off', label: 'Radar off' };
    }
    if (/^(?:show\s+traffic|toggle\s+traffic|traffic)$/.test(lower)) {
      return { action: 'traffic_toggle', label: 'Traffic toggled' };
    }
    if (/^(?:show\s+truck\s+stops|find\s+truck\s+stops|truck\s+stops)$/.test(lower)) {
      return { action: 'truck_stops', label: 'Truck stops' };
    }
    if (/^(?:show\s+weigh\s+stations|weigh\s+stations|scales)$/.test(lower)) {
      return { action: 'scales', label: 'Weigh stations' };
    }
    if (/^(?:dismiss\s+alert|clear\s+alert|hide\s+alert|close\s+alert)$/.test(lower)) {
      return { action: 'alert_dismiss', label: 'Alert dismissed' };
    }
    if (/^(?:show\s+alert|view\s+alert|show\s+area|weather\s+alert|emergency\s+alerts?)$/.test(lower)) {
      return { action: 'alert_show', label: 'Show alert area' };
    }
    if (/^(?:zoom\s+in|closer)$/.test(lower)) {
      return { action: 'zoom_in', label: 'Zoom in' };
    }
    if (/^(?:zoom\s+out|farther|further)$/.test(lower)) {
      return { action: 'zoom_out', label: 'Zoom out' };
    }
    if (/^(?:follow\s+me|center\s+gps|center\s+map|my\s+location|back\s+to\s+drive)$/.test(lower)) {
      return { action: 'follow_me', label: 'Follow GPS' };
    }
    if (/^(?:day\s+mode|light\s+mode)$/.test(lower)) {
      return { action: 'theme_day', label: 'Day mode' };
    }
    if (/^(?:night\s+mode|dark\s+mode)$/.test(lower)) {
      return { action: 'theme_night', label: 'Night mode' };
    }

    // 5. CB Radio channels & controls (ready for Phase 4)
    if (/^(?:family\s+channel|switch\s+to\s+family|channel\s+family)$/.test(lower)) {
      return { action: 'cb_channel', value: 'FAM', label: 'CB: Family' };
    }
    if (/^(?:company\s+channel|switch\s+to\s+company|channel\s+company|fleet\s+channel)$/.test(lower)) {
      return { action: 'cb_channel', value: 'CMP', label: 'CB: Company' };
    }
    m = normNum.match(/^(?:cb\s+)?channel\s+(\d{1,3})$/i);
    if (m) {
      return { action: 'cb_channel', value: 'CH ' + m[1], label: 'CB: Channel ' + m[1] };
    }
    m = normNum.match(/^(?:cb\s+)?range\s+(\d{1,3})\s*(?:mi|miles?)?$/i);
    if (m) {
      return { action: 'cb_range', value: Number(m[1]), label: 'CB Range: ' + m[1] + ' mi' };
    }
    if (/^(?:transmit|key\s+mic|talk\s+on\s+cb|open\s+mic)$/.test(lower)) {
      return { action: 'cb_tx_start', label: 'CB Transmit' };
    }
    if (/^(?:end\s+transmission|stop\s+transmitting|over\s+and\s+out|close\s+mic)$/.test(lower)) {
      return { action: 'cb_tx_stop', label: 'CB Standby' };
    }

    return null;
  }

  function createDispatcher(handlers = {}) {
    function dispatch(cmd) {
      if (!cmd || !cmd.action) return { ok: false, message: 'Unknown command' };
      const fn = handlers[cmd.action];
      if (typeof fn !== 'function') {
        return { ok: false, message: 'Not available yet: ' + (cmd.label || cmd.action) };
      }
      try {
        const res = fn(cmd.value, cmd);
        if (res === false) return { ok: false, message: cmd.label || cmd.action };
        return { ok: true, label: cmd.label || cmd.action };
      } catch (err) {
        return { ok: false, message: String(err?.message || err || 'Command failed') };
      }
    }

    function handleTranscript(transcript, options) {
      const cmd = parseCommand(transcript, options);
      if (!cmd) return { matched: false, ok: false, transcript };
      if (cmd.action === 'wake') {
        handlers.wake?.();
        return { matched: true, ok: true, wakeOnly: true, cmd };
      }
      const result = dispatch(cmd);
      return { matched: true, ...result, cmd };
    }

    return { dispatch, handleTranscript, parseCommand };
  }

  globalThis.atlasCommands = {
    parseCommand,
    createDispatcher,
  };
})();
