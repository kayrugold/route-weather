(() => {
  'use strict';

  const NWS_ALERTS_URL =
    'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update&severity=Extreme,Severe&urgency=Immediate,Expected&region_type=land';
  const POLL_INTERVAL_MS = 4 * 60 * 1000;
  const MAX_RENDERED_POLYGONS = 24;
  const ROUTE_CORRIDOR_KM = 18; // ~11.2 miles
  const PREF_KEY = 'route-weather-emergency-alerts';

  const EXTREME_EVENTS = new Set([
    'Tornado Warning',
    'Flash Flood Warning',
    'Extreme Wind Warning',
    'Blizzard Warning',
    'Dust Storm Warning',
    'Ice Storm Warning',
    'Civil Emergency Message',
    'Evacuation Immediate',
    'Shelter In Place Warning',
    'Hazardous Materials Warning',
    'Avalanche Warning',
    'Tsunami Warning',
    'Earthquake Warning',
  ]);

  const SEVERE_TRUCKER_EVENTS = new Set([
    'Severe Thunderstorm Warning',
    'High Wind Warning',
    'Winter Storm Warning',
    'Snow Squall Warning',
    'Flood Warning',
    'Fire Warning',
    'Red Flag Warning',
    'Freeze Warning',
    'Tornado Watch',
    'Severe Thunderstorm Watch',
    'Blizzard Watch',
    'Winter Storm Watch',
    'Dust Advisory',
    'High Wind Watch',
  ]);

  const IGNORED_KEYWORDS = [
    'marine', 'small craft', 'rip current', 'beach', 'surf', 'coastal flood',
    'gale', 'lakeshore', 'air quality', 'heat advisory', 'frost advisory',
  ];

  function classifyAlert(props) {
    if (!props || !props.event) return null;
    const event = String(props.event).trim();
    const lower = event.toLowerCase();
    for (const skip of IGNORED_KEYWORDS) {
      if (lower.includes(skip)) return null;
    }
    const severity = String(props.severity || '').trim();
    const urgency = String(props.urgency || '').trim();
    const status = String(props.status || 'Actual').trim();
    const msgType = String(props.messageType || 'Alert').trim();
    if (status !== 'Actual' || msgType === 'Cancel') return null;

    if (EXTREME_EVENTS.has(event) || severity === 'Extreme') {
      return { level: 'extreme', rank: 1 };
    }
    if (SEVERE_TRUCKER_EVENTS.has(event) && (severity === 'Severe' || severity === 'Extreme')) {
      return { level: 'severe', rank: 2 };
    }
    if (severity === 'Severe' && urgency === 'Immediate' && /warning/i.test(event)) {
      return { level: 'severe', rank: 2 };
    }
    return null;
  }

  function extractRings(geometry) {
    if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return [];
    if (geometry.type === 'Polygon') {
      return geometry.coordinates.length ? [geometry.coordinates[0]] : [];
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.map(poly => poly[0]).filter(r => Array.isArray(r) && r.length >= 3);
    }
    return [];
  }

  function computeBbox(rings) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const ring of rings) {
      for (const pt of ring) {
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const lon = pt[0], lat = pt[1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (!Number.isFinite(minLon)) return null;
    return [minLon, minLat, maxLon, maxLat];
  }

  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > lat) !== (yj > lat))
        && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInAlert(lon, lat, alert) {
    if (!alert.bbox) return false;
    const [minLon, minLat, maxLon, maxLat] = alert.bbox;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return false;
    return alert.rings.some(ring => pointInRing(lon, lat, ring));
  }

  function approxKm(lon1, lat1, lon2, lat2) {
    const dLat = (lat2 - lat1) * 111.0;
    const dLon = (lon2 - lon1) * 111.0 * Math.cos(((lat1 + lat2) * 0.5) * Math.PI / 180);
    return Math.hypot(dLat, dLon);
  }

  function pointNearAlert(lon, lat, alert, corridorKm) {
    if (!alert.bbox) return false;
    const padDeg = corridorKm / 95;
    const [minLon, minLat, maxLon, maxLat] = alert.bbox;
    if (lon < minLon - padDeg || lon > maxLon + padDeg || lat < minLat - padDeg || lat > maxLat + padDeg) {
      return false;
    }
    if (pointInAlert(lon, lat, alert)) return true;
    for (const ring of alert.rings) {
      for (let i = 0; i < ring.length; i++) {
        if (approxKm(lon, lat, ring[i][0], ring[i][1]) <= corridorKm) return true;
      }
    }
    return false;
  }

  function parseNwsAlerts(geojson, nowMs = Date.now()) {
    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    const parsed = [];
    const seenIds = new Set();
    for (const feature of features) {
      const props = feature?.properties;
      const cls = classifyAlert(props);
      if (!cls) continue;
      const expiresMs = Date.parse(props.ends || props.expires || '');
      if (Number.isFinite(expiresMs) && expiresMs < nowMs) continue;
      const id = String(props.id || feature.id || (props.event + ':' + (props.sent || '')));
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const rings = extractRings(feature.geometry);
      if (!rings.length) continue; // Only map-renderable polygon alerts
      const bbox = computeBbox(rings);
      if (!bbox) continue;
      parsed.push({
        id,
        event: String(props.event).trim(),
        headline: String(props.headline || props.event).trim(),
        areaDesc: String(props.areaDesc || '').trim(),
        instruction: String(props.instruction || '').trim(),
        severity: String(props.severity || ''),
        urgency: String(props.urgency || ''),
        level: cls.level,
        rank: cls.rank,
        expiresMs: Number.isFinite(expiresMs) ? expiresMs : null,
        rings,
        bbox,
      });
    }
    return parsed.sort((a, b) => a.rank - b.rank || (a.expiresMs || Infinity) - (b.expiresMs || Infinity));
  }

  function evaluateImpacts(alerts, { gps, routeCoords } = {}) {
    const impacts = [];
    // Subsample long routes to at most ~120 vertices for instant O(1) ms checks
    let sampledRoute = null;
    if (Array.isArray(routeCoords) && routeCoords.length) {
      const step = Math.max(1, Math.floor(routeCoords.length / 120));
      sampledRoute = [];
      for (let i = 0; i < routeCoords.length; i += step) sampledRoute.push(routeCoords[i]);
      sampledRoute.push(routeCoords[routeCoords.length - 1]);
    }

    for (const alert of alerts) {
      let scope = null;
      if (gps && Number.isFinite(gps.lon) && Number.isFinite(gps.lat)) {
        if (pointInAlert(gps.lon, gps.lat, alert)) scope = 'here';
        else if (pointNearAlert(gps.lon, gps.lat, alert, 8)) scope = 'nearby';
      }
      if (!scope && sampledRoute) {
        for (const pt of sampledRoute) {
          if (pointNearAlert(pt[0], pt[1], alert, ROUTE_CORRIDOR_KM)) {
            scope = 'route';
            break;
          }
        }
      }
      if (scope) {
        impacts.push({ alert, scope });
      }
    }
    const scopeRank = { here: 0, nearby: 1, route: 2 };
    return impacts.sort((a, b) =>
      a.alert.rank - b.alert.rank || scopeRank[a.scope] - scopeRank[b.scope]
    );
  }

  function selectVisibleAlerts(alerts, bounds, limit = MAX_RENDERED_POLYGONS) {
    if (!bounds) return alerts.slice(0, limit);
    const { west, south, east, north } = bounds;
    const overlapping = alerts.filter(a => {
      const [minLon, minLat, maxLon, maxLat] = a.bbox;
      return maxLon >= west && minLon <= east && maxLat >= south && minLat <= north;
    });
    return overlapping.slice(0, limit);
  }

  function buildSpokenSummary(impact) {
    if (!impact?.alert) return '';
    const { alert, scope } = impact;
    const prefix = scope === 'here'
      ? 'Emergency weather alert in your current area. '
      : scope === 'nearby'
        ? 'Emergency weather alert nearby. '
        : 'Emergency weather alert ahead along your route. ';
    return prefix + alert.event + '. Check the map for the affected area.';
  }

  function createMapController(opts) {
    const { map, getGps, getRouteCoords, onSpeak, onRestoreView } = opts;
    const canvasRenderer = typeof L !== 'undefined' ? L.canvas({ padding: 0.3 }) : null;
    const layerGroup = typeof L !== 'undefined' ? L.layerGroup() : null;

    let enabled = true;
    try {
      const saved = localStorage.getItem(PREF_KEY);
      if (saved === 'off') enabled = false;
    } catch {}

    let alerts = [];
    let activeImpacts = [];
    let dismissedIds = new Set();
    let spokenIds = new Set();
    let pollTimer = null;
    let inFlight = false;
    let viewingAlertId = null;
    let savedView = null;
    let renderedKey = '';
    let popupOpen = false;

    const bannerEl = document.getElementById('wxAlertBanner');
    const titleEl = document.getElementById('wxAlertTitle');
    const detailEl = document.getElementById('wxAlertDetail');
    const viewBtn = document.getElementById('wxAlertViewBtn');
    const dismissBtn = document.getElementById('wxAlertDismissBtn');
    const badgeBtn = document.getElementById('wxAlertBadge');
    const layerToggle = document.getElementById('layerEmergencyAlerts');

    function syncLayerToggle() {
      if (!layerToggle) return;
      layerToggle.classList.toggle('active', enabled);
      layerToggle.setAttribute('aria-pressed', String(enabled));
    }

    function renderPolygons(force = false) {
      if (!layerGroup || !map) return;
      if (!enabled || !alerts.length) {
        renderedKey = '';
        popupOpen = false;
        layerGroup.clearLayers();
        if (map.hasLayer(layerGroup)) map.removeLayer(layerGroup);
        return;
      }
      // Never wipe and rebuild polygons while the driver is reading an open alert popup
      if (popupOpen && !force) return;
      const b = map.getBounds();
      const visible = selectVisibleAlerts(alerts, {
        west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(),
      });
      const nextKey = visible.map(a => a.id).join('|');
      if (!force && nextKey === renderedKey && map.hasLayer(layerGroup)) return;
      renderedKey = nextKey;
      layerGroup.clearLayers();
      if (!map.hasLayer(layerGroup)) layerGroup.addTo(map);
      for (const alert of visible) {
        const isExtreme = alert.level === 'extreme';
        const color = isExtreme ? '#ff6b6b' : '#f2ce75';
        const fillColor = isExtreme ? '#ff4d4d' : '#f2b84b';
        const latLngs = alert.rings.map(ring => ring.map(pt => [pt[1], pt[0]]));
        const poly = L.polygon(latLngs, {
          renderer: canvasRenderer,
          color,
          weight: isExtreme ? 2.5 : 1.8,
          opacity: 0.92,
          fillColor,
          fillOpacity: isExtreme ? 0.24 : 0.16,
          interactive: true,
        });
        const exp = alert.expiresMs
          ? new Date(alert.expiresMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : '';
        const safeEvent = alert.event.replace(/</g, '&lt;');
        const safeArea = alert.areaDesc.slice(0, 140).replace(/</g, '&lt;');
        const safeInstr = alert.instruction.slice(0, 200).replace(/</g, '&lt;');
        poly.bindPopup(
          `<strong style="color:${color}">${safeEvent}</strong>` +
          (exp ? `<br><small>Until ${exp}</small>` : '') +
          (safeArea ? `<br><small>${safeArea}</small>` : '') +
          (safeInstr ? `<p style="margin:6px 0 0;font-size:12px">${safeInstr}</p>` : ''),
          { maxWidth: 280, autoPanPadding: [24, 60] }
        );
        poly.on('popupopen', () => { popupOpen = true; });
        poly.on('popupclose', () => { popupOpen = false; });
        poly.addTo(layerGroup);
      }
    }

    function updateUi() {
      const undismissed = activeImpacts.filter(i => !dismissedIds.has(i.alert.id));
      const top = undismissed[0] || null;

      if (badgeBtn) {
        const count = activeImpacts.length;
        badgeBtn.hidden = !enabled || count === 0;
        const hasExtreme = activeImpacts.some(i => i.alert.level === 'extreme');
        badgeBtn.classList.toggle('extreme', hasExtreme);
        badgeBtn.classList.toggle('severe', !hasExtreme && count > 0);
        badgeBtn.textContent = count > 1 ? `WX ${count}` : 'WX';
        badgeBtn.title = count ? `${count} active trucker weather alert(s)` : 'Weather alerts clear';
      }

      if (!bannerEl) return;
      if (!enabled || !top) {
        bannerEl.hidden = true;
        return;
      }
      const { alert, scope } = top;
      bannerEl.hidden = false;
      bannerEl.classList.toggle('extreme', alert.level === 'extreme');
      bannerEl.classList.toggle('severe', alert.level !== 'extreme');
      const scopeLabel = scope === 'here' ? 'IN YOUR AREA' : scope === 'nearby' ? 'NEARBY' : 'ON YOUR ROUTE';
      if (titleEl) titleEl.textContent = `${alert.event} · ${scopeLabel}`;
      if (detailEl) {
        const exp = alert.expiresMs
          ? 'Until ' + new Date(alert.expiresMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : '';
        detailEl.textContent = [exp, alert.areaDesc].filter(Boolean).join(' — ');
      }
      if (viewBtn) {
        viewBtn.textContent = viewingAlertId === alert.id ? 'Back to Drive' : 'Show Area';
      }
    }

    function recomputeImpacts(allowSpeech) {
      if (!enabled) {
        activeImpacts = [];
        updateUi();
        return;
      }
      activeImpacts = evaluateImpacts(alerts, {
        gps: getGps?.(),
        routeCoords: getRouteCoords?.(),
      });
      updateUi();
      if (allowSpeech && activeImpacts.length) {
        const top = activeImpacts[0];
        if (!spokenIds.has(top.alert.id) && !dismissedIds.has(top.alert.id)) {
          spokenIds.add(top.alert.id);
          onSpeak?.(buildSpokenSummary(top), top.alert);
        }
      }
    }

    async function refresh(allowSpeech = true) {
      if (!enabled || inFlight || document.hidden) return;
      if (window.isRouteWeatherAndroid && window.AndroidRoute?.hasInternet && !window.AndroidRoute.hasInternet()) {
        return;
      }
      inFlight = true;
      try {
        const fetcher = window.routeProviderFetch || window.fetch;
        const res = await fetcher(NWS_ALERTS_URL, {
          headers: { Accept: 'application/geo+json, application/json' },
        });
        if (!res.ok) return;
        const data = await res.json();
        alerts = parseNwsAlerts(data);
        renderPolygons();
        recomputeImpacts(allowSpeech);
      } catch {
        // Silent fail when offline or NWS is temporarily unreachable
      } finally {
        inFlight = false;
      }
    }

    function setEnabled(next) {
      enabled = Boolean(next);
      try { localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off'); } catch {}
      syncLayerToggle();
      if (!enabled) {
        viewingAlertId = null;
        if (layerGroup && map?.hasLayer(layerGroup)) map.removeLayer(layerGroup);
        updateUi();
        return;
      }
      renderPolygons();
      recomputeImpacts(false);
      if (!alerts.length) void refresh(true);
    }

    if (viewBtn) {
      viewBtn.onclick = () => {
        const top = activeImpacts.find(i => !dismissedIds.has(i.alert.id));
        if (!top || !map) return;
        if (viewingAlertId === top.alert.id) {
          viewingAlertId = null;
          if (savedView) {
            map.setView(savedView.center, savedView.zoom, { animate: true });
            savedView = null;
          }
          onRestoreView?.();
          updateUi();
          return;
        }
        savedView = { center: map.getCenter(), zoom: map.getZoom() };
        viewingAlertId = top.alert.id;
        const [minLon, minLat, maxLon, maxLat] = top.alert.bbox;
        const bounds = L.latLngBounds([[minLat, minLon], [maxLat, maxLon]]);
        const gps = getGps?.();
        if (gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon)) {
          bounds.extend([gps.lat, gps.lon]);
        }
        map.fitBounds(bounds.pad(0.18), { animate: true, maxZoom: 11 });
        updateUi();
      };
    }

    if (dismissBtn) {
      dismissBtn.onclick = () => {
        const top = activeImpacts.find(i => !dismissedIds.has(i.alert.id));
        if (top) dismissedIds.add(top.alert.id);
        viewingAlertId = null;
        updateUi();
      };
    }

    if (badgeBtn) {
      badgeBtn.onclick = () => {
        dismissedIds.clear();
        updateUi();
      };
    }

    if (layerToggle) {
      layerToggle.onclick = () => setEnabled(!enabled);
    }

    if (map) {
      map.on('moveend', () => { if (enabled && alerts.length) renderPolygons(); });
    }

    syncLayerToggle();
    if (enabled) {
      setTimeout(() => void refresh(true), 2500);
    }
    pollTimer = setInterval(() => void refresh(true), POLL_INTERVAL_MS);

    return {
      refresh,
      recomputeImpacts,
      setEnabled,
      isEnabled: () => enabled,
      getActiveImpacts: () => activeImpacts.slice(),
      destroy() { if (pollTimer) clearInterval(pollTimer); },
    };
  }

  globalThis.routeEmergencyAlerts = {
    classifyAlert,
    parseNwsAlerts,
    evaluateImpacts,
    selectVisibleAlerts,
    buildSpokenSummary,
    createMapController,
  };
})();
