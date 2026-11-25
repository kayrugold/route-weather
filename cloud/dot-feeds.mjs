/**
 * Secret-backed Cloudflare Worker proxy for free registration-based state & provincial DOT feeds.
 * Keys live exclusively in Cloudflare Worker secrets (never shipped to clients).
 * Supported secrets:
 *   COTRIP_API_KEY, DRIVETEXAS_API_KEY, OHGO_API_KEY, VDOT_API_KEY, MASSDOT_API_KEY,
 *   IL_CWZ_API_KEY, PA_TURNPIKE_API_KEY, WYDOT_API_KEY, DRIVENC_API_KEY, NY511_API_KEY,
 *   AB511_API_KEY, ON511_API_KEY, ALGO_API_KEY
 */

const AUTH_FEEDS = {
  CO: { secret: 'COTRIP_API_KEY', name: 'Colorado DOT COtrip (CWZ)', buildUrl: k => `https://data.cotrip.org/api/v1/cwz?apiKey=${encodeURIComponent(k)}`, format: 'wzdx' },
  TX: { secret: 'DRIVETEXAS_API_KEY', name: 'TxDOT DriveTexas (WZDx)', buildUrl: k => `https://api.drivetexas.org/api/conditions.wzdx.geojson?key=${encodeURIComponent(k)}`, format: 'wzdx' },
  OH: { secret: 'OHGO_API_KEY', name: 'Ohio DOT OHGO (WZDx)', buildUrl: k => `https://publicapi.ohgo.com/api/work-zones/wzdx/4.2?api-key=${encodeURIComponent(k)}`, format: 'wzdx' },
  VA: { secret: 'VDOT_API_KEY', name: 'VDOT SmarterRoads (WZDx)', buildUrl: k => `https://data.511-atis-ttrip-prod.iteriscloud.com/smarterRoads/workzone/workZoneJSON/current/workZone.json?token=${encodeURIComponent(k)}`, format: 'wzdx' },
  MA: { secret: 'MASSDOT_API_KEY', name: 'MassDOT (CWZ)', buildUrl: () => 'https://api.massdot-swzm.com/api/v1/cwz/work-zone-feed', headers: k => ({ 'x-api-key': k }), format: 'wzdx' },
  IL: { secret: 'IL_CWZ_API_KEY', name: 'IDOT (CWZ)', buildUrl: k => `https://wzad-idot.illinois.gov/cwz/01.00?api_key=${encodeURIComponent(k)}`, format: 'wzdx' },
  PA: { secret: 'PA_TURNPIKE_API_KEY', name: 'PA Turnpike (WZDx)', buildUrl: k => `https://atms.paturnpike.com/api/WZDxWorkZoneFeed?api_key=${encodeURIComponent(k)}`, format: 'wzdx' },
  WY: { secret: 'WYDOT_API_KEY', name: 'WYDOT (CWZ)', buildUrl: () => 'https://sdx-service.trihydro.com/api/wz/cwz-feed?postalAbbreviation=wy', headers: k => ({ 'x-api-key': k }), format: 'wzdx' },
  NC: { secret: 'DRIVENC_API_KEY', name: 'NCDOT DriveNC (WZDx)', buildUrl: () => 'https://drivenc.gov/api/wzdx', headers: k => ({ 'x-api-key': k }), format: 'wzdx' },
  NY: { secret: 'NY511_API_KEY', name: 'NYSDOT 511NY (WZDx)', buildUrl: k => `https://nysdot.carsprogram.org/carsapi_v1/api/wzdx?apiKey=${encodeURIComponent(k)}`, format: 'wzdx' },
  'CA-AB': { secret: 'AB511_API_KEY', name: '511 Alberta', buildUrl: k => `https://511.alberta.ca/api/v2/get/event?key=${encodeURIComponent(k)}&format=json`, format: '511v2' },
  'CA-ON': { secret: 'ON511_API_KEY', name: 'Ontario 511', buildUrl: k => `https://511on.ca/api/v2/get/event?key=${encodeURIComponent(k)}&format=json`, format: '511v2' },
};

