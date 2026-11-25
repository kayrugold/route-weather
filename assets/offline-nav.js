(() => {
  const MODE_KEY = 'route-weather-offline-nav-mode';       // 'auto' | 'online' | 'offline'
  const PROFILE_KEY = 'route-weather-offline-nav-profile'; // 'car' | 'truck'
  const listeners = new Set();

  function getBridge() {
    return window.AndroidRoute && typeof window.AndroidRoute.offlineStatus === 'function'
      ? window.AndroidRoute
      : null;
  }

  function getMode() {
    try {
      const val = localStorage.getItem(MODE_KEY);
      if (val === 'online' || val === 'offline' || val === 'auto') return val;
    } catch {}
    return 'auto';
  }

  function setMode(mode) {
    if (!['auto', 'online', 'offline'].includes(mode)) return;
    try { localStorage.setItem(MODE_KEY, mode); } catch {}
    notify({ type: 'mode', mode });
  }

  function getProfile() {
    try {
      const val = localStorage.getItem(PROFILE_KEY);
      if (val === 'car' || val === 'truck') return val;
    } catch {}
    return 'car';
  }

  function setProfile(profile) {
    if (!['car', 'truck'].includes(profile)) return;
    try { localStorage.setItem(PROFILE_KEY, profile); } catch {}
    notify({ type: 'profile', profile });
  }

  function getStatus() {
    const bridge = getBridge();
    if (!bridge) {
      return { available: false, hasTiles: false, hasRouting: false, hasSearch: false, availableBytes: 0, installedBytes: 0, packages: [] };
    }
    try {
      const parsed = JSON.parse(bridge.offlineStatus() || '{}');
      return { available: true, ...parsed };
    } catch {
      return { available: true, hasTiles: false, hasRouting: false, hasSearch: false, availableBytes: 0, installedBytes: 0, packages: [] };
    }
  }

  function isOnline() {
    const bridge = getBridge();
    if (bridge && typeof bridge.hasInternet === 'function') {
      try { return Boolean(bridge.hasInternet()); } catch {}
    }
    return navigator.onLine !== false;
  }

  function shouldUseOffline(kind) {
    const status = getStatus();
    if (!status.available) return false;
    const hasCap = kind === 'tiles' ? status.hasTiles : kind === 'route' ? status.hasRouting : status.hasSearch;
    if (!hasCap) return false;
    const mode = getMode();
    if (mode === 'offline') return true;
    if (mode === 'online') return false;
    return !isOnline();
  }

  const pendingRoutes = new Map();
  let nextRouteReq = 0;

  window.routeWeatherOfflineRouteReply = (reqId, raw) => {
    const resolve = pendingRoutes.get(reqId);
    if (!resolve) return;
    pendingRoutes.delete(reqId);
    resolve(parseRouteResponse(raw));
  };

  function parseRouteResponse(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.error) return Response.json(parsed, { status: 404 });
      return Response.json(parsed, { status: 200 });
    } catch {
      return Response.json({ error: 'Offline router returned an invalid response.' }, { status: 500 });
    }
  }

  function route(searchParams) {
    const bridge = getBridge();
    if (!bridge) return Promise.resolve(Response.json({ error: 'Offline routing requires Android.' }, { status: 503 }));
    const coords = searchParams.get('coords') || '';
    const profile = searchParams.get('profile') || getProfile();
    if (typeof bridge.offlineRouteAsync === 'function') {
      return new Promise(resolve => {
        const id = ++nextRouteReq;
        pendingRoutes.set(id, resolve);
        try {
          bridge.offlineRouteAsync(id, coords, profile);
        } catch {
          pendingRoutes.delete(id);
          resolve(Response.json({ error: 'Offline router failed to start.' }, { status: 500 }));
        }
      });
    }
    return Promise.resolve(parseRouteResponse(bridge.offlineRoute(coords, profile)));
  }

  function search(searchParams) {
    const bridge = getBridge();
    if (!bridge) return Response.json({ error: 'Offline search requires Android.' }, { status: 503 });
    const mode = searchParams.get('mode') || '';
    if (mode === 'facilities') {
      const kind = searchParams.get('kind') || 'truck-stops';
      const parts = (searchParams.get('bbox') || '').split(',').map(Number);
      const offset = Number(searchParams.get('offset') || 0);
      if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
        return Response.json({ error: 'Invalid map bounds.' }, { status: 400 });
      }
      const raw = bridge.offlineFacilities(kind, parts[0], parts[1], parts[2], parts[3], offset);
      return new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const q = searchParams.get('q') || '';
    const lat = searchParams.has('lat') ? Number(searchParams.get('lat')) : NaN;
    const lon = searchParams.has('lon') ? Number(searchParams.get('lon')) : NaN;
    const raw = bridge.offlineSearch(q, mode, lat, lon, 10);
    return new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  function nearestRoad(searchParams) {
    const lat = Number(searchParams.get('lat'));
    const lon = Number(searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: 'Invalid coordinates.' }, { status: 400 });
    }
    const bridge = getBridge();
    if (bridge && typeof bridge.offlineNearestRoad === 'function') {
      const raw = bridge.offlineNearestRoad(lat, lon);
      return new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return Response.json({ lat, lon, label: `Waypoint (${lat.toFixed(4)}, ${lon.toFixed(4)})`, hint: false });
  }

  function downloadPackage(pkgSpec) {
    const bridge = getBridge();
    if (!bridge) throw Error('Offline map downloads require the Android app.');
    bridge.offlineDownloadPackage(typeof pkgSpec === 'string' ? pkgSpec : JSON.stringify(pkgSpec));
  }

  function pauseDownload(packageId) {
    getBridge()?.offlinePauseDownload(packageId);
  }

  function deletePackage(packageId) {
    return Boolean(getBridge()?.offlineDeletePackage(packageId));
  }

  function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify(event) {
    for (const fn of listeners) {
      try { fn(event); } catch {}
    }
  }

  window.routeWeatherOfflineEvent = event => notify({ type: 'progress', ...event });
  window.routeWeatherOfflineChanged = () => {
    notify({ type: 'installed-changed', status: getStatus() });
    if (typeof window.refreshDownloadedMap === 'function') {
      try { window.refreshDownloadedMap(); } catch {}
    }
  };

  window.routeWeatherOffline = {
    getMode,
    setMode,
    getProfile,
    setProfile,
    getStatus,
    shouldUseOffline,
    route,
    search,
    nearestRoad,
    downloadPackage,
    pauseDownload,
    deletePackage,
    onEvent,
  };
})();
