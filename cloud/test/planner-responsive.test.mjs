import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../assets/index.html',import.meta.url),'utf8');
const start=html.indexOf('async function buildTrip('),end=html.indexOf('\nasync function refreshWeather',start);
function setup(){
 const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{value:id==='departureMode'?'now':'',classList:{add(){}},style:{}});return elements.get(id)};
 let finishForecast;const forecast=new Promise(r=>finishForecast=r);const calls=[];
 const c=vm.createContext({document:{activeElement:null},$:element,Date,Number,URLSearchParams,Object,console,
 planning:false,destinationChoicePending:false,routeRevision:0,map:{invalidateSize(){}},trip:null,
 plannerInputs:()=>({start:'Bakersfield, CA',end:'Birmingham, AL',via:'',breaks:'0'}),
 geocode:async(text)=>({lon:text.startsWith('Bakersfield')?-119:-86.8,lat:34,label:text}),
 status:text=>calls.push(text),api:async()=>({routes:[{geometry:{coordinates:[[-119,35],[-86.8,33.5]]},duration:100,distance:1000,legs:[]}]}),
 sampleRoute:()=>[{lat:35,lon:-119,distance:0},{lat:33.5,lon:-86.8,distance:1000}],
 resetVoiceGuidance(){},rememberDestination(){},selected:0,pinning:false,closeSurfaces(){},renderRoute(){},setTab(){},gpsFollowing:false,fitRoute(){},syncTrafficScope(){},renderRoadMarkers(){},window:{matchMedia:()=>({matches:false})},
 save:()=>calls.push('saved'),renderPanel(){},renderForecastPoints(){},fetchForecasts:()=>forecast,updateDrive(){}});
 vm.runInContext(html.slice(start,end),c);return {c,calls,finishForecast,element};
}
test('route is usable and planning unlocks while weather is still pending',async()=>{const {c,element,finishForecast}=setup();assert.equal(await c.buildTrip(),true);assert.equal(c.planning,false);assert.equal(element('plan').disabled,false);assert.equal(c.trip.points.length,2);finishForecast(0);});
test('late weather from a previous route cannot save or overwrite new route status',async()=>{const {c,calls,finishForecast}=setup();await c.buildTrip();c.routeRevision++;const before=calls.length;finishForecast(0);await new Promise(r=>setImmediate(r));assert.equal(calls.length,before);});
