(() => {
  if (!map) return;
  const mile=1.609344;
  const quickMap='https://quickmap.dot.ca.gov/';
  const scannerBase='https://status.broadcastify.com/listen/';
  const crimeSource='https://www.cityofsacramento.gov/police/crime-and-safety/dispatch-and-crime-data-portal';
  const crimeQuery='https://services5.arcgis.com/54falWtcpty3V47Z/ArcGIS/rest/services/Sacramento%20Report%20Data%202026/FeatureServer/0/query';
  const pacific=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
  const pacificOffset=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',timeZoneName:'shortOffset'});
  const incidentLayer=L.layerGroup().addTo(map);
  const roadNotice=$('roadAheadNotice');
  const lookaheadKey='route-weather-road-lookahead';
  let lookaheadMiles=(()=>{try{const v=Number(localStorage.getItem(lookaheadKey));return [10,20,30].includes(v)?v:20}catch{return 20}})();
  const lookaheadSelect=$('roadAheadMiles');
  if(lookaheadSelect){
    lookaheadSelect.value=String(lookaheadMiles);
    lookaheadSelect.onchange=()=>{
      const next=Number(lookaheadSelect.value);
      lookaheadMiles=[10,20,30].includes(next)?next:20;
      try{localStorage.setItem(lookaheadKey,String(lookaheadMiles))}catch{}
      checkRoadAhead(true);
    };
  }
  const {createRoadDisplay,hazardKind}=window.routeWeatherRoadDisplay;
  const hazardNames={full:'Closure',collision:'Collision',stopped:'Stopped vehicle',debris:'Debris',police:'CHP report',
    hold:'Truck hold',lane:'Lane closure',chain:'Chain controls',winter:'Winter advisory',work:'Road work',incident:'Road hazard'};
  let aheadMarkers=[],noticeTimer,noticeKey;
  const announced=new Map();
  const aheadLayer=createRoadDisplay(L,bounds=>aheadMarkers.filter(report=>bounds.contains([report.lat,report.lon])),showRoadGroup);
  window.pickRoadAhead=point=>aheadLayer.handleClick(point);
  function hideRoadNotice(){
    clearTimeout(noticeTimer);
    roadNotice.hidden=true;
    noticeKey=null;
  }
  function reportKey(report){
    if(report.source===communitySource)return report.id;
    return [report.source,report.title,report.lat.toFixed(4),report.lon.toFixed(4),report.direction||''].join('|');
  }
  let roadEnabled=false,roadReports=[],roadFetched=0,roadCheck=null,roadSources='',roadScope='',coverageCheckAt=0,lastCoverageRoute,lastCoverageAlong=NaN;
  const currentView=()=>map.getCenter().wrap();
  function readPreference(key){try{return localStorage.getItem(key)==='true'}catch{return false}}
  function savePreference(key,value){try{localStorage.setItem(key,String(value))}catch{}}
  function sourceLink(label,href){const a=document.createElement('a');a.href=href;a.textContent=label;a.target='_blank';a.rel='noopener noreferrer';return a}
  function pressed(id,value){$(id).setAttribute('aria-pressed',String(value))}
  function parsePacific(value){
    const m=value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([ap])m$/i);
    if(!m)return NaN;
    const hour=Number(m[4])%12+(m[6].toLowerCase()==='p'?12:0);
    const loose=Date.UTC(Number(m[3]),Number(m[1])-1,Number(m[2]),hour,Number(m[5]));
    const zone=pacificOffset.formatToParts(loose+8*3600000).find(part=>part.type==='timeZoneName')?.value;
    const offset=Number(zone?.match(/GMT([+-]\d+)/)?.[1]);
    return Number.isFinite(offset)?loose-offset*3600000:NaN;
  }
  function parseChp(xml,now=Date.now()){
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.querySelector('parsererror')||doc.documentElement.localName!=='kml')throw Error('CHP feed is unreadable');
    let latest=0;
    const items=[];
    for(const place of doc.querySelectorAll('Placemark')){
      const html=place.querySelector('description')?.textContent||'';
      // Parse text fields only; never attach provider markup to the app.
      const updated=html.match(/Last updated:\s*<strong>([^<]+)<\/strong>\s*([\d:]+\s*[ap]m)/i);
      const stamp=updated?parsePacific(updated.slice(1).join(' ')):NaN;
      if(Number.isFinite(stamp))latest=Math.max(latest,stamp);
      const title=html.match(/<h2[^>]*class="iw-title"[^>]*>([^<]*)<\/h2>/i)?.[1]?.trim();
      if(!title||!/(?:collision|traffic accident|hit and run|traffic break|road closure|full closure|obstruction|hazard|debris|blocked|disabled vehicle|^TC[- ]|^11(?:79|80|81|82)[- ])/i.test(title))continue;
      const point=place.querySelector('coordinates')?.textContent.trim().split(',').map(Number)||[];
      if(point.length<2||!point.slice(0,2).every(Number.isFinite))continue;
      const location=html.match(/<p class="iw-text">[^<]*<br\s*\/?>\s*([^<]+)/i)?.[1]?.trim()||'';
      const direction=location.match(/\b(?:I|US|SR)\s*-?\s*\d+\s*(NB|SB|EB|WB|N|S|E|W)\b/i)?.[1];
      items.push({lon:point[0],lat:point[1],title,place:location,direction,source:'CHP',type:'incident',updated:stamp});
    }
    if(doc.querySelector('Placemark')&&(!latest||Math.abs(now-latest)>30*60000))throw Error('CHP feed is stale');
    return {items,latest};
  }
  let chpPromise,chpResult;
  function loadChp(){
    if(chpResult&&Date.now()-chpResult.checked<120000)return Promise.resolve(chpResult);
    chpPromise ||= (async()=>{
      const reply=await routeProviderFetch(quickMap+'data/chp-only.kml',{signal:AbortSignal.timeout(10000)});
      if(!reply.ok)throw Error('CHP unavailable');
      return chpResult={...parseChp(await reply.text()),checked:Date.now()};
    })().finally(()=>{chpPromise=null});
    return chpPromise;
  }
  window.readChpRoadEvents=loadChp;
  async function loadClosures(){
    const reports=[],failed=[];
    for(let start=1;start<=12;start+=4){
      const result=await Promise.allSettled(Array.from({length:4},(_,i)=>api('/api/roads?district='+(start+i)+'&feeds=lcs')));
      for(const entry of result){
        if(entry.status==='rejected'||entry.value.failures?.length){failed.push(1);continue}
        reports.push(...entry.value.items.filter(item=>item.type==='closure').map(item=>({...item,source:'Caltrans'})));
      }
    }
    return {items:reports,failed:failed.length};
  }
  function roadOrigin(){
    if(trip?.route?.geometry?.coordinates?.length){
      const geometry=trip.route.geometry.coordinates;
      if(watch===null)return {geometry,along:0,gps:false};
      if(!gpsPosition)return null;
      const progress=projectOnRoute(geometry,[gpsPosition[1],gpsPosition[0]]);
      if(progress.best<=.5)return {geometry,along:progress.along,gps:true};
    }
    // Free-drive look-ahead using live GPS (or map center) so CHP/DOT obstacles still appear without a planned route
    if(gpsPosition&&Number.isFinite(gpsPosition[0])&&Number.isFinite(gpsPosition[1])){
      return {freeDrive:true,lat:gpsPosition[0],lon:gpsPosition[1],gps:true};
    }
    const c=currentView();
    if(c&&Number.isFinite(c.lat)&&Number.isFinite(c.lng)){
      return {freeDrive:true,lat:c.lat,lon:c.lng,gps:false};
    }
    return null;
  }
  let reportProjections=new WeakMap(), projectionRoute;
  function nearbyRoadReports(reports,origin,now=Date.now()){
    if(origin.freeDrive){
      const matches=[];
      for(const report of reports){
        if(!Number.isFinite(report.lat)||!Number.isFinite(report.lon)||report.start>now||report.end&&report.end<=now)continue;
        if(/rest area|park\s*&\s*ride/i.test([report.title,report.description].filter(Boolean).join(' ')))continue;
        const distMi=km([origin.lon,origin.lat],[report.lon,report.lat])/mile;
        if(distMi<=lookaheadMiles)matches.push({...report,distance:distMi});
      }
      return matches.sort((a,b)=>a.distance-b.distance);
    }
    if(projectionRoute!==origin.geometry){
      projectionRoute=origin.geometry;
      reportProjections=new WeakMap();
    }
    const corridor=roadCorridor(origin).geometry.coordinates;
    if(!corridor.length)return [];
    let west=180,east=-180,south=90,north=-90;
    for(const [lon,lat] of corridor){
      west=Math.min(west,lon);east=Math.max(east,lon);
      south=Math.min(south,lat);north=Math.max(north,lat);
    }
    // Reject distant point reports before projecting them onto detailed route geometry.
    const matches=[];
    for(const report of reports){
      if(!Number.isFinite(report.lat)||!Number.isFinite(report.lon)||report.start>now||report.end&&report.end<=now)continue;
      if(/rest area|park\s*&\s*ride/i.test([report.title,report.description].filter(Boolean).join(' ')))continue;
      const segment=report.type==='closure'&&Number.isFinite(report.endLat)&&Number.isFinite(report.endLon);
      if(!segment&&(report.lat<south-.01||report.lat>north+.01||
        west>=-179.96&&east<=179.96&&east-west<180&&(report.lon<west-.04||report.lon>east+.04)))continue;
      let projection=reportProjections.get(report);
      if(!projection){
        projection={position:projectOnRoute(origin.geometry,[report.lon,report.lat]),
          end:segment?projectOnRoute(origin.geometry,[report.endLon,report.endLat]):null};
        reportProjections.set(report,projection);
      }
      const {position,end}=projection;
      const direction=/^(N(?:B|ORTH(?:BOUND)?)?|E(?:B|AST(?:BOUND)?)?|S(?:B|OUTH(?:BOUND)?)?|W(?:B|EST(?:BOUND)?)?)$/i.exec(report.direction?.trim()||'');
      const cardinal={N:0,E:90,S:180,W:270}[direction?.[1]?.[0]?.toUpperCase()];
      if(Number.isFinite(cardinal)&&Number.isFinite(position.heading)&&
        Math.abs((position.heading-cardinal+540)%360-180)>105)continue;
      let onRoute=position.best<=.14;
      let distance=position.along-origin.along;
      if(end){
        if(end.best<=.14){
          const endDistance=end.along-origin.along;
          if(!onRoute)distance=endDistance;
          else if(Math.max(distance,endDistance)>=0)distance=Math.max(0,Math.min(distance,endDistance));
          onRoute=true;
        }
      }
      if(!onRoute||distance<-.08||distance>lookaheadMiles*mile)continue;
      matches.push({...report,distance:Math.max(0,distance)/mile});
    }
    return matches.sort((a,b)=>a.distance-b.distance);
  }
  const obstructionKey='route-weather-local-obstructions';
  const communitySource='Route Weather drivers';
  const communityEndpoint='/api/road-reports';
  const reporterKey='route-weather-road-reporter';
  let reporterId,sharedReports=[],sharedChecked=0,sharedReceived=0,sharedRoute,sharedAlong,sharedRequest;

  function roadReporter(){
    if(reporterId)return reporterId;
    try{reporterId=localStorage.getItem(reporterKey)}catch{}
    if(!reporterId){
      reporterId=crypto.randomUUID();
      try{localStorage.setItem(reporterKey,reporterId)}catch{}
    }
    return reporterId;
  }

  async function updateSharedReport(report,action){
    const response=await fetch(communityEndpoint,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:report.id,reporter:roadReporter(),action,
        ...(action==='create'?{title:report.title,lat:report.lat,lon:report.lon}:{})}),
      signal:AbortSignal.timeout(10000),credentials:'omit'
    });
    if(!response.ok){
      const error=await response.json().catch(()=>null);
      throw Error(error?.error||'Could not reach shared reports.');
    }
    return response.json();
  }

  function checkSharedReports(origin,force){
    if(!origin||navigator.onLine===false)return;
    const now=Date.now();
    if(!force&&sharedRoute===origin.geometry&&
      now-sharedChecked<(Math.abs(sharedAlong-origin.along)>1.6?15000:45000))return;
    const point=roadCorridor(origin).geometry.coordinates[0];
    if(!point)return;
    sharedRequest?.abort();
    if(sharedRoute!==origin.geometry)sharedReports=[];
    sharedRoute=origin.geometry;
    sharedAlong=origin.along;
    sharedChecked=now;
    const controller=sharedRequest=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),10000);
    const query=new URLSearchParams({lat:point[1].toFixed(3),lon:L.Util.wrapNum(point[0],[-180,180]).toFixed(3)});
    fetch(communityEndpoint+'?'+query,{signal:controller.signal,credentials:'omit'})
      .then(reply=>reply.ok?reply.json():null)
      .then(data=>{
        if(sharedRequest!==controller)return;
        if(Array.isArray(data?.reports)){
          sharedReceived=Date.now();
          sharedReports=data.reports.map(report=>({...report,source:communitySource}));
        }
      })
      .catch(()=>{})
      .finally(()=>{
        clearTimeout(timeout);
        if(sharedRequest!==controller)return;
        sharedRequest=null;
        updateRoadAhead();
      });
  }

  function sharedReportDetails(report){
    if(report.source!==communitySource)return null;
    const content=document.createElement('section');
    const heading=document.createElement('strong');
    heading.textContent=report.title;
    const details=document.createElement('p');
    details.textContent='Driver report · Expires at '+time(report.end)+
      (report.confirmed?' · Confirmed at '+time(report.confirmed):'');
    const actions=document.createElement('div');
    actions.className='road-group-list';
    const result=document.createElement('small');
    result.setAttribute('role','status');
    for(const [label,action] of [['Still there','still-there'],['No longer there','clear']]){
      const button=document.createElement('button');
      button.type='button';
      button.textContent=label;
      button.onclick=async event=>{
        event.stopPropagation();
        if(navigator.onLine===false){result.textContent='Offline. No update sent.';return}
        for(const control of actions.children)control.disabled=true;
        try{
          const response=await updateSharedReport(report,action);
          if(response.cleared){
            sharedReports=sharedReports.filter(item=>item.id!==report.id);
            if(content.isConnected)closeStateRoadPopup();
          }else{
            result.textContent=action==='clear'?'Marked clear. Waiting for another driver to confirm.':'Thanks for confirming.';
          }
          checkSharedReports(roadEnabled&&roadOrigin(),true);
          updateRoadAhead();
        }catch(error){result.textContent=error.message||'Could not send the update.'}
        finally{for(const control of actions.children)control.disabled=false}
      };
      actions.append(button);
    }
    content.append(heading,details,actions,result);
    return content;
  }
  window.sharedRoadReportDetails=sharedReportDetails;
  const obstructionLayer=L.layerGroup().addTo(map);
  const types=new Set([...document.querySelectorAll('[data-obstruction]')].map(button=>button.dataset.obstruction));
  let obstructionReports=[];
  try {
    const saved=JSON.parse(localStorage.getItem(obstructionKey)||'[]');
    obstructionReports=saved.filter(item=>types.has(item.title)&&Number.isFinite(item.lat)&&Math.abs(item.lat)<=90
      &&Number.isFinite(item.lon)&&Math.abs(item.lon)<=180&&Number.isFinite(item.end)&&item.end>Date.now()
      &&typeof item.id==='string').slice(0,30).map(item=>({...item,source:'My report'}));
  }catch{}
  function persistObstructions(){
    try{localStorage.setItem(obstructionKey,JSON.stringify(obstructionReports));return true}catch{return false}
  }
  function renderObstructions(){
    obstructionLayer.clearLayers();
    for(const report of obstructionReports){
      const content=document.createElement('section'), remove=document.createElement('button');
      content.textContent=report.title+' · My report. Expires at '+time(report.end)+'. ';
      remove.type='button';
      remove.textContent='Remove';
      content.append(remove);
      const [symbol,,color]=roadCategories[hazardKind(report)];
      const marker=L.marker([report.lat,report.lon],{
        icon:L.divIcon({className:'road-icon viewport-road',html:'<span style="background:'+color+'">'+symbol+'</span>',
          iconSize:[29,29],iconAnchor:[14,14]}),
        title:report.title+' · My report'
      }).addTo(obstructionLayer);
      marker.on('click',()=>{
        showStateRoadPopup(report);
        remove.onclick=()=>{
          obstructionReports=obstructionReports.filter(item=>item.id!==report.id);
          persistObstructions();
          closeStateRoadPopup();
          renderObstructions();
          updateRoadAhead();
        };
        stateRoadPopup?.setContent(content);
      });
    }
  }
  renderObstructions();
  const reportButtons=[...document.querySelectorAll('[data-obstruction]')];
  const openObstruction=()=>{
    openSurface('obstructionDialog');
    $('obstructionStatus').textContent='';
  };
  $('roadAheadReport').onclick=openObstruction;
  for(const button of reportButtons)button.onclick=()=>{
    const note=$('obstructionStatus');
    if(navigator.onLine===false){note.textContent='Offline. No report sent.';return}
    for(const option of reportButtons)option.disabled=true;
    note.textContent='Getting your GPS location…';
    const done=()=>{for(const option of reportButtons)option.disabled=false};
    androidLocation.getCurrentPosition(async ({coords})=>{
      try{
        if(!$('obstructionDialog').open)return;
        if(!Number.isFinite(coords.latitude)||!Number.isFinite(coords.longitude)||!Number.isFinite(coords.accuracy)||coords.accuracy>100){
          note.textContent='GPS was too imprecise. Try again from a clear spot.';return;
        }
        if(navigator.onLine===false){note.textContent='Offline. No report sent.';return}
        note.textContent='Sharing report…';
        await updateSharedReport({id:crypto.randomUUID(),title:button.dataset.obstruction,
          lat:Number(coords.latitude.toFixed(5)),lon:Number(coords.longitude.toFixed(5))},'create');
        if($('obstructionDialog').open)$('obstructionDialog').close();
        checkSharedReports(roadEnabled&&roadOrigin(),true);
        status('Shared with Route Weather drivers.');
      }catch(error){note.textContent=error.message||'Could not share the report.'}
      finally{done()}
    },error=>{done();note.textContent=error.message||'Could not get your location.'},
    {enableHighAccuracy:true,timeout:12000,maximumAge:10000});
  };

  function updateRoadAhead(){
    const origin=roadEnabled&&roadOrigin();
    const expired=obstructionReports.filter(item=>item.end<=Date.now());
    if(expired.length){
      obstructionReports=obstructionReports.filter(item=>item.end>Date.now());
      persistObstructions();renderObstructions();
    }
    const now=Date.now();
    const agency=now-roadFetched<6*60000?roadReports:[];
    const community=sharedRoute===origin?.geometry&&now-sharedReceived<120000?sharedReports:[];
    const reports=origin?nearbyRoadReports([...agency,...community,...obstructionReports],origin)
      .map(report=>({...report,kind:hazardKind(report,roadKind(report))})):[];

    // Saved obstructions already have their own removable marker.
    aheadMarkers=reports.filter(report=>report.source!=='My report');
    if(aheadMarkers.length){
      if(!map.hasLayer(aheadLayer))aheadLayer.addTo(map);
      else aheadLayer.refresh();
    }else if(map.hasLayer(aheadLayer))map.removeLayer(aheadLayer);

    const following=origin?.gps&&gpsFollowing&&gpsPosition&&map.getBounds().contains(gpsPosition)&&
      !document.hidden&&!document.querySelector('dialog[open]');
    if(!following||noticeKey&&!reports.some(report=>reportKey(report)===noticeKey))hideRoadNotice();
    if(following&&roadNotice.hidden){
      for(const [key,at] of announced)if(now-at>90*60000)announced.delete(key);
      const first=reports.find(report=>!announced.has(reportKey(report)));
      if(first){
        noticeKey=reportKey(first);
        announced.set(noticeKey,now);
        roadNotice.textContent=(hazardNames[first.kind]||'Road report')+' · '+first.distance.toFixed(1)+' mi ahead';
        roadNotice.hidden=false;
        noticeTimer=setTimeout(hideRoadNotice,6500);
      }
    }
    if(!$('roadAheadDialog').open)return;
    $('roadAheadStatus').textContent=!roadEnabled?'Turn on Road ahead to check reports.':
      !origin?'Waiting for GPS or map location.':
      (roadCheck?'Checking reports…':roadSources||'Waiting for reports')+' · Next '+lookaheadMiles+' miles '+(origin.freeDrive?(origin.gps?'around GPS':'around map'):(origin.gps?'from GPS':'from start'));
    $('roadAheadList').replaceChildren(...reports.map(report=>{
      const item=document.createElement('li');
      const button=document.createElement('button');
      button.type='button';
      button.textContent=report.distance.toFixed(1)+' mi · '+(hazardNames[report.kind]||'Road report')+
        [report.place,report.source].filter(Boolean).map(text=>' · '+text).join('');
      button.onclick=()=>{
        $('roadAheadDialog').close();
        if(!map.getBounds().contains([report.lat,report.lon])){
          pauseGpsFollow();
          map.panTo([report.lat,report.lon],{animate:false});
        }
        showStateRoadPopup(report);
      };
      item.append(button);
      return item;
    }));
    if(!reports.length&&origin&&!roadCheck&&roadFetched){
      const item=document.createElement('li');item.textContent='No matching reports in the available feeds.';$('roadAheadList').append(item);
    }
  }
  function roadCorridor(origin){
    if(origin.freeDrive){
      return {geometry:{coordinates:[[origin.lon,origin.lat],[origin.lon+0.01,origin.lat+0.01]]}};
    }
    const points=[];
    let along=0;
    for(let i=1;i<origin.geometry.length;i++){
      const a=origin.geometry[i-1],b=origin.geometry[i];
      const length=km(a,b), end=along+length;
      if(length&&end>=origin.along&&along<=origin.along+lookaheadMiles*mile){
        for(const distance of [Math.max(along,origin.along),Math.min(end,origin.along+lookaheadMiles*mile)]){
          const fraction=(distance-along)/length;
          points.push([a[0]+((b[0]-a[0]+540)%360-180)*fraction,a[1]+(b[1]-a[1])*fraction]);
        }
      }
      along=end;
      if(along>origin.along+lookaheadMiles*mile)break;
    }
    return {geometry:{coordinates:points}};
  }
  async function stateAgencyReports(code){
    if(code==='CA'){
      const [chp,caltrans]=await Promise.allSettled([loadChp(),loadClosures()]);
      const items=[...(chp.value?.items||[]),...(caltrans.value?.items||[])];
      const anyFeed=chp.status==='fulfilled'||caltrans.value?.failed<12;
      if(!anyFeed)throw Error('CA feeds unavailable');
      return {items,limited:chp.status!=='fulfilled'||caltrans.status!=='fulfilled'||caltrans.value.failed>0};
    }
    const prior=stateRoadReports.get(code);
    if(prior?.items&&Date.now()-prior.checked<120000)return {...prior,items:prior.items.filter(item=>item.type!=='cctv')};
    return api('/api/state-road-overlay?state='+encodeURIComponent(code)+'&incidents=1');
  }
  function checkRoadAhead(force=false){
    const origin=roadEnabled&&roadOrigin();
    checkSharedReports(origin,force);
    updateRoadAhead();
    if(!origin||roadCheck)return;
    const now=Date.now();
    const moved=Math.abs(origin.along-lastCoverageAlong)>5;
    if(!force&&lastCoverageRoute===origin.geometry&&(!moved&&now-coverageCheckAt<120000||now-coverageCheckAt<15000))return;
    lastCoverageRoute=origin.geometry;lastCoverageAlong=origin.along;coverageCheckAt=now;
    roadCheck=(async()=>{
      const catalog=await getStateRoadDirectory();
      const codes=findRouteStates(roadCorridor(origin),catalog.boundaries);
      const supported=codes.filter(code=>code==='CA'||catalog.directory[code]?.overlay);
      const scope=supported.join(',');
      if(!force&&scope===roadScope&&Date.now()-roadFetched<120000)return;
      const results=await Promise.allSettled(supported.map(stateAgencyReports));
      roadReports=results.flatMap(result=>result.value?.items||[]);
      roadFetched=Date.now();
      roadScope=scope;
      roadSources=[
        ...supported.map((code,i)=>code+' '+(results[i].status!=='fulfilled'?'unavailable':results[i].value.limited?'partial feed':'reports')),
        ...codes.filter(code=>!supported.includes(code)).map(code=>code+' has no in-app feed')
      ].join(' · ')||'No agency feed identified here';
    })().catch(()=>{
      roadSources='Could not check agency coverage. Your reports are still available.';
    }).finally(()=>{roadCheck=null;updateRoadAhead()});
    updateRoadAhead();
  }
  $('openRoadAhead').onclick=()=>{openSurface('roadAheadDialog');checkRoadAhead()};
  roadNotice.onclick=$('openRoadAhead').onclick;
  map.on('dragstart',hideRoadNotice);
  map.on('moveend',()=>{if(!gpsFollowing||!gpsPosition||!map.getBounds().contains(gpsPosition))hideRoadNotice()});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)hideRoadNotice();
    else checkRoadAhead();
  });
  $('roadAheadEnabled').onchange=()=>{
    roadEnabled=$('roadAheadEnabled').checked;savePreference('road-ahead-enabled',roadEnabled);
    pressed('openRoadAhead',roadEnabled);checkRoadAhead(true);
  };
  roadEnabled=readPreference('road-ahead-enabled');
  $('roadAheadEnabled').checked=roadEnabled;
  pressed('openRoadAhead',roadEnabled);
  window.addEventListener('offline',()=>{
    sharedRequest?.abort();
    sharedRequest=null;
    sharedReports=[];
    updateRoadAhead();
  });
  window.addEventListener('online',()=>checkRoadAhead(true));
  setInterval(()=>{if(!document.hidden)checkRoadAhead()},15000);
  window.refreshRoadAhead=checkRoadAhead;
  checkRoadAhead();

  const scannerLayer=L.layerGroup().addTo(map);
  const crimeMapStatus=$('crimeMapStatus');
  const countBands=['#83e2b6','#f3d778','#fd9b9b','#d6afff','#15161b'];
  const sources=[
    {name:'Sacramento Police',city:'Sacramento',center:[38.58,-121.49],bounds:[-121.63,38.42,-121.32,38.7],
      zone:'America/Los_Angeles',url:crimeSource,query:crimeQuery},
    {name:'San Francisco Police',city:'San Francisco',center:[37.77,-122.44],bounds:[-122.53,37.70,-122.35,37.84],
      zone:'America/Los_Angeles',url:'https://data.sf.gov/d/wg3w-h783',query:'https://data.sf.gov/resource/wg3w-h783.json',
      fields:['row_id','incident_datetime','incident_category','incident_description','latitude','longitude']},
    {name:'Seattle Police',city:'Seattle',center:[47.61,-122.33],bounds:[-122.45,47.48,-122.23,47.75],
      zone:'America/Los_Angeles',url:'https://cos-data.seattle.gov/d/tazs-3rd5',query:'https://cos-data.seattle.gov/resource/tazs-3rd5.json',
      fields:['offense_id','report_date_time','offense_sub_category','nibrs_offense_code_description','latitude','longitude'],textCoordinates:true},
    {name:'Chicago Police',city:'Chicago',center:[41.87,-87.63],bounds:[-87.95,41.64,-87.50,42.04],
      zone:'America/Chicago',url:'https://data.cityofchicago.org/d/ijzp-q8t2',query:'https://data.cityofchicago.org/resource/ijzp-q8t2.json',
      fields:['id','date','primary_type','description','latitude','longitude']},
    {name:'Los Angeles Police',city:'Los Angeles',center:[34.05,-118.25],bounds:[-118.67,33.69,-118.15,34.35],
      zone:'America/Los_Angeles',url:'https://data.lacity.org/d/k7nn-b2ep',query:'https://data.lacity.org/resource/k7nn-b2ep.json',
      fields:['uniquenibrno','date_occ','crime_against','nibr_description','hndrdth_lat','hndrdth_lon']},
    {name:'Dallas Police',city:'Dallas',center:[32.78,-96.80],bounds:[-97.01,32.61,-96.45,33.03],
      zone:'America/Chicago',url:'https://www.dallasopendata.com/d/qv6i-rri7',query:'https://www.dallasopendata.com/resource/qv6i-rri7.json',
      fields:['servnumid','reporteddate','offincident','offincident'],textDate:true,pointField:'geocoded_column',uniqueField:'incidentnum'},
    {name:'New York City Police',city:'New York City',center:[40.73,-73.99],bounds:[-74.27,40.49,-73.68,40.92],
      zone:'America/New_York',url:'https://data.cityofnewyork.us/d/5uac-w243',query:'https://data.cityofnewyork.us/resource/5uac-w243.json',
      fields:['cmplnt_num','rpt_dt','ofns_desc','pd_desc','latitude','longitude'],note:'The NYC feed is released by completed quarter. Try 90 days for older reports.'},
    {name:'Baltimore Police',city:'Baltimore',center:[39.30,-76.61],bounds:[-76.73,39.19,-76.52,39.38],
      zone:'America/New_York',url:'https://www.baltimorepolice.org/crime-stats/open-data',
      query:'https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/NIBRS_GroupA_Crime_Data/FeatureServer/0/query',
      arcDate:'CrimeDateTime',arcCategory:'Description',arcId:'RowID'},
    {name:'Philadelphia Police',city:'Philadelphia',center:[39.95,-75.16],bounds:[-75.29,39.86,-74.95,40.15],
      zone:'America/New_York',url:'https://data.phila.gov/visualizations/crime-incidents/',
      query:'https://phl.carto.com/api/v2/sql',carto:true},
    {name:'Kansas City Police',city:'Kansas City',center:[39.10,-94.58],bounds:[-94.83,38.80,-94.33,39.35],
      zone:'America/Chicago',url:'https://data.kcmo.org/d/f7wj-ckmw',query:'https://data.kcmo.org/resource/f7wj-ckmw.json',
      fields:['report','report_date','description','description'],pointField:'location',uniqueField:'report',orderField:':id'},
    {name:'Metro Nashville Police',city:'Nashville',center:[36.16,-86.78],bounds:[-87.08,35.96,-86.51,36.41],
      zone:'America/Chicago',url:'https://www.arcgis.com/home/item.html?id=d747436243e9439e968fce056545016a',
      query:'https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/Metro_Nashville_Police_Department_Incidents_view/FeatureServer/0/query',
      arcDate:'Incident_Reported',arcCategory:'Offense_Description',arcId:'OBJECTID'},
    {name:'San Francisco Police dispatch',city:'San Francisco',center:[37.77,-122.44],bounds:[-122.53,37.70,-122.35,37.84],
      zone:'America/Los_Angeles',url:'https://data.sf.gov/d/gnap-fj3t',query:'https://data.sf.gov/resource/gnap-fj3t.json',
      fields:['cad_number','received_datetime','call_type_final_desc','call_type_final_desc'],pointField:'intersection_point',
      dispatch:true,extraFilter:"sensitive_call = false"},
    {name:'Seattle Fire and EMS dispatch',city:'Seattle',center:[47.61,-122.33],bounds:[-122.45,47.48,-122.23,47.75],
      zone:'America/Los_Angeles',url:'https://cos-data.seattle.gov/d/kzjm-xkqj',query:'https://cos-data.seattle.gov/resource/kzjm-xkqj.json',
      fields:['incident_number','datetime','type','type','latitude','longitude'],dispatch:true},
    {name:'Cincinnati Police dispatch',city:'Cincinnati',center:[39.13,-84.51],bounds:[-84.75,39.05,-84.30,39.27],
      zone:'America/New_York',url:'https://data.cincinnati-oh.gov/d/y8vb-stgi',query:'https://data.cincinnati-oh.gov/resource/y8vb-stgi.json',
      fields:['cadnumber','calldatetime','problemtypedescription','problemtypedescription','lat_x','lon_x'],dispatch:true}
  ];
  const cityProtect=(point)=>'https://www.cityprotect.com/map?'+new URLSearchParams({
    latitude:point.lat.toFixed(5),longitude:point.lng.toFixed(5),zoomLevel:Math.max(10,Math.min(17,map.getZoom()))
  });
  const johnsonCity={lat:36.314,lng:-82.353};
  const directScanners=[
    ['Anderson Police Dispatch',38395,40.448,-122.297],
    ['Redding Public Safety',37932,40.586,-122.391],
    ['CHP Northern Division – Redding Dispatch',39417,40.561,-122.357],
    ['Shasta County Fire and CalFire',46790,40.541,-122.383],
    ['Sacramento County Sheriff and City Police',5688,38.581,-121.494]
  ];
  let crimeRequest,crimeTimer,scannerRefresh=0,scannerView,detailPopup,popupGroup;
  const catalogs=new Map(),reportCache=new Map();

  function groupButton(where,group,label,open){
    const icon=L.divIcon({className:'map-count-badge',html:esc(label),iconSize:[Math.max(34,label.length*8+14),32]});
    const marker=L.marker(where,{icon,title:label,alt:label,riseOnHover:true}).addTo(group);
    marker.on('click',open);
    return marker;
  }
  function detail(where,heading,fill,group){
    popupGroup=group;
    if(detailPopup)map.removeLayer(detailPopup);
    const content=document.createElement('section');
    const title=document.createElement('strong');
    title.textContent=heading;
    content.append(title);
    fill(content);
    detailPopup=L.popup({className:'awareness-popup',closeOnClick:false,autoClose:false,closeOnEscapeKey:false,
      maxWidth:295,minWidth:190,autoPan:true,autoPanPaddingTopLeft:[12,66],autoPanPaddingBottomRight:[12,20]})
      .setLatLng(where).setContent(content).addTo(map);
  }
  function closeLayerDetail(group){
    if(detailPopup&&popupGroup===group){map.removeLayer(detailPopup);detailPopup=null}
  }
  function bindLayerToggle(button,control,update){
    const checkbox=$(control);
    checkbox.onchange=()=>{
      pressed(button,checkbox.checked);
      update();
    };
    $(button).onclick=()=>{
      checkbox.checked=!checkbox.checked;
      checkbox.onchange();
    };
  }
  function paragraph(parent,copy){
    const p=document.createElement('p');
    p.textContent=copy;
    parent.append(p);
  }
  function ringContains(ring,lon,lat){
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const [x,y]=ring[i],[px,py]=ring[j];
      if((y>lat)!==(py>lat)&&lon<(px-x)*(lat-y)/(py-y)+x)inside=!inside;
    }
    return inside;
  }
  function catalog(name){
    if(!catalogs.has(name)){
      catalogs.set(name,fetch('/'+name+'.json').then(response=>{
        if(!response.ok)throw Error('Directory unavailable');
        return response.json();
      }).catch(error=>{catalogs.delete(name);throw error}));
    }
    return catalogs.get(name);
  }
  const distance=(a,b)=>km([a.lng,a.lat],[b.lng,b.lat]);
  function scannerPoint(){
    return $('scannerGps').checked&&gpsPosition?L.latLng(gpsPosition[0],gpsPosition[1]):currentView();
  }
  async function scannerArea(where){
    const [states,directories,legacy]=await Promise.allSettled([
      catalog('scanner-states'),catalog('scanner-county-directories'),catalog('scanner-counties')
    ]);
    const {lng,lat}=where;
    const inArea=entry=>entry[2].some(ring=>ringContains(ring,lng,lat));
    const state=states.value?.find(inArea);
    const county=directories.value?.[state?.[1]]?.find(([, ,bounds,polygons])=>{
      const [w,s,e,n]=bounds;
      return lng>=w&&lng<=e&&lat>=s&&lat<=n&&polygons.some(([outer,...holes])=>
        ringContains(outer,lng,lat)&&!holes.some(ring=>ringContains(ring,lng,lat)));
    });
    if(county)return {name:county[0],url:scannerBase+'ctid/'+county[1],county:true};
    if(state?.[1]===6||!state){
      const fallback=legacy.value?.find(inArea);
      if(fallback)return {name:fallback[0]+' County',url:scannerBase+'ctid/'+fallback[1],county:true};
    }
    if(state)return {name:state[0],url:scannerBase+'stid/'+state[1]+'/publicsafety'};
    return {name:'United States',url:scannerBase+'coid/1'};
  }
  function scannerDirectoryPoint(where,radius,feeds){
    const center=map.latLngToContainerPoint(where);
    const radiusPixels=map.project(where).distanceTo(map.project([where.lat+radius*mile/111.195,where.lng]));
    const stations=(radiusPixels>=60?feeds:[]).map(([, ,lat,lng])=>map.latLngToContainerPoint([lat,lng]));
    const gps=gpsPosition?map.latLngToContainerPoint(gpsPosition):null;
    if(gps)stations.push(gps);
    if($('crimeEnabled').checked)stations.push(center);
    if(!stations.some(point=>point.distanceTo(center)<70))return where;
    const step=Math.max(48,Math.min(radiusPixels*.72,100));
    const candidates=[[0,-step],[step,0],[0,step],[-step,0]].map(offset=>center.add(offset));
    const spacing=point=>Math.min(...stations.map(station=>station.distanceTo(point)));
    const size=map.getSize();
    const available=candidates.filter(({x,y})=>x>=48&&x<=size.x-48&&y>=52&&y<=size.y-24);
    return available.length?map.containerPointToLatLng(available.sort((a,b)=>spacing(b)-spacing(a))[0]):where;
  }
  async function showScanners(){
    const where=scannerPoint(),radius=Number($('scannerRadius').value);
    const list=$('scannerLinks');
    const enabled=$('scannerEnabled').checked;
    const view=[enabled,$('crimeEnabled').checked,radius,map.getZoom(),where.lat.toFixed(4),where.lng.toFixed(4),
      gpsPosition?.map(value=>value.toFixed(4)).join(',')].join('|');
    if(view===scannerView)return;
    scannerView=view;
    const revision=++scannerRefresh;
    scannerLayer.clearLayers();
    list.replaceChildren();
    if(!enabled)closeLayerDetail(scannerLayer);
    if(!enabled&&!$('scannerDialog').open){scannerView=null;return}
    const inside=directScanners.filter(([, ,lat,lng])=>distance(where,{lat,lng})<=radius*mile)
      .sort((a,b)=>distance(where,{lat:a[2],lng:a[3]})-distance(where,{lat:b[2],lng:b[3]}));
    if(enabled){
      L.circle(where,{radius:radius*mile*1000,color:'#6dd6ff',fillOpacity:.06,weight:2,interactive:false}).addTo(scannerLayer);
      const diameter=map.project(where).distanceTo(map.project([where.lat+radius*mile/111.195,where.lng]))*2;
      for(const [name,id,lat,lng] of diameter>=120?inside:[]){
        const point=L.latLng(lat,lng);
        const marker=groupButton(point,scannerLayer,'Radio',()=>detail(point,name,body=>{
          paragraph(body,'Public scanner feed · approximate service area');
          body.append(sourceLink('Listen on Broadcastify',scannerBase+'feed/'+id));
        },scannerLayer));
        marker.getElement()?.setAttribute('aria-label',name);
      }
    }
    const area=await scannerArea(where);
    if(revision!==scannerRefresh)return;
    const note=inside.length?inside.length+' linked public '+(inside.length===1?'feed':'feeds')+' within '+radius+' mi.':
      (area.county?'No direct feed inside this circle. Open the county feed list.':
        'No linked county feed page here. Open the broader feed directory.');
    const directoryLabel='Open '+area.name+' feeds';
    $('scannerStatus').textContent=note;
    for(const [feed,id] of inside)list.append(sourceLink(feed,scannerBase+'feed/'+id));
    list.append(sourceLink(directoryLabel,area.url));
    if(enabled){
      const anchor=scannerDirectoryPoint(where,radius,inside);
      const marker=groupButton(anchor,scannerLayer,'Scanners',()=>detail(anchor,'Nearby scanners',body=>{
        paragraph(body,note);
        for(const [feed,id] of inside)body.append(sourceLink(feed,scannerBase+'feed/'+id));
        body.append(sourceLink(directoryLabel,area.url));
      },scannerLayer));
      marker.getElement()?.setAttribute('aria-label','Nearby scanner directory and feed links');
    }
  }
  $('scannerSettings').onclick=()=>{openSurface('scannerDialog');showScanners()};
  $('scannerGps').onchange=showScanners;
  $('scannerRadius').onchange=showScanners;
  bindLayerToggle('openScanners','scannerEnabled',showScanners);

  function crimeStatus(summary,short=summary){
    $('crimeStatus').textContent=summary;
    crimeMapStatus.textContent=short;
    crimeMapStatus.hidden=!$('crimeEnabled').checked;
  }
  function setCrimeLinks(where,visibleSources){
    const list=$('crimeLinks');
    list.replaceChildren(sourceLink('Open this area in CityProtect',cityProtect(where)));
    if(distance(where,johnsonCity)<80){
      list.append(sourceLink('Open Johnson City reports in CrimeMetric','https://crimemetric.com/tn/johnson-city'));
    }
    for(const source of visibleSources){
      list.append(sourceLink(source.name+' source',source.url));
      if(source.city==='Dallas')list.append(sourceLink('View Dallas Police active calls','https://www.dallasopendata.com/d/9fxf-t2tr'));
      if(source.note)paragraph(list,source.note);
    }
  }
  function viewSources(bounds){
    return sources.flatMap(source=>{
      if(source.dispatch&&!$('includeDispatch').checked)return [];
      const [w,s,e,n]=source.bounds;
      const box=[Math.max(bounds.getWest(),w),Math.max(bounds.getSouth(),s),Math.min(bounds.getEast(),e),Math.min(bounds.getNorth(),n)];
      return box[0]<=box[2]&&box[1]<=box[3]?[{source,box}]:[];
    });
  }
  function rangeStart(zone,days){
    const dayFormat=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
    const [m,d,y]=dayFormat.format(Date.now()).split('/').map(Number);
    return new Date(Date.UTC(y,m-1,d-days+1)).toISOString().slice(0,10);
  }
  async function readReports({source,box},days,signal){
    const first=rangeStart(source.zone,days);
    const [w,s,e,n]=box;
    let params;
    if(source.fields){
      const [id,date,category,description,lat,lon]=source.fields;
      // Seattle publishes coordinates as text, and its longitudes share a negative prefix.
      const location=source.pointField
        ? ['within_box('+source.pointField+','+[n,w,s,e].join(',')+')']
        : source.textCoordinates
          ? [lat+" between '"+s+"' and '"+n+"'",lon+" between '"+e+"' and '"+w+"'"]
          : [lat+' between '+s+' and '+n,lon+' between '+w+' and '+e];
      const conditions=[date+" >= '"+first+(source.textDate?'':"T00:00:00")+"'",...location];
      if(source.extraFilter)conditions.push(source.extraFilter);
      const columns=new Set([...source.fields,source.pointField,source.uniqueField].filter(Boolean));
      params=new URLSearchParams({$select:[...columns].join(','),$where:conditions.join(' AND '),
        $order:date+' DESC, '+(source.orderField||id)+' DESC',$limit:'2001'});
      const data=await getRecords(source.query,params,signal);
      if(!Array.isArray(data))throw Error('Report data unavailable');
      const seen=new Set();
      const records=[];
      for(const row of data.slice(0,2000)){
        const point=source.pointField&&row[source.pointField];
        const [x,y]=(point?.coordinates||[point?.longitude??row[lon],point?.latitude??row[lat]]).map(Number);
        if(!Number.isFinite(y)||!Number.isFinite(x)||y<s||y>n||x<w||x>e)continue;
        const key=source.uniqueField&&row[source.uniqueField];
        if(key&&seen.has(key))continue;
        if(key)seen.add(key);
        const approximate=source.dispatch||source.pointField;
        records.push({lat:approximate?Math.round(y*1000)/1000:y,lng:approximate?Math.round(x*1000)/1000:x,
          category:row[category],description:row[description],date:row[date]?.replace('T',' ').slice(0,16),source});
      }
      return {limited:data.length>2000,records};
    }
    if(source.carto){
      const q="SELECT dispatch_date_time,text_general_code,ST_X(the_geom) AS longitude,ST_Y(the_geom) AS latitude"+
        " FROM incidents_part1_part2 WHERE dispatch_date_time >= '"+first+"' AND the_geom && ST_MakeEnvelope("+box.join(',')+
        ",4326) ORDER BY dispatch_date_time DESC,cartodb_id DESC LIMIT 2001";
      const data=await getRecords(source.query,new URLSearchParams({q}),signal);
      if(!Array.isArray(data.rows))throw Error('Report data unavailable');
      return {limited:data.rows.length>2000,records:data.rows.slice(0,2000).map(row=>({
        lat:row.latitude,lng:row.longitude,category:row.text_general_code,date:row.dispatch_date_time?.slice(0,10),source
      }))};
    }
    if(source.arcDate){
      const {arcDate,arcCategory,arcId}=source;
      params=new URLSearchParams({f:'json',inSR:'4326',outSR:'4326',geometry:box.join(','),geometryType:'esriGeometryEnvelope',
        spatialRel:'esriSpatialRelIntersects',outFields:arcDate+','+arcCategory,orderByFields:arcDate+' DESC,'+arcId+' DESC',
        returnGeometry:'true',resultRecordCount:'2000',where:arcDate+" >= timestamp '"+first+" 00:00:00'"});
      const data=await getRecords(source.query,params,signal);
      if(!Array.isArray(data.features))throw Error('Report data unavailable');
      const local=new Intl.DateTimeFormat('en-CA',{timeZone:source.zone,dateStyle:'short'});
      return {limited:data.exceededTransferLimit,records:data.features.map(row=>({
        lat:row.geometry?.y,lng:row.geometry?.x,category:row.attributes?.[arcCategory],
        date:Number.isFinite(row.attributes?.[arcDate])?local.format(row.attributes[arcDate]):null,source
      }))};
    }
    if(first>'2026-12-31'||rangeStart(source.zone,1)<'2026-01-01')return {expired:true,records:[]};
    const [year,month,day]=first.split('-');
    const from=year==='2026'?month+'/'+day+'/'+year:'01/01/2026';
    params=new URLSearchParams({f:'json',inSR:'4326',outSR:'4326',geometry:box.join(','),geometryType:'esriGeometryEnvelope',
      spatialRel:'esriSpatialRelIntersects',outFields:'Occurrence_Date_PT,Offense_Category',orderByFields:'Occurrence_Date_PT DESC',
      returnGeometry:'true',resultRecordCount:'2000',where:"Occurrence_Date_PT >= '"+from+"'"});
    const data=await getRecords(source.query,params,signal);
    if(!Array.isArray(data.features))throw Error('Report data unavailable');
    return {limited:data.exceededTransferLimit,records:data.features.map(row=>({
      lat:row.geometry?.y,lng:row.geometry?.x,date:row.attributes?.Occurrence_Date_PT,
      category:row.attributes?.Offense_Category,source
    }))};
  }
  async function getRecords(url,params,signal){
    const response=await fetch(url+'?'+params,{signal});
    if(!response.ok)throw Error('Report feed unavailable');
    return response.json();
  }
  function countBand(count){
    return countBands[count<5?0:count<10?1:count<25?2:count<50?3:4];
  }
  function renderReports(records,days){
    const zoom=map.getZoom();
    const cells=new Map(),size=56;
    for(const report of records){
      const pixels=map.project([report.lat,report.lng],zoom);
      const key=Math.floor(pixels.x/size)+':'+Math.floor(pixels.y/size);
      if(!cells.has(key))cells.set(key,[]);
      cells.get(key).push(report);
    }
    for(const group of cells.values()){
      const point=L.latLng(group.reduce((sum,r)=>sum+r.lat,0)/group.length,group.reduce((sum,r)=>sum+r.lng,0)/group.length);
      const label=String(group.length);
      const hasCalls=group.some(record=>record.source.dispatch);
      const marker=groupButton(point,incidentLayer,label,()=>detail(point,label+' published '+(label==='1'?'record':'records'),body=>{
        paragraph(body,'Past '+days+' days · approximate area · source dates');
        if(hasCalls)paragraph(body,'Dispatch calls describe a response and may change as details are confirmed.');
        const items=document.createElement('ul');
        items.className='report-details';
        for(const r of group.slice(0,30)){
          const item=document.createElement('li');
          item.textContent=[r.source.dispatch?'Dispatch call':null,r.description||r.category||'Report',r.date].filter(Boolean).join(' · ');
          items.append(item);
        }
        body.append(items);
        if(group.length>30)paragraph(body,'Showing 30 of '+group.length+' loaded records.');
        for(const source of new Set(group.map(r=>r.source)))body.append(sourceLink('Open '+source.name+' source',source.url));
      },incidentLayer));
      const icon=marker.getElement();
      icon?.style.setProperty('--badge',countBand(group.length));
      icon?.style.setProperty('--badge-text',group.length>=50?'#fff':'#141d22');
      icon?.setAttribute('aria-label',label+' published '+(group.length===1?'record':'records'));
    }
  }
  async function cachedReports(view,days,signal){
    const key=[view.source.query,days,...view.box].join('|');
    const saved=reportCache.get(key);
    if(saved&&Date.now()-saved.at<90000)return saved.data;
    const data=await readReports(view,days,signal);
    if(!signal.aborted){
      if(reportCache.size>=12)reportCache.delete(reportCache.keys().next().value);
      reportCache.set(key,{at:Date.now(),data});
    }
    return data;
  }
  async function refreshCrime(){
    crimeRequest?.abort();
    const enabled=$('crimeEnabled').checked;
    const where=currentView(),visible=viewSources(map.getBounds());
    const cities=new Map(visible.map(({source})=>[source.city,source]));
    setCrimeLinks(where,visible.map(value=>value.source));
    if(!enabled){
      incidentLayer.clearLayers();
      closeLayerDetail(incidentLayer);
      crimeMapStatus.hidden=true;
      return;
    }
    if(map.getZoom()<9){
      incidentLayer.clearLayers();
      for(const source of cities.values())groupButton(source.center,incidentLayer,source.city,()=>map.setView(source.center,11));
      crimeStatus('Zoom in to load reports from participating city feeds. City markers show the feeds available in this build.',
        visible.length?'Zoom in for reports':'No connected feed in this view');
      return;
    }
    if(!visible.length){
      incidentLayer.clearLayers();
      crimeStatus('No connected report feed in this view. Open the public map links below to look up this area.','No connected feed here · Sources');
      return;
    }
    const controller=new AbortController();
    crimeRequest=controller;
    const days=Number($('crimeDays').value);
    crimeStatus('Checking '+[...cities.keys()].join(', ')+'…','Loading published reports…');
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(14000)]);
    const results=await Promise.allSettled(visible.map(value=>cachedReports(value,days,signal)));
    if(controller.signal.aborted)return;
    incidentLayer.clearLayers();
    const available=results.flatMap(result=>result.status==='fulfilled'&&!result.value.expired?[result.value]:[]);
    if(!available.length){
      crimeStatus('The report feed returned no usable coverage for this date range. Check the linked source.','Reports unavailable · Sources');
      return;
    }
    const limited=available.some(value=>value.limited);
    const records=available.flatMap(value=>value.records).filter(r=>Number.isFinite(r.lat)&&Number.isFinite(r.lng));
    renderReports(records,days);
    const count=records.length+(limited?'+':'');
    const calls=records.filter(record=>record.source.dispatch).length;
    const summary=records.length?count+' mapped '+(count==='1'?'record':'records')+(calls?' · '+calls+' dispatch':'')+' · '+days+' days':
      'No records returned · '+days+' days';
    const newest=available.map(value=>value.records.find(record=>record.date)).filter(Boolean)
      .map(record=>record.source.name+' '+record.date).join(', ');
    crimeStatus(summary+(newest?' · Latest returned '+newest:' · Agency reporting may lag')+
      (available.length<results.length?' · Some feeds were unavailable.':'')+(limited?' · Feed limit reached. Zoom in to narrow the query.':''),summary);
  }
  const crimeCity=$('crimeCity');
  for(const city of [...new Set(sources.map(source=>source.city))].sort()) {
    crimeCity.add(new Option(city,city));
  }
  crimeCity.onchange=()=>{
    const source=sources.find(entry=>entry.city===crimeCity.value);
    crimeCity.value='';
    if(!source)return;
    $('crimeDialog').close();
    if(source.dispatch)$('includeDispatch').checked=true;
    if(!$('crimeEnabled').checked)$('openCrime').click();
    map.setView(source.center,11);
  };
  $('crimeSettings').onclick=()=>{openSurface('crimeDialog');if(!$('crimeEnabled').checked)refreshCrime()};
  crimeMapStatus.onclick=$('crimeSettings').onclick;
  bindLayerToggle('openCrime','crimeEnabled',()=>{
    refreshCrime();
    if($('scannerEnabled').checked)showScanners();
  });
  $('crimeDays').onchange=refreshCrime;
  $('includeDispatch').onchange=refreshCrime;
  map.on('moveend',()=>{
    clearTimeout(crimeTimer);
    crimeTimer=setTimeout(()=>{
      if($('crimeEnabled').checked)refreshCrime();
      if($('scannerEnabled').checked||$('scannerDialog').open)showScanners();
    },350);
  });
})();
