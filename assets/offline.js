const offlineRouteKey='route-weather-android-offline-route';
const downloadedMapPreference='route-weather-android-show-downloaded-map';
let offlineRoute=null,androidBaseMap,downloadedMapEnabled=false;
try{
  offlineRoute=JSON.parse(localStorage.getItem(offlineRouteKey));
  downloadedMapEnabled=!!offlineRoute&&localStorage.getItem(downloadedMapPreference)==='true';
}catch{}
function syncDownloadedMapButton(){
  const button=document.getElementById('useDownloadedMap');
  button.disabled=!offlineRoute;
  button.setAttribute('aria-pressed',String(downloadedMapEnabled));
  button.textContent=downloadedMapEnabled?'Downloaded map · On':'Downloaded map';
}
function refreshDownloadedMap(){
  streetSource=null;
  streetTiles.clear();
  syncStreetMap();
}
const offlineMapLimit=50_000_000;
function corridorTiles(coordinates){
  const urls=[];
  for(let z=7;z<=14;z++){
    const tiles=new Set();
    let previous=null;
    for(const [lon,lat] of coordinates){
      const point=map.project([lat,lon],z).divideBy(256);
      const steps=previous?Math.max(1,Math.ceil(previous.distanceTo(point)*2)):1;
      if(steps>3000)throw Error('This route is too large to download as one map.');
      for(let i=1;i<=steps;i++){
        const sample=previous?previous.add(point.subtract(previous).multiplyBy(i/steps)):point;
        const center=sample.floor();
        for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
          const x=(center.x+dx+2**z)%2**z,y=center.y+dy;
          if(y>=0&&y<2**z)tiles.add(x+'/'+y);
        }
        if(urls.length+tiles.size>3000)throw Error('This route is too large to download as one map.');
      }
      previous=point;
    }
    for(const tile of tiles)urls.push(z+'/'+tile);
  }
  return urls;
}
async function downloadOfflineRoute(button){
  if(!trip){closeSurfaces();status('Plan a route before downloading its map.');return}
  if(!AndroidRoute.wifi()){closeSurfaces();status('Connect to Wi-Fi to download the route map.');return}
  const coordinates=trip.route.geometry.coordinates;
  const label=trip.points.at(-1)?.label||'planned route';
  const cacheName='route-weather-offline-'+Date.now();
  const prior=offlineRoute;
  button.disabled=true;
  closeSurfaces();
  let failed=false;
  try{
    const tiles=corridorTiles(coordinates);
    status('Downloading '+tiles.length+' route map tiles over Wi-Fi…');
    const index=await routeProviderFetch('https://tiles.openfreemap.org/planet',{wifiOnly:true,signal:AbortSignal.timeout(15000)});
    if(!index.ok)throw Error('Could not get the map catalog.');
    const template=(await index.json()).tiles?.[0];
    if(!template||new URL(template).origin!=='https://tiles.openfreemap.org')throw Error('Map catalog unavailable.');
    const cache=await caches.open(cacheName);
    let bytes=0,next=0,done=0;
    await Promise.allSettled(Array.from({length:3},async()=>{
      while(!failed&&next<tiles.length){
        try{
          const [z,x,y]=tiles[next++].split('/');
          const url=template.replace('{z}',z).replace('{x}',x).replace('{y}',y);
          const response=await routeProviderFetch(url,{wifiOnly:true,signal:AbortSignal.timeout(20000)});
          if(!response.ok)throw Error('Map tile unavailable.');
          const body=await response.arrayBuffer();
          bytes+=body.byteLength;
          if(bytes>offlineMapLimit)throw Error('Map download exceeded 50 MB.');
          await cache.put(url,new Response(body,{headers:response.headers}));
          done++;
          if(done%20===0)status('Downloading route map · '+done+' / '+tiles.length+'…');
        }catch(error){failed=error;break}
      }
    }));
    if(failed)throw failed;
    localStorage.setItem(offlineRouteKey,JSON.stringify({name:cacheName,template}));
    offlineRoute={name:cacheName,template};
    if(prior)caches.delete(prior.name).catch(()=>{});
    syncDownloadedMapButton();
    if(downloadedMapEnabled)refreshDownloadedMap();
    status('Route map saved for '+label+' · '+(bytes/1e6).toFixed(1)+' MB. Turn it on in Menu → Downloaded map.');
  }catch(error){
    await caches.delete(cacheName).catch(()=>{});
    status(AndroidRoute.wifi()?error.message+' Retry the map download.':'Wi-Fi disconnected. Retry when connected.',true);
  }finally{button.disabled=false}
}
document.getElementById('downloadOfflineMap').onclick=event=>downloadOfflineRoute(event.currentTarget);
window.addEventListener('online',()=>syncStreetMap());
window.addEventListener('offline',()=>syncStreetMap());
document.getElementById('useDownloadedMap').onclick=()=>{
  if(!offlineRoute)return;
  downloadedMapEnabled=!downloadedMapEnabled;
  try{localStorage.setItem(downloadedMapPreference,String(downloadedMapEnabled))}catch{}
  syncDownloadedMapButton();
  closeSurfaces();
  refreshDownloadedMap();
};
window.addEventListener('DOMContentLoaded',()=>{
  syncDownloadedMapButton();
  if(downloadedMapEnabled)syncStreetMap();
});
window.routeWeatherCompass=course=>{
  if(watch===null||!gpsPosition||movingForHeading)return;
  lastCompassSample=performance.now();
  compassCourse=compassCourse==null?course:wrapHeading(compassCourse+.35*signedHeadingDelta(course,compassCourse));
  driveCourse=compassCourse;
  headingSource='Android compass · true north';
  showDriveCourse();
};
