import assert from 'node:assert/strict';
import test from 'node:test';
import '../../assets/route-terrain.js';

const {sampleTerrainRoute, terrainPixel, terrariumHeight, gradeBetween} = globalThis.routeWeatherTerrain;

test('terrain sampling bounds long routes and interpolates across the date line', () => {
  const samples = sampleTerrainRoute([[179.9, 45], [-179.9, 45]], () => 2000);
  assert.equal(samples.length, 81);
  assert.deepEqual(samples[0], {coordinates: [179.9, 45], distance: 0});
  assert.equal(Math.abs(samples[40].coordinates[0]), 180);
  assert.deepEqual(samples.at(-1), {coordinates: [-179.9, 45], distance: 2000000});
});

test('Terrarium samples decode signed heights and grades skip missing pixels', () => {
  assert.deepEqual(terrainPixel([0, 0]), {tile: '10/512/512', x: 0, y: 0});
  assert.equal(terrariumHeight([127, 255, 128, 255]), -0.5);
  assert.equal(terrariumHeight([0, 0, 0, 0]), null);
  assert.equal(gradeBetween({distance: 0, elevation: 100}, {distance: 1000, elevation: 160}), 6);
  assert.equal(gradeBetween({distance: 0, elevation: null}, {distance: 1000, elevation: 160}), null);
});
