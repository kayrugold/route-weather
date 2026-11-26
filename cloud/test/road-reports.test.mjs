import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import worker from '../index.mjs';
import {RoadReports} from '../road-reports.mjs';

test('drivers can share, confirm and clear route hazards without sharing their identifiers', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1_800_000_000_000});
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys=ON');
  let alarm = null;
  const storage = {
    sql: {exec(query, ...params) {
      if (!params.length && query.includes('CREATE TABLE')) return sqlite.exec(query);
      const statement = sqlite.prepare(query);
      const rows = statement.all(...params);
      return {toArray: () => rows, one: () => rows[0]};
    }},
    getAlarm: async () => alarm,
    setAlarm: async time => { alarm = time; },
  };
  const object = new RoadReports({storage});
  const env = {ROAD_REPORTS: {getByName: () => ({fetch: input => object.fetch(new Request(input))})}};
  const reporter = crypto.randomUUID(), driver = crypto.randomUUID(), another = crypto.randomUUID();
  const id = crypto.randomUUID();
  const hazard = {id, reporter, action: 'create', title: 'Debris in road', lat: 40.45, lon: -122.30};
  const url = 'https://route-weather.test/app-api/road-reports';
  const origin = 'https://appassets.androidplatform.net';
  const read = (query = '?lat=40.44&lon=-122.29') => worker.fetch(new Request(url + query, {headers: {Origin: origin}}), env);
  const send = body => worker.fetch(new Request(url, {method: 'POST',
    headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(body)}), env);

  const preflight = await worker.fetch(new Request(url, {method: 'OPTIONS', headers: {Origin: origin}}), env);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal((await worker.fetch(new Request(url, {headers: {Origin: 'https://example.org'}}), env)).status, 403);
  assert.equal((await send({...hazard, lat: null})).status, 400);
  assert.equal((await send({...hazard, title: 'Anything'})).status, 400);
  assert.equal((await send(hazard)).status, 201);
  assert.equal((await send(hazard)).status, 200);
  assert.equal(alarm, Date.now() + 90 * 60_000);
  assert.deepEqual(await (await read('?lat=40.44&lon=-123')).json(), {reports: []});
  const first = await (await read()).json();
  assert.deepEqual(first.reports, [{id, title: hazard.title, lat: hazard.lat, lon: hazard.lon,
    start: Date.now(), end: alarm, confirmed: null}]);

  const vote = (action, reporter) => send({id, reporter, action}).then(res => res.json());
  assert.deepEqual(await vote('still-there', driver), {cleared: false});
  assert.equal((await (await read()).json()).reports[0].confirmed, Date.now());
  assert.deepEqual(await vote('clear', driver), {cleared: false});
  assert.deepEqual(await vote('clear', driver), {cleared: false});
  assert.deepEqual(await vote('clear', another), {cleared: true});
  assert.deepEqual(await (await read()).json(), {reports: []});
  assert.equal((await send(hazard)).status, 409);

  const next = {...hazard, id: crypto.randomUUID(), lon: 179.98};
  assert.equal((await send(next)).status, 201);
  const acrossDateLine = () => read('?lat=40.44&lon=-179.98').then(res => res.json());
  assert.equal((await acrossDateLine()).reports[0].id, next.id);
  assert.deepEqual(await send({reporter, id: next.id, action: 'clear'}).then(res => res.json()), {cleared: true});
  assert.deepEqual(await acrossDateLine(), {reports: []});
  assert.equal((await send({...hazard, id: crypto.randomUUID()})).status, 201);
  t.mock.timers.tick(90 * 60_000);
  assert.deepEqual(await (await read()).json(), {reports: []});
  await object.alarm();
  assert.equal(sqlite.prepare('SELECT count(*) AS remaining FROM reports').get().remaining, 0);
  assert.equal(sqlite.prepare('SELECT count(*) AS remaining FROM votes').get().remaining, 0);
});
