import assert from 'node:assert/strict';
import test from 'node:test';
import '../../assets/live-grade.js';

const {createGradeTracker}=globalThis.routeWeatherLiveGrade;
const makeTracker=()=>createGradeTracker((a,b)=>Math.abs(b[0]-a[0])*10000);
const fix=(i,grade,extra={})=>({
  longitude:i*.003,latitude:40,altitude:100+i*.3*grade,
  speed:30,accuracy:5,altitudeAccuracy:4,...extra
});

test('estimates signed grade over enough distance and tolerates one altitude spike',()=>{
  for(const slope of [5,-5]){
    const tracker=makeTracker();
    assert.equal(tracker.update(fix(0,slope),1000),null);
    let grade;
    for(let i=1;i<=8;i++){
      const coords=fix(i,slope);
      if(i===7)coords.altitude+=45;
      grade=tracker.update(coords,1000+i*1000);
    }
    assert(Math.abs(grade-slope)<1.4);
    assert.equal(tracker.update(fix(9,slope,{speed:0}),10000),null);
    assert.equal(tracker.update(fix(10,slope),11000),null);
  }
});

test('rejects inaccurate altitude and resets between separate GPS sessions',()=>{
  const tracker=makeTracker();
  for(let i=0;i<=8;i++)tracker.update(fix(i,4),1000+i*1000);
  assert.equal(tracker.update(fix(9,4,{altitudeAccuracy:30}),10000),null);
  assert.equal(tracker.update(fix(10,4),11000),null);
  assert.equal(tracker.reset(),null);
  assert.equal(tracker.update(fix(11,4),12000),null);
});
