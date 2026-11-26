import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../../assets/emergency-alerts.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {} };
vm.runInNewContext(src, sandbox);
const api = sandbox.globalThis.routeEmergencyAlerts;

const now = Date.parse('2026-11-26T12:00:00Z');
const future = '2026-11-26T15:00:00Z';
const past = '2026-11-26T10:00:00Z';

const samplePolygon = [
  [-122.6, 40.3],
  [-122.1, 40.3],
  [-122.1, 40.7],
  [-122.6, 40.7],
  [-122.6, 40.3],
];

test('parseNwsAlerts keeps trucker-relevant severe/extreme warnings and filters marine/expired', () => {
  const geojson = {
    features: [
      {
        id: 'a1',
        properties: {
          id: 'a1',
          event: 'Tornado Warning',
          severity: 'Extreme',
          urgency: 'Immediate',
          status: 'Actual',
          messageType: 'Alert',
          expires: future,
          areaDesc: 'Shasta County, CA',
        },
        geometry: { type: 'Polygon', coordinates: [samplePolygon] },
      },
      {
        id: 'a2',
        properties: {
          id: 'a2',
          event: 'Small Craft Advisory',
          severity: 'Severe',
          urgency: 'Expected',
          status: 'Actual',
          messageType: 'Alert',
          expires: future,
        },
        geometry: { type: 'Polygon', coordinates: [samplePolygon] },
      },
      {
        id: 'a3',
        properties: {
          id: 'a3',
          event: 'Blizzard Warning',
          severity: 'Extreme',
          urgency: 'Expected',
          status: 'Actual',
          messageType: 'Alert',
          expires: past,
        },
        geometry: { type: 'Polygon', coordinates: [samplePolygon] },
      },
      {
        id: 'a4',
        properties: {
          id: 'a4',
          event: 'High Wind Warning',
          severity: 'Severe',
          urgency: 'Expected',
          status: 'Actual',
          messageType: 'Alert',
          expires: future,
          areaDesc: 'I-5 Corridor',
        },
        geometry: { type: 'Polygon', coordinates: [samplePolygon] },
      },
    ],
  };

  const alerts = api.parseNwsAlerts(geojson, now);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].id, 'a1');
  assert.equal(alerts[0].level, 'extreme');
  assert.equal(alerts[1].id, 'a4');
  assert.equal(alerts[1].level, 'severe');
});

test('evaluateImpacts distinguishes truck inside polygon vs route corridor vs unaffected', () => {
  const alerts = api.parseNwsAlerts({
    features: [{
      id: 'w1',
      properties: {
        id: 'w1',
        event: 'Dust Storm Warning',
        severity: 'Extreme',
        urgency: 'Immediate',
        status: 'Actual',
        messageType: 'Alert',
        expires: future,
        areaDesc: 'Redding / Anderson, CA',
      },
      geometry: { type: 'Polygon', coordinates: [samplePolygon] },
    }],
  }, now);

  // Inside polygon
  const here = api.evaluateImpacts(alerts, { gps: { lon: -122.35, lat: 40.5 } });
  assert.equal(here.length, 1);
  assert.equal(here[0].scope, 'here');
  assert.match(api.buildSpokenSummary(here[0]), /current area.*Dust Storm Warning/i);

  // Far away GPS, but planned route passes through polygon
  const onRoute = api.evaluateImpacts(alerts, {
    gps: { lon: -121.5, lat: 38.5 },
    routeCoords: [[-121.5, 38.5], [-122.3, 40.45], [-122.4, 41.3]],
  });
  assert.equal(onRoute.length, 1);
  assert.equal(onRoute[0].scope, 'route');
  assert.match(api.buildSpokenSummary(onRoute[0]), /along your route.*Dust Storm Warning/i);

  // Far away GPS and far away route
  const none = api.evaluateImpacts(alerts, {
    gps: { lon: -118.2, lat: 34.0 },
    routeCoords: [[-118.2, 34.0], [-117.1, 32.7]],
  });
  assert.equal(none.length, 0);
});
