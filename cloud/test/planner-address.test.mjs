import assert from 'node:assert/strict';
import test from 'node:test';
import '../../assets/planner-address.js';

const {exactAddress} = globalThis.routePlannerAddress;

test('Anderson, CA resolves without asking the driver to choose between similarly named places', () => {
  const exact = {display_name: 'Anderson, CA'};
  const results = [{display_name: 'Anderson, San Jose, CA'}, exact, {display_name: 'Anderson Southeast, San Jose, CA'}];
  assert.equal(exactAddress(results, '  Anderson  CA '), exact);
});

test('preserves the chooser for ambiguous addresses, and accepts a single result', () => {
  assert.equal(exactAddress([{display_name: 'Anderson, CA'}, {display_name: 'Anderson CA'}], 'Anderson, CA'), null);
  assert.equal(exactAddress([{display_name: 'Anderson, CA'}, {display_name: 'Anderson, SC'}], 'Anderson'), null);
  const single = {display_name: 'Anderson, CA'};
  assert.equal(exactAddress([single], 'Anderson'), single);
});
