import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {handleTomTom} from '../tomtom.mjs';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../../assets/truck-facilities.js', import.meta.url), 'utf8'), context);
const {truckBrand, viewportBoxes} = context.routeWeatherFacilities;

test('truck-stop brands keep Petro, TA, Pilot, Loves, Fleet and independent markers distinct', () => {
  for (const [name, expected] of [['Pilot Travel Center','pilot'],['Flying J','pilot'],["Love’s Travel Stop",'loves'],
    ['Petro Stopping Center','petro'],['TA Travel Center','ta'],['TravelCenters of America','ta'],
    ['Fleet Truck Stop','fleet'],['Desert Truck Stop','independent'],['Petroleum Fuel','independent']]) {
    assert.equal(truckBrand({name}), expected);
  }
  assert.equal(truckBrand({name:'Exit 12',brand:'Pilot'}),'pilot');
});

test('facility viewports split at the date line and wrap repeated worlds', () => {
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(viewportBoxes(170,50,190,70)),[[170,50,180,70],[-180,50,-170,70]]);
  assert.deepEqual(plain(viewportBoxes(238,35,240,37)),[[-122,35,-120,37]]);
  assert.deepEqual(plain(viewportBoxes(-200,-89,200,89)),[[-180,-85,180,85]]);
});

test('facility searches use US category and viewport filters, pagination and brand metadata', async () => {
  const env = {TOMTOM_API_KEY:'test',QUOTA:{getByName:()=>({fetch:async()=>new Response(null,{status:204})})}};
  for (const [kind,category] of [['truck-stops','7358'],['weigh-stations','7359']]) {
    const request = new Request('https://example.com/api/search?mode=facilities&kind='+kind+'&bbox=-123,37,-121,40&offset=100');
    const response = await handleTomTom(request,'/search',env,'app', async url => {
      const upstream = new URL(url);
      assert.equal(upstream.searchParams.get('categorySet'),category);
      assert.equal(upstream.searchParams.get('topLeft'),'40,-123');
      assert.equal(upstream.searchParams.get('btmRight'),'37,-121');
      assert.equal(upstream.searchParams.get('countrySet'),'US');
      assert.equal(upstream.searchParams.get('ofs'),'100');
      assert.equal(upstream.searchParams.has('radius'),false);
      return Response.json({summary:{totalResults:101,offset:100},results:[{id:'stop-1',poi:{name:'Pilot',brands:[{name:'Pilot'}]},position:{lat:38,lon:-122},address:{freeformAddress:'Main St'}}]});
    });
    const data = await response.json();
    assert.equal(data.total,101); assert.equal(data.offset,100); assert.equal(data.items[0].brand,'Pilot');
  }
  for (const query of ['bbox=1,2,0,3','bbox=NaN,2,3,4','bbox=-123,37,-121,40&offset=-1','bbox=-123,37,-121,40&offset=1000']) {
    const response=await handleTomTom(new Request('https://example.com/api/search?mode=facilities&kind=truck-stops&'+query),'/search',env,'app',()=>{throw Error('Must not call upstream');});
    assert.equal(response.status,400);
  }
});
