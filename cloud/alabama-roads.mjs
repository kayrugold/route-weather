export const ALGO_EVENTS='https://api.algotraffic.com/v4.0/TrafficEvents?includeGeometry=true';

export function normalizeAlabama(data, now=Date.now()) {
  const events=Array.isArray(data)?data:data?.type==='FeatureCollection'&&Array.isArray(data.features)?data.features.map(f=>f.properties):null;
  if(!events||events.some(p=>!p||p.id==null||!p.type))throw Error('Invalid ALGO traffic feed: '+(Array.isArray(data)?'array':Object.keys(data||{}).join(',')));
  return events.flatMap(p=>{
    if(!p||p.active===false||(p.end&&Date.parse(p.end)<now)||(p.start&&Date.parse(p.start)>now))return [];
    const lat=p.startLocation?.latitude,lon=p.startLocation?.longitude;
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<30||lat>35.1||lon< -88.6||lon> -84.8)return [];
    const closed=p.laneDirections?.some(d=>{
      const through=d.lanes?.filter(l=>l.type==='ThroughLane')||[];
      return through.length>0&&through.every(l=>l.state==='Closed');
    });
    return [{id:'AL-'+p.id,type:closed?'full':p.type==='Roadwork'?'work':'incident',
      title:String(p.title||p.type||'Traffic event'),place:String(p.subTitle||p.shortSubTitle||''),
      description:String(p.description||''),direction:String(p.startLocation?.direction||''),
      updated:Date.parse(p.lastUpdatedAt)||null,lat,lon,source:'ALDOT / ALGO Traffic'}];
  });
}
let cached;
export async function handleAlabamaRoads(request, fetcher=fetch) {
  if(request.method!=='GET')return new Response(null,{status:405});
  if(cached&&Date.now()-cached.checked<120000)return Response.json(cached);
  try{
    const response=await fetcher(ALGO_EVENTS,{headers:{Accept:'application/geo+json'},signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('ALGO HTTP '+response.status);
    const items=normalizeAlabama(await response.json());
    cached={items,checked:Date.now(),limited:false,source:'ALDOT / ALGO Traffic'};
    return Response.json(cached,{headers:{'Cache-Control':'public, max-age=120'}});
  }
  catch(error){
    console.error('ALGO feed failed',{name:error.name,message:error.message});
    return Response.json({error:'ALGO traffic is unavailable. Conditions are unknown; retry or check the official map.'},{status:502});
  }
}
