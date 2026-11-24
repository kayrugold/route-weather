import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadOfflineNav(bridge, online = true) {
  const storage = new Map();
  const context = {
    window: {},
    navigator: { onLine: online },
    localStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
    },
    Response,
    URLSearchParams,
    AndroidRoute: bridge,
  };
  context.window = context;
  const code = fs.readFileSync(new URL('../../assets/offline-nav.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, context);
  return context.routeWeatherOffline;
}

test('offline-nav switches cleanly between online, auto, and offline modes and car/truck profiles', async () => {
  const calls = [];
  const bridge = {
    offlineStatus: () => JSON.stringify({ hasTiles: true, hasRouting: true, hasSearch: true, installedBytes: 123456 }),
    offlineRoute: (coords, profile) => {
      calls.push({ kind: 'route', coords, profile });
      return JSON.stringify({ code: 'Ok', provider: 'offline-brouter', profile, routes: [{ distance: 315000, duration: 11400 }] });
    },
    offlineSearch: (q, mode, lat, lon, limit) => {
      calls.push({ kind: 'search', q, mode, lat, lon, limit });
      return JSON.stringify([{ lat: 40.4482, lon: -122.2978, display_name: 'Anderson, CA', category: 'place' }]);
    },
    offlineFacilities: () => JSON.stringify({ items: [], total: 0, offset: 0 }),
  };

  const nav = loadOfflineNav(bridge, true);
  assert.equal(nav.getMode(), 'auto');
  assert.equal(nav.shouldUseOffline('route'), false); // online in auto mode

  nav.setMode('offline');
  assert.equal(nav.shouldUseOffline('route'), true);
  assert.equal(nav.shouldUseOffline('tiles'), true);
  assert.equal(nav.shouldUseOffline('search'), true);

  nav.setProfile('truck');
  assert.equal(nav.getProfile(), 'truck');
  const routeRes = nav.route(new URLSearchParams({ coords: '-122.2978,40.4482;-121.2908,37.9577' }));
  assert.equal(routeRes.status, 200);
  const routeJson = await routeRes.json();
  assert.equal(routeJson.provider, 'offline-brouter');
  assert.equal(routeJson.profile, 'truck');

  const searchRes = nav.search(new URLSearchParams({ q: 'Anderson, CA' }));
  assert.equal(searchRes.status, 200);
  const places = await searchRes.json();
  assert.equal(places[0].display_name, 'Anderson, CA');
});

test('offline-nav automatically uses offline data in auto mode when device is offline', () => {
  const bridge = {
    offlineStatus: () => JSON.stringify({ hasTiles: true, hasRouting: true, hasSearch: true }),
  };
  const nav = loadOfflineNav(bridge, false);
  assert.equal(nav.getMode(), 'auto');
  assert.equal(nav.shouldUseOffline('tiles'), true);
  assert.equal(nav.shouldUseOffline('route'), true);
  assert.equal(nav.shouldUseOffline('search'), true);

  nav.setMode('online');
  assert.equal(nav.shouldUseOffline('route'), false);
});