function firstPoint(geom) {
  if (!geom || !geom.coordinates) return null;
  if (geom.type === 'Point') return geom.coordinates;
  if (geom.type === 'LineString' || geom.type === 'MultiPoint') return geom.coordinates[Math.floor(geom.coordinates.length / 2)];
  if (geom.type === 'MultiLineString' && geom.coordinates[0]?.length) return geom.coordinates[0][0];
  return null;
}

function normalizeWzdx(data, source) {
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.flatMap(f => {
    const pt = firstPoint(f.geometry);
    if (!pt || pt.length < 2) return [];
    const [lon, lat] = pt;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const p = f.properties || {};
    const core = p.core_details || p;
    const roads = Array.isArray(core.road_names) ? core.road_names.join(' / ') : (core.road_name || '');
    const desc = core.description || p.description || '';
    const closed = /all-lanes-closed|closed/i.test(String(p.vehicle_impact || '') + ' ' + desc);
    return [{
      kind: closed ? 'closure' : 'lane',
      title: String(core.event_type || 'Work zone').replace(/_/g, ' '),
      place: roads || source,
      direction: String(core.direction || ''),
      description: String(desc).slice(0, 1200),
      updated: Date.parse(core.update_date || data.road_event_feed_info?.update_date || '') || Date.now(),
      lon, lat, source
    }];
  });
}

function normalize511v2(data, source) {
  const list = Array.isArray(data) ? data : [];
  return list.flatMap(ev => {
    const lat = Number(ev.Latitude), lon = Number(ev.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const text = String(ev.EventType || '') + ' ' + String(ev.Description || '');
    const kind = /closure|closed/i.test(text) ? 'closure' : (/construction|roadwork/i.test(text) ? 'lane' : 'chp');
    return [{
      kind,
      title: String(ev.EventType || ev.EventSubType || '511 Event'),
      place: String(ev.RoadwayName || source),
      direction: String(ev.DirectionOfTravel || ''),
      description: String(ev.Description || '').slice(0, 1200),
      updated: Number(ev.LastUpdated) ? Number(ev.LastUpdated) * 1000 : Date.now(),
      lon, lat, source
    }];
  });
}

export function listConfiguredDotFeeds(env) {
  return Object.entries(AUTH_FEEDS)
    .filter(([, cfg]) => Boolean(env?.[cfg.secret]))
    .map(([code, cfg]) => ({ code, name: cfg.name }));
}

export async function handleDotFeedRequest(url, env) {
  const code = (url.searchParams.get('code') || '').toUpperCase().trim();
  if (!code) {
    return Response.json({ configured: listConfiguredDotFeeds(env) });
  }
  const cfg = AUTH_FEEDS[code];
  if (!cfg) {
    return Response.json({ configured: false, error: 'No registered authenticated DOT feed for this jurisdiction.' }, { status: 404 });
  }
  const key = env?.[cfg.secret];
  if (!key) {
    return Response.json({ configured: false, secret: cfg.secret, error: `Secret ${cfg.secret} is not configured in Cloudflare Worker.` }, { status: 503 });
  }
  try {
    const headers = { 'User-Agent': 'RouteWeather/1.0', Accept: 'application/json', ...(cfg.headers ? cfg.headers(key) : {}) };
    const res = await fetch(cfg.buildUrl(key), { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return Response.json({ error: `${cfg.name} returned HTTP ${res.status}` }, { status: 502 });
    const data = await res.json();
    const items = cfg.format === '511v2' ? normalize511v2(data, cfg.name) : normalizeWzdx(data, cfg.name);
    return Response.json({ items, checked: Date.now(), source: cfg.name, configured: true }, {
      headers: { 'Cache-Control': 'public, max-age=120' }
    });
  } catch {
    return Response.json({ error: `${cfg.name} is temporarily unavailable.` }, { status: 502 });
  }
}
