import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../../assets/atlas-commands.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {} };
vm.runInNewContext(src, sandbox);
const api = sandbox.globalThis.atlasCommands;

test('parseCommand handles wake-word prefixed and direct commands', () => {
  const wake = api.parseCommand('Router', { requireWakeWord: true });
  assert.equal(wake.action, 'wake');
  assert.equal(wake.label, 'Listening…');
  assert.equal(api.parseCommand('turn on the radio', { requireWakeWord: true }), null);

  const dest = api.parseCommand('Router, destination Stockton California', { requireWakeWord: true });
  assert.equal(dest.action, 'destination');
  assert.equal(dest.value, 'Stockton California');

  const yt = api.parseCommand('Router stop YouTube', { requireWakeWord: true });
  assert.equal(yt.action, 'media_pause');

  const radar = api.parseCommand('weather radar');
  assert.equal(radar.action, 'radar_toggle');

  const mute = api.parseCommand('mute directions');
  assert.equal(mute.action, 'voice_off');

  const ch19 = api.parseCommand('Router, channel nineteen', { requireWakeWord: true });
  assert.equal(ch19.action, 'cb_channel');
  assert.equal(ch19.value, 'CH 19');

  const fam = api.parseCommand('family channel');
  assert.equal(fam.action, 'cb_channel');
  assert.equal(fam.value, 'FAM');

  const cmp = api.parseCommand('company channel');
  assert.equal(cmp.action, 'cb_channel');
  assert.equal(cmp.value, 'CMP');

  const rng = api.parseCommand('range fifty miles');
  assert.equal(rng.action, 'cb_range');
  assert.equal(rng.value, 50);

  const dismiss = api.parseCommand('dismiss alert');
  assert.equal(dismiss.action, 'alert_dismiss');
});

test('createDispatcher executes registered handlers and triggers wake callback', () => {
  const calls = [];
  const dispatcher = api.createDispatcher({
    wake: () => calls.push('wake'),
    plan_trip: () => calls.push('plan_trip'),
    destination: v => calls.push('dest:' + v),
    media_pause: () => calls.push('pause'),
  });

  const r1 = dispatcher.handleTranscript('Router', { requireWakeWord: true });
  assert.equal(r1.wakeOnly, true);

  const r2 = dispatcher.handleTranscript('plan trip', { requireWakeWord: false });
  assert.equal(r2.ok, true);

  const r3 = dispatcher.handleTranscript('destination Red Bluff CA', { requireWakeWord: false });
  assert.equal(r3.ok, true);

  const r4 = dispatcher.handleTranscript('Router, stop YouTube', { requireWakeWord: true });
  assert.equal(r4.ok, true);

  assert.deepEqual(calls, ['wake', 'plan_trip', 'dest:Red Bluff CA', 'pause']);
});
