const headers = {'Cache-Control': 'no-store'};
const json = (body, status = 200) => Response.json(body, {status, headers});
const error = (message, status) => json({error: message}, status);
const coordinates = point => [point.longitude, point.latitude];
const workerReferrer = 'https://route-weather.andy-596.workers.dev/';

function coordinate(value, max) {
  if (!value?.trim() || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > max) {
    throw new Error('Invalid coordinates.');
  }
  return Number(value);
}

function meters(a, b) {
  const rad = Math.PI / 180;
  const x = Math.sin((b[1] - a[1]) * rad / 2);
  const y = Math.sin((b[0] - a[0]) * rad / 2);
  const h = x*x + y*y*Math.cos(a[1]*rad)*Math.cos(b[1]*rad);
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function normalizeRoute(source) {
  const route = source.routes?.[0];
  if (!route?.legs?.length) return null;
  const geometry = [];
  const waypoints = [];
  let offset = 0;
  const legs = route.legs.map((leg, index) => {
    const points = leg.points.map(coordinates);
    if (!points.length || !points.every(point => point.every(Number.isFinite))) throw Error('Invalid route geometry.');
    if (!index) waypoints.push({location: points[0]});
    waypoints.push({location: points.at(-1)});
    const segmentTimes = points.slice(1).map((point, i) => meters(points[i], point));
    if (index && meters(geometry.at(-1), points[0]) > 0.01) {
      geometry.push(points[0]);
      segmentTimes.unshift(0);
    }
    geometry.push(...(index ? points.slice(1) : points));
    const length = segmentTimes.reduce((sum, value) => sum + value, 0);
    const duration = leg.summary.travelTimeInSeconds;
    const distance = leg.summary.lengthInMeters;
    const instructions = route.guidance?.instructions ?? [];
    const steps = instructions.flatMap((step, i) => {
      if (step.routeOffsetInMeters < offset || (index < route.legs.length - 1 && step.routeOffsetInMeters >= offset + distance)) return [];
      const next = instructions[i + 1]?.routeOffsetInMeters ?? offset + distance;
      return [{
        instruction: step.message,
        offset: step.routeOffsetInMeters,
        name: step.street ?? '',
        distance: Math.max(0, Math.min(next, offset + distance) - step.routeOffsetInMeters),
        maneuver: {type: step.maneuver ?? 'continue', location: step.point ? coordinates(step.point) : points[0]},
      }];
    });
    offset += distance;
    return {distance, duration, steps, annotation: {duration: segmentTimes.map(x => length ? x / length * duration : 0)}};
  });
  if (geometry.length < 2) return null;
  return {code: 'Ok', waypoints, routes: [{
    distance: route.summary.lengthInMeters,
    duration: route.summary.travelTimeInSeconds,
    geometry: {type: 'LineString', coordinates: geometry},
    legs,
  }]};
}

function upstreamRequest(path, params) {
  const upstream = new URL('https://api.tomtom.com');
  if (path === '/search') {
    const query = (params.get('q') || '').trim();
    if (query.length < 2 || query.length > 250) throw Error('Enter a valid address or town.');
    upstream.pathname = '/search/2/geocode/' + encodeURIComponent(query) + '.json';
    upstream.search = new URLSearchParams({countrySet: 'US', limit: '5', typeahead: 'false'});
    return ['search', upstream];
  }
  if (path === '/route') {
    const input = (params.get('coords') || '').split(';');
    if (input.length < 2 || input.length > 10) throw Error('A route supports two endpoints and up to eight waypoints.');
    const points = input.map(pair => {
      const [lon, lat, ...extra] = pair.split(',');
      if (extra.length) throw Error('Invalid coordinates.');
      return [coordinate(lat, 90), coordinate(lon, 180)].join(',');
    });
    upstream.pathname = '/routing/1/calculateRoute/' + points.join(':') + '/json';
    upstream.search = new URLSearchParams({
      travelMode: 'car', traffic: 'false', routeRepresentation: 'polyline', instructionsType: 'text',
    });
    return ['routing', upstream];
  }
  if (path === '/nearest-road') {
    const lat = coordinate(params.get('lat'), 90);
    const lon = coordinate(params.get('lon'), 180);
    const radius = coordinate(params.get('radius') ?? '100', 350);
    if (radius < 30) throw Error('Invalid search radius.');
    upstream.pathname = '/search/2/reverseGeocode/' + lat + ',' + lon + '.json';
    upstream.search = new URLSearchParams({radius: String(radius), returnRoadUse: 'true'});
    return ['reverse', upstream, {lat, lon, radius}];
  }
  const tile = /^\/traffic\/([0-9]{1,2})\/([0-9]{1,5})\/([0-9]{1,5})$/.exec(path);
  if (tile) {
    const [z, x, y] = tile.slice(1).map(Number);
    if (z < 8 || z > 16 || x >= 2**z || y >= 2**z) throw Error('Invalid traffic tile.');
    upstream.pathname = '/maps/orbis/traffic/flow/raster/tile/' + [z, x, y].join('/');
    upstream.search = new URLSearchParams({apiVersion: '2', style: 'light'});
    return ['traffic', upstream];
  }
  return null;
}

export function isTomTomEndpoint(path) {
  return ['/search', '/route', '/nearest-road', '/provider-status'].includes(path) || path.startsWith('/traffic/');
}

export async function handleTomTom(request, path, env, client, fetchUpstream = globalThis.fetch.bind(globalThis)) {
  if (request.method !== 'GET') return error('Method not allowed.', 405);
  const traffic = env.STUDIO_TRAFFIC === 'on';
  if (path === '/provider-status') return json({studioTraffic: Boolean(traffic && env.TOMTOM_API_KEY)});
  let operation;
  try { operation = upstreamRequest(path, new URL(request.url).searchParams); }
  catch (e) { return error(e.message, 400); }
  if (!operation) return error('Unknown endpoint.', 404);
  const [bucket, upstream, near] = operation;
  if (bucket === 'traffic' && !traffic) return error('Studio traffic is unavailable.', 404);
  if (!env.TOMTOM_API_KEY || !env.QUOTA) return error('Trip services are not configured yet.', 503);
  let phase = 'rate limiter';
  try {
    if (env.CLIENT_RATE && !(await env.CLIENT_RATE.limit({
      key: client + ':' + (bucket === 'traffic' ? 'traffic:' : '') + (request.headers.get('CF-Connecting-IP') ?? 'unknown'),
    })).success) return bucket === 'traffic'
      ? json({error: 'Too many traffic requests.', retryAfterSeconds: 60}, 429)
      : error('Too many requests. Please wait and try again.', 429);
    phase = 'shared quota';
    const allowance = await env.QUOTA.getByName('tomtom').fetch('https://quota.internal/', {
      method: 'POST', body: JSON.stringify({bucket, client}),
    });
    if (allowance.status === 429) return bucket === 'traffic'
      ? json({error: 'This month’s traffic allowance has been used.', monthlyLimit: true}, 429)
      : error('This service has reached its usage limit. Try again later.', 429);
    if (!allowance.ok) return error('Trip services are temporarily unavailable.', 503);
    phase = 'TomTom connection';
    const upstreamHeaders = {Referer: workerReferrer};
    if (bucket === 'traffic') {
      upstreamHeaders['TomTom-Api-Key'] = env.TOMTOM_API_KEY;
      upstreamHeaders.Accept = 'image/png';
    }
    else upstream.searchParams.set('key', env.TOMTOM_API_KEY);
    const response = await fetchUpstream(upstream.href, {
      headers: upstreamHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 429) {
      if (bucket !== 'traffic') return error('TomTom is at its usage limit. Try again later.', 429);
      const value = response.headers.get('Retry-After');
      const seconds = value && Number.isFinite(Number(value)) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
      return json({
        error: 'TomTom is throttling traffic requests.',
        retryAfterSeconds: Number.isFinite(seconds) ? Math.max(2, Math.ceil(seconds)) : 5,
      }, 429);
    }
    if (response.status === 401 || response.status === 403) {
      console.error('TomTom authorization failed', {bucket, status: response.status});
      return error('TomTom denied access to this service.', 502);
    }
    if (bucket === 'routing' && response.status === 400) return error('No road route found. Try different route points.', 404);
    if (!response.ok) return error('TomTom service is temporarily unavailable.', 502);
    if (bucket === 'traffic') {
      if (!response.headers.get('Content-Type')?.startsWith('image/png')) return error('Invalid traffic tile.', 502);
      return new Response(response.body, {headers: {...headers, 'Content-Type': 'image/png'}});
    }
    phase = 'TomTom response';
    const data = await response.json();
    if (bucket === 'search') {
      return json(data.results.flatMap(item => {
        const label = item.address?.freeformAddress;
        if (!label || !Number.isFinite(item.position?.lat) || !Number.isFinite(item.position?.lon)) return [];
        return [{lat: item.position.lat, lon: item.position.lon, display_name: label, type: item.type}];
      }));
    }
    if (bucket === 'reverse') {
      const result = data.addresses?.[0];
      const [lat, lon] = (result?.position || '').split(',').filter(x => x.trim()).map(Number);
      if (![lat, lon].every(Number.isFinite) || meters([near.lon, near.lat], [lon, lat]) > near.radius) {
        return error('No drivable road close to this tap. Zoom in and tap again.', 404);
      }
      return json({lat, lon, label: result.address?.streetName || 'Road waypoint'});
    }
    const route = normalizeRoute(data);
    return route ? json(route) : error('No road route found. Try different route points.', 404);
  } catch (cause) {
    console.error('Route Weather provider error', {phase, bucket, name: cause?.name,
      ...(phase === 'shared quota' || phase === 'rate limiter' ? {detail: cause?.message} : {})});
    if (phase === 'shared quota' || phase === 'rate limiter') {
      return error('Trip usage checks are temporarily unavailable. Please try again.', 503);
    }
    return error('The trip service did not respond. Please try again.', 502);
  }
}
