import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAlabama,handleAlabamaRoads} from '../alabama-roads.mjs';
const now=Date.parse('2026-11-25T12:00:00Z');
const event=(props={})=>({properties:{id:1,active:true,type:'Roadwork',title:'Lane work',subTitle:'I-20 near Birmingham',description:'Right lane closed',lastUpdatedAt:'2026-11-25T11:00:00Z',startLocation:{latitude:33.5,longitude:-86.8},...props}});
const feed=features=>({type:'FeatureCollection',features});
test('ALGO uses live event details, not static stations, with distinct closure categories',()=>{
 const items=normalizeAlabama(feed([event(),event({id:2,type:'Incident'}),event({id:3,laneDirections:[{lanes:[{type:'ThroughLane',state:'Closed'}]}]})]),now);
 assert.deepEqual(items.map(x=>x.type),['work','incident','full']);assert.equal(items[0].place,'I-20 near Birmingham');assert.equal(items[0].updated,Date.parse('2026-11-25T11:00:00Z'));
});
test('ALGO excludes ended, future, inactive and invalid-location events; malformed feed is not clear roads',()=>{
 assert.equal(normalizeAlabama(feed([event({end:'2026-01-01'}),event({start:'2027-01-01'}),event({active:false}),event({startLocation:{}})]),now).length,0);
 assert.throws(()=>normalizeAlabama({error:'Unavailable'}));
});
test('upstream failure is reported as unavailable, never as an empty road report',async()=>{
 const r=await handleAlabamaRoads(new Request('https://app/api/state-road-overlay?state=AL'),async()=>new Response(null,{status:503}));assert.equal(r.status,502);assert.match((await r.json()).error,/unknown/);
});
