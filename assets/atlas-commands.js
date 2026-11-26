(() => {
  'use strict';

  // Fuzzy wake-word regex covering common on-device ASR transcriptions of "Router" / "Atlas"
  const WAKE_WORD_RE = /^(?:(?:hey|ok|okay|yo)\s+)?(?:router|route\s*her|rowter|rauter|roter|routa|outer|louder|route\s*atlas|atlas)\b[\s,.:;!?-]*/i;

  const WORD_NUMBERS = {
    zero: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
    fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
    twenty: '20', thirty: '30', forty: '40', fifty: '50', hundred: '100',
  };

  function normalizeNumbers(text) {
    return String(text || '').replace(
      /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)\b/gi,
      m => WORD_NUMBERS[m.toLowerCase()] || m
    );
  }

  function cleanPhrase(text) {
    return String(text || '')
      .replace(/[’']/g, "'")
      .replace(/[.!?,;:]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Parse a spoken transcript into a deterministic Route Weather command.
   * Supports natural synonyms, fuzzy wake-word matching, and both single-shot & sequential modes.
   */
  function parseCommand(rawTranscript, { requireWakeWord = false } = {}) {
    if (!rawTranscript || typeof rawTranscript !== 'string') return null;
    const trimmed = cleanPhrase(rawTranscript);
    if (!trimmed) return null;

    const hasWake = WAKE_WORD_RE.test(trimmed);
    if (requireWakeWord && !hasWake) return null;

    let body = hasWake ? cleanPhrase(trimmed.replace(WAKE_WORD_RE, '')) : trimmed;
    if (!body) {
      return hasWake ? { action: 'wake', label: 'Listening…' } : null;
    }

    // Strip polite filler prefixes like "please", "can you", "could you"
    body = cleanPhrase(body.replace(/^(?:please|can\s+you|could\s+you|go\s+ahead\s+and)\s+/i, ''));
    const lower = body.toLowerCase();
    const normNum = normalizeNumbers(lower);

    // 1. Trip planning & destination
    let m = body.match(/^(?:(?:set\s+)?destination(?:\s+to)?|navigate(?:\s+me)?\s+to|route(?:\s+me)?\s+to|drive(?:\s+me)?\s+to|go\s+to|take\s+me\s+to|head\s+to|directions\s+to)\s+(.+)$/i);
    if (m && m[1].trim()) {
      const dest = cleanPhrase(m[1]);
      return { action: 'destination', value: dest, label: 'Destination: ' + dest };
    }
    if (/^(?:plan(?:\s+a)?\s+(?:trip|route)|open\s+(?:trip\s+)?planner|trip\s+planner|new\s+(?:trip|route)|change\s+destination)$/.test(lower)) {
      return { action: 'plan_trip', label: 'Trip planner' };
    }
    if (/^(?:start\s+(?:navigation|route|driving|trip)|calculate\s+route|begin\s+(?:navigation|route)|let's\s+go|go)$/.test(lower)) {
      return { action: 'start_navigation', label: 'Start navigation' };
    }
    if (/^(?:clear|cancel|stop|end|delete|remove|exit)\s+(?:the\s+)?(?:route|navigation|trip)$/.test(lower)) {
      return { action: 'clear_route', label: 'Clear route' };
    }

    // 2. YouTube / Entertainment controls (natural verbs!)
    if (/^(?:open|show|start|launch|enable|turn\s+on|bring\s+up)\s+(?:the\s+)?(?:youtube|entertainment|media\s+bar|video\s+player)$/.test(lower)
      || /^(?:entertainment|youtube)\s+on$/.test(lower)) {
      return { action: 'media_show', label: 'Entertainment on' };
    }
    if (/^(?:close|exit|hide|quit|dismiss|shut|shut\s+down|disable|turn\s+off|get\s+rid\s+of)\s+(?:the\s+)?(?:youtube|entertainment|media\s+bar|video\s+player)$/.test(lower)
      || /^(?:entertainment|youtube)\s+off$/.test(lower)) {
      return { action: 'media_hide', label: 'Entertainment off' };
    }
    if (/^(?:pause|stop|freeze|hold)\s+(?:the\s+)?(?:youtube|video|videos|music|media|playback|entertainment|playing)$/.test(lower)
      || /^(?:pause|stop\s+playing|pause\s+it)$/.test(lower)) {
      return { action: 'media_pause', label: 'Media paused' };
    }
    if (/^(?:play|resume|unpause|continue)\s+(?:the\s+)?(?:youtube|video|videos|music|media|playback|entertainment)$/.test(lower)
      || /^(?:play|resume|unpause|play\s+it)$/.test(lower)) {
      return { action: 'media_play', label: 'Media playing' };
    }
    if (/^(?:next|skip)(?:\s+(?:track|video|song|one))?$/.test(lower)) {
      return { action: 'media_next', label: 'Next track' };
    }
    if (/^(?:previous|prev|last|go\s+back)(?:\s+(?:track|video|song|one))?$/.test(lower)) {
      return { action: 'media_prev', label: 'Previous track' };
    }
    if (/^(?:expand|maximize|bigger|show)\s+(?:the\s+)?video$/.test(lower)) {
      return { action: 'media_expand', label: 'Video expanded' };
    }
    if (/^(?:minimize|collapse|shrink|smaller|hide)\s+(?:the\s+)?video$/.test(lower)) {
      return { action: 'media_collapse', label: 'Video minimized' };
    }

    // 3. Voice guidance / directions
    if (/^(?:mute|silence|quiet|stop|disable|turn\s+off|shut\s+off)\s+(?:the\s+)?(?:directions|voice|guidance|voice\s+directions|spoken\s+directions|navigation\s+voice)$/.test(lower)
      || /^(?:mute|be\s+quiet|shut\s+up)$/.test(lower)) {
      return { action: 'voice_off', label: 'Directions muted' };
    }
    if (/^(?:unmute|enable|turn\s+on|resume)\s+(?:the\s+)?(?:directions|voice|guidance|voice\s+directions|spoken\s+directions)$/.test(lower)
      || /^unmute$/.test(lower)) {
      return { action: 'voice_on', label: 'Directions on' };
    }

    // 4. Map layers, radar, alerts, zoom, follow, theme
    if (/^(?:hide|close|turn\s+off|disable|exit)\s+(?:the\s+)?(?:weather\s+)?radar$/.test(lower) || /^radar\s+off$/.test(lower)) {
      return { action: 'radar_off', label: 'Radar off' };
    }
    if (/^(?:(?:show|open|turn\s+on|toggle|enable)\s+)?(?:the\s+)?(?:weather\s+)?radar(?:\s+on)?$/.test(lower)) {
      return { action: 'radar_toggle', label: 'Radar toggled' };
    }
    if (/^(?:(?:show|open|turn\s+on|toggle|hide|close|turn\s+off)\s+)?(?:the\s+)?traffic(?:\s+(?:on|off))?$/.test(lower)) {
      return { action: 'traffic_toggle', label: 'Traffic toggled' };
    }
    if (/^(?:(?:show|find|open|toggle|hide|nearby)\s+)?(?:the\s+)?(?:truck\s+stops|fuel\s+stops)$/.test(lower)) {
      return { action: 'truck_stops', label: 'Truck stops' };
    }
    if (/^(?:(?:show|find|open|toggle|hide)\s+)?(?:the\s+)?(?:weigh\s+stations|truck\s+scales|scales)$/.test(lower)) {
      return { action: 'scales', label: 'Weigh stations' };
    }
    if (/^(?:(?:show|find|open|toggle|hide)\s+)?(?:the\s+)?(?:rest\s+areas|rest\s+stops)$/.test(lower)) {
      return { action: 'rest_areas', label: 'Rest areas' };
    }
    if (/^(?:dismiss|clear|hide|close|exit)\s+(?:the\s+)?(?:weather\s+|emergency\s+)?alerts?$/.test(lower)) {
      return { action: 'alert_dismiss', label: 'Alert dismissed' };
    }
    if (/^(?:show|view|open)\s+(?:the\s+)?(?:weather\s+|emergency\s+)?(?:alerts?|area)$/.test(lower)
      || /^(?:weather\s+alert|emergency\s+alerts?)$/.test(lower)) {
      return { action: 'alert_show', label: 'Show alert area' };
    }
    if (/^(?:zoom\s+in|closer|zoom\s+closer)$/.test(lower)) {
      return { action: 'zoom_in', label: 'Zoom in' };
    }
    if (/^(?:zoom\s+out|farther|further|back\s+out)$/.test(lower)) {
      return { action: 'zoom_out', label: 'Zoom out' };
    }
    if (/^(?:follow\s+me|center\s+gps|center\s+map|recenter|my\s+location|back\s+to\s+drive|track\s+me)$/.test(lower)) {
      return { action: 'follow_me', label: 'Follow GPS' };
    }
    if (/^(?:day\s+mode|light\s+mode|daytime)$/.test(lower)) {
      return { action: 'theme_day', label: 'Day mode' };
    }
    if (/^(?:night\s+mode|dark\s+mode|nighttime)$/.test(lower)) {
      return { action: 'theme_night', label: 'Night mode' };
    }

    // 5. CB Radio channels & controls (Phase 4)
    if (/^(?:family\s+channel|switch\s+to\s+family|channel\s+family|go\s+to\s+family)$/.test(lower)) {
      return { action: 'cb_channel', value: 'FAM', label: 'CB: Family' };
    }
    if (/^(?:company\s+channel|switch\s+to\s+company|channel\s+company|fleet\s+channel|go\s+to\s+company)$/.test(lower)) {
      return { action: 'cb_channel', value: 'CMP', label: 'CB: Company' };
    }
    m = normNum.match(/^(?:(?:switch\s+to|go\s+to)\s+)?(?:cb\s+)?channel\s+(\d{1,3})$/i);
    if (m) {
      return { action: 'cb_channel', value: 'CH ' + m[1], label: 'CB: Channel ' + m[1] };
    }
    m = normNum.match(/^(?:(?:set\s+)?(?:cb\s+)?range\s+(?:to\s+)?)(\d{1,3})\s*(?:mi|miles?)?$/i);
    if (m) {
      return { action: 'cb_range', value: Number(m[1]), label: 'CB Range: ' + m[1] + ' mi' };
    }
    if (/^(?:transmit|key\s+mic|talk\s+on\s+cb|open\s+mic|key\s+up)$/.test(lower)) {
      return { action: 'cb_tx_start', label: 'CB Transmit' };
    }
    if (/^(?:end\s+transmission|stop\s+transmitting|over\s+and\s+out|close\s+mic|stop\s+talking)$/.test(lower)) {
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
      const candidates = Array.isArray(transcript) ? transcript : [transcript];
      let wakeMatch = null;
      for (const candidate of candidates) {
        const cmd = parseCommand(candidate, options);
        if (!cmd) continue;
        if (cmd.action === 'wake') {
          if (!wakeMatch) wakeMatch = cmd;
          continue;
        }
        const result = dispatch(cmd);
        return { matched: true, ...result, cmd, transcript: candidate };
      }
      if (wakeMatch) {
        handlers.wake?.();
        return { matched: true, ok: true, wakeOnly: true, cmd: wakeMatch, transcript: candidates[0] || '' };
      }
      return { matched: false, ok: false, transcript: candidates[0] || '' };
    }

    return { dispatch, handleTranscript, parseCommand };
  }

  globalThis.atlasCommands = {
    parseCommand,
    createDispatcher,
  };
})();
