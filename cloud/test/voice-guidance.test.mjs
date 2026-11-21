import assert from 'node:assert/strict';
import test from 'node:test';
import '../../assets/voice-guidance.js';

const voice = globalThis.routeVoice;
const reading = (distance, time = 0, overrides = {}) => ({
  distance, time, offRouteMeters: 2, accuracy: 8, speed: 24, ...overrides,
});

test('saved routes support projected maneuvers and new routes use provider offsets', () => {
  const route = {distance: 1000, geometry: {coordinates: [[0,0],[0,1]]}, legs: [{steps: [
    {instruction: 'Leave.', offset: 0, maneuver: {type: 'DEPART'}},
    {instruction: 'Turn left.', maneuver: {type: 'TURN_LEFT', location: [0,.5]}},
    {instruction: 'You have arrived.', offset: 1000, maneuver: {type: 'ARRIVE'}},
  ]}]};
  assert.deepEqual(voice.routeSteps(route, () => ({along: 5, total: 10})), [
    {offset: 500, text: 'Turn left.', endpoint: false},
    {offset: 1000, text: 'You have arrived.', endpoint: true},
  ]);
});

test('announces advance and near prompts once and confirms arrival at the endpoint', () => {
  const tracker = voice.createTracker([
    {offset: 650, text: 'Turn right onto Main Street.', endpoint: false},
    {offset: 1200, text: 'You have arrived.', endpoint: true},
  ]);
  assert.equal(tracker.update(reading(0)).text, undefined);
  assert.match(tracker.update(reading(220, 10000)).text, /In .*Turn right/);
  assert.equal(tracker.update(reading(230, 10500)).text, undefined);
  assert.match(tracker.update(reading(550, 24000)).text, /In .*Turn right/);
  assert.equal(tracker.update(reading(650, 28500)).text, undefined);
  assert.equal(tracker.update(reading(1170, 50000)).text, undefined);
  assert.equal(tracker.update(reading(1185, 51000)).text, 'You have arrived.');
  assert.equal(tracker.update(reading(1200, 52000)).text, undefined);
});

test('suppresses stale or misleading maneuvers after a bad fix or an off-route jump', () => {
  const tracker = voice.createTracker([
    {offset: 80, text: 'Old turn.', endpoint: false},
    {offset: 1750, text: 'Take the exit.', endpoint: false},
  ]);
  assert.match(tracker.update(reading(1100)).text ?? '', /^$/);
  const jump = tracker.update(reading(1690, 1000));
  assert.equal(jump.stop, true);
  assert.equal(jump.text, undefined);
  assert.equal(tracker.update(reading(1690, 2000, {offRouteMeters: 130})).text, undefined);
  assert.equal(tracker.update(reading(1700, 30000, {accuracy: 120})).text, undefined);
  const rejoined = tracker.update(reading(1700, 31000));
  assert.equal(rejoined.resumed, true);
  assert.match(rejoined.text, /Take the exit/);
});
