import assert from 'node:assert/strict';
import test from 'node:test';
import '../../assets/traffic-plan.js';

const plan = globalThis.routeTrafficPlan;

test('driving tile selection includes the route and avoids fetching across the date line', () => {
  const z = plan.drivingZoom;
  const start = [179.98, 40.5], end = [-179.98, 40.5];
  const keys = plan.routeTiles([start, end], z);
  const key = position => plan.tileKey(...plan.projectTile(position, z).map(Math.floor));
  assert.ok(keys.has(key(start)));
  assert.ok(keys.has(key(end)));
  assert.ok(keys.size < 12, 'a short crossing must not select tiles across the whole world');
  assert.ok(!keys.has(key([0, 40.5])));
});

test('a 14-hour viewport replay counts fewer requests in driving mode', t => {
  const minutes = 14 * 60;
  const path = Array.from({length: minutes + 1}, (_, i) => [
    -122 + .4 * Math.sin(i / 140), 35 + i * 11 / minutes,
  ]);
  const mask = plan.routeTiles(path, plan.drivingZoom);
  function replay({zoom, refreshMs, mask, redraw}) {
    const retained = new Map();
    const scale = 2 ** (zoom - 16);
    let calls = 0;
    for (let minute = 0; minute <= minutes; minute++) {
      const now = minute * 60_000;
      const [x,y] = plan.projectTile(path[minute], zoom);
      const left = Math.floor(x - 180 / 256 * scale), right = Math.floor(x + 180 / 256 * scale);
      const top = Math.floor(y - 360 / 256 * scale), bottom = Math.floor(y + 360 / 256 * scale);
      if(redraw&&now%refreshMs===0)retained.clear();
      for(const [key,{x,y}] of retained){
        if(x<left-1||x>right+1||y<top-1||y>bottom+1)retained.delete(key);
      }
      for(let tx=left;tx<=right;tx++)for(let ty=top;ty<=bottom;ty++){
        const key=plan.tileKey(tx,ty);
        if(mask&&!mask.has(key))continue;
        const current=retained.get(key);
        if(!current||(!redraw&&now-current.fetched>=refreshMs)){
          retained.set(key,{x:tx,y:ty,fetched:now});
          calls++;
        }
      }
    }
    return calls;
  }
  const prior=replay({zoom:16,refreshMs:180_000,redraw:true});
  const driving=replay({zoom:plan.drivingZoom,refreshMs:plan.drivingMaxAge,mask,redraw:false});
  t.diagnostic(`14-hour modeled requests: ${prior} before, ${driving} in driving mode`);
  assert.ok(driving>0);
  assert.ok(driving<prior/4, 'driving should require substantially fewer tile requests');
});
