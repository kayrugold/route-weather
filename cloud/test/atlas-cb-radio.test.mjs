import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  bearingDegrees,
  cardinalDirection,
  generateInviteCode,
  haversineMiles,
  isWithinReceptionRange,
  normalizePublicChannel,
  sanitizeHandle,
} from '../../atlas-radio/src/geo.mjs';

function loadBrowserScript(relPath) {
  const code = fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
  const ctx = { globalThis: {}, console, Math, Date, Number, String, Array, Boolean, Object, RegExp, JSON };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx);
  return ctx;
}

test('atlas-radio geo: Haversine distance & cardinal bearings', () => {
  // Redding, CA to Anderson, CA (~10.5 mi south)
  const d1 = haversineMiles(40.5865, -122.3917, 40.4482, -122.2978);
  assert.ok(d1 > 9 && d1 < 13, `expected ~10.5 mi, got ${d1}`);
  const brg = bearingDegrees(40.5865, -122.3917, 40.4482, -122.2978);
  assert.equal(cardinalDirection(brg), 'SE');

  // Redding, CA to Stockton, CA (~185-205 mi)
  const d2 = haversineMiles(40.5865, -122.3917, 37.9577, -121.2908);
  assert.ok(d2 > 180 && d2 < 210, `expected ~191 mi, got ${d2}`);
});

test('atlas-radio geo: reception range filtering (10/30/100 mi & Global)', () => {
  const redding = { lat: 40.5865, lon: -122.3917, rangeMi: 30 };
  const anderson = { lat: 40.4482, lon: -122.2978, rangeMi: 10 };
  const stockton = { lat: 37.9577, lon: -121.2908, rangeMi: 30 };
  const stocktonGlobal = { lat: 37.9577, lon: -121.2908, rangeMi: 0 };

  assert.equal(isWithinReceptionRange(redding, { ...anderson, rangeMi: 15 }), true);
  assert.equal(isWithinReceptionRange(redding, { ...anderson, rangeMi: 5 }), false);
  assert.equal(isWithinReceptionRange(redding, stockton), false);
  assert.equal(isWithinReceptionRange(redding, stocktonGlobal), true);
});

test('atlas-radio geo: public channel normalization, invite codes, and handles', () => {
  assert.equal(normalizePublicChannel('19'), 'CH19');
  assert.equal(normalizePublicChannel('CH 17'), 'CH17');
  assert.equal(normalizePublicChannel('custom 42'), 'CH42');
  assert.equal(normalizePublicChannel('0'), null);
  assert.equal(normalizePublicChannel('1000'), null);
  assert.equal(normalizePublicChannel('FAM'), null);

  const famCode = generateInviteCode('FAM');
  assert.match(famCode, /^FAM-[2-9A-HJ-NP-Z]{6}$/);
  const cmpCode = generateInviteCode('CMP');
  assert.match(cmpCode, /^CMP-[2-9A-HJ-NP-Z]{6}$/);

  assert.equal(sanitizeHandle('  BigRig <script> #42 '), 'BigRig script #42');
  assert.equal(sanitizeHandle(''), 'Driver');
});

test('atlas-cb-radio frontend helpers', () => {
  const ctx = loadBrowserScript('../../assets/atlas-cb-radio.js');
  const cb = ctx.atlasCbRadio;
  assert.equal(cb.normalizeChannelId('channel 19'), 'CH19');
  assert.equal(cb.normalizeChannelId('family'), 'FAM');
  assert.equal(cb.normalizeChannelId('fleet'), 'CMP');
  assert.equal(cb.formatChannelLabel('CH17'), 'CH 17');
  assert.equal(cb.formatRangeLabel(30, 'CH19'), '30 mi');
  assert.equal(cb.formatRangeLabel(30, 'FAM'), 'Global');
  assert.equal(cb.formatRangeLabel(0, 'CH19'), 'Global');
});

test('atlas-commands parses Phase 4 CB radio voice commands', () => {
  const ctx = loadBrowserScript('../../assets/atlas-commands.js');
  const { parseCommand } = ctx.atlasCommands;

  assert.equal(parseCommand('Router, open CB radio').action, 'cb_show');
  assert.equal(parseCommand('Router, turn off CB radio').action, 'cb_hide');
  assert.deepEqual({ ...parseCommand('Router, mute CB') }, { action: 'cb_mute', value: true, label: 'CB Muted' });
  assert.deepEqual({ ...parseCommand('Router, unmute CB') }, { action: 'cb_mute', value: false, label: 'CB Unmuted' });
  assert.equal(parseCommand('Router, say again').action, 'cb_replay');
  assert.deepEqual({ ...parseCommand('Router, global range') }, { action: 'cb_range', value: 0, label: 'CB Range: Global' });
  assert.deepEqual({ ...parseCommand('Router, channel 19') }, { action: 'cb_channel', value: 'CH 19', label: 'CB: Channel 19' });
  assert.deepEqual({ ...parseCommand('Router, family channel') }, { action: 'cb_channel', value: 'FAM', label: 'CB: Family' });
  assert.deepEqual({ ...parseCommand('Router, company channel') }, { action: 'cb_channel', value: 'CMP', label: 'CB: Company' });
  assert.equal(parseCommand('Router, transmit').action, 'cb_tx_start');
  assert.equal(parseCommand('Router, end transmission').action, 'cb_tx_stop');
  assert.equal(parseCommand('Router, weather radio').action, 'wx_radio_toggle');
  assert.equal(parseCommand('Router, stop weather radio').action, 'wx_radio_stop');
  assert.deepEqual({ ...parseCommand('Router, search YouTube for Brian Greene') }, {
    action: 'media_search', value: 'Brian Greene', label: 'YouTube: Brian Greene',
  });
  assert.deepEqual({ ...parseCommand('Router, play Brian Greene on YouTube') }, {
    action: 'media_search', value: 'Brian Greene', label: 'YouTube: Brian Greene',
  });
});
