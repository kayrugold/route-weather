import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import worker from '../index.mjs';
import {TripQuota} from '../quota.mjs';
import {handleTomTom, normalizeRoute} from '../tomtom.mjs';

const point = (longitude, latitude) => ({longitude, latitude});
const fixture = {routes: [{
  summary: {lengthInMeters: 22000, travelTimeInSeconds: 1200},
  legs: [
    {summary: {lengthInMeters: 11000, travelTimeInSeconds: 500}, points: [point(-122.3, 40.4), point(-122.3, 40.5)]},
    {summary: {lengthInMeters: 11000, travelTimeInSeconds: 700}, points: [point(-122.3, 40.5), point(-122.3, 40.6)]},
  ],
  guidance: {instructions: [
    {routeOffsetInMeters: 0, message: 'Head north', point: point(-122.3, 40.4)},
    {routeOffsetInMeters: 11000, message: 'Continue north', point: point(-122.3, 40.5)},
  ]},
}]};
const request = path => new Request('https://route.example' + path);

test('round trip route contract preserves geometry, via points, leg times and directions', () => {
  const result = normalizeRoute(fixture);
  const route = result.routes[0];
  assert.deepEqual(route.geometry.coordinates, [[-122.3,40.4],[-122.3,40.5],[-122.3,40.6]]);
  assert.deepEqual(result.waypoints[1].location, [-122.3,40.5]);
  assert.deepEqual(route.legs.flatMap(leg => leg.annotation.duration), [500,700]);
  assert.equal(route.legs[1].steps[0].instruction, 'Continue north');
});

test('Worker reserves quota before calling TomTom and never returns its credentials', async () => {
  let reserved = false;
  const QUOTA = {getByName: () => ({fetch: async () => {
    if (reserved) return new Response(null, {status: 429});
    reserved = true;
    return new Response(null, {status: 204});
  }})};
  let calls = 0;
  const provider = async (url, options) => {
    assert.equal(reserved, true);
    calls++;
    assert.equal(url.hostname, 'api.tomtom.com');
    assert.equal(url.pathname, '/search/2/geocode/Anderson%2C%20CA.json');
    assert.equal(options.headers['TomTom-Api-Key'], 'test-key');
    return Response.json({results: [{position: {lat: 40.45, lon: -122.3}, address: {freeformAddress: 'Anderson, CA'}}]});
  };
  const env = {QUOTA, TOMTOM_API_KEY: 'test-key'};
  const req = request('/api/search?q=Anderson%2C%20CA');
  const response = await handleTomTom(req, '/search', env, 'demo', provider);
  assert.deepEqual(await response.json(), [{lat: 40.45, lon: -122.3, display_name: 'Anderson, CA'}]);
  assert.equal((await handleTomTom(req, '/search', env, 'demo', provider)).status, 429);
  assert.equal(calls, 1);
});

test('SQLite cap is shared, and demo exhaustion leaves room for the app', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const quota = new TripQuota({storage: {sql: {
    exec(sql, ...args) {
      const statement = sqlite.prepare(sql);
      if (/RETURNING/.test(sql)) return {toArray: () => statement.all(...args)};
      statement.run(...args);
    },
  }}});
  const send = (client, bucket = 'routing') => quota.fetch(new Request('https://quota.internal', {
    method: 'POST', body: JSON.stringify({client, bucket}),
  }));
  const month = new Date().toISOString().slice(0, 7);
  sqlite.prepare('INSERT INTO usage VALUES (?, ?, ?, ?)').run(month, 'routing', 4998, 499);
  const responses = await Promise.all([send('demo'), send('demo')]);
  assert.deepEqual(responses.map(r => r.status).sort(), [204, 429]);
  assert.equal((await send('app')).status, 204);
  assert.equal((await send('app')).status, 429);
  assert.equal((await send('demo', 'traffic')).status, 429);
  sqlite.close();
});

test('public browser traffic and unconfigured app requests fail before upstream', async () => {
  const env = {STUDIO_TRAFFIC: 'on'};
  assert.equal((await worker.fetch(request('/api/traffic/12/1/1'), env)).status, 404);
  assert.equal((await worker.fetch(request('/app-api/route?coords=-122.3,40.4;-122.3,40.5'), env)).status, 503);
  assert.deepEqual(await (await worker.fetch(request('/api/provider-status'), env)).json(), {studioTraffic: false});
});
