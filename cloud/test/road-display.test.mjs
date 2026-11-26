import assert from 'node:assert/strict';
import test from 'node:test';
import '../../assets/road-display.js';

const {iconSize,reportsAtPoint}=globalThis.routeWeatherRoadDisplay;

test('road icons stay small at regional zoom while closures are more prominent',()=>{
  assert(iconSize('cctv',7)<iconSize('cctv',14));
  assert(iconSize('cctv',9)<iconSize('full',9));
  assert(iconSize('full',18)<29);
});

test('tapping overlapping icons returns all nearby reports in priority order',()=>{
  const points=[
    {x:100,y:200,size:14,item:{kind:'cctv',title:'Camera'}},
    {x:104,y:199,size:17,item:{kind:'full',title:'Closure'}},
    {x:140,y:200,size:14,item:{kind:'cms',title:'Distant sign'}}
  ];
  assert.deepEqual(reportsAtPoint(points,100,200).map(item=>item.title),['Closure','Camera']);
  assert.deepEqual(reportsAtPoint(points,140,200).map(item=>item.title),['Distant sign']);
  assert.deepEqual(reportsAtPoint(points,0,0),[]);
});

test('road notices distinguish typed hazards and CHP activity',()=>{
  const {hazardKind}=globalThis.routeWeatherRoadDisplay;
  assert.equal(hazardKind({title:'1179-Trfc Collision-1141 Enrt',source:'CHP'}),'collision');
  assert.equal(hazardKind({title:'Traffic hazard',source:'CHP'}),'police');
  assert.equal(hazardKind({title:'Debris in road',source:'My report'}),'debris');
  assert.equal(hazardKind({title:'Stopped vehicle',source:'My report'}),'stopped');
  assert.equal(hazardKind({title:'Road blocked',source:'My report'}),'full');
});
