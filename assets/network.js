(() => {
  const browserFetch=window.fetch.bind(window);
  const bridge=window.AndroidRoute;
  window.isRouteWeatherAndroid=Boolean(bridge);
  if(!bridge){
    window.routeProviderFetch=browserFetch;
    window.AndroidRoute={wifi:()=>false,hasCompass:()=>false,
      driving(){},compassPosition(){},openLocationSettings(){}};
    return;
  }
  const serviceOrigin=bridge.serviceOrigin?.()||'';
  const sharedEndpoint=/^\/api\/(search|route|nearest-road|provider-status|traffic\/.*)$/;
  const pending=new Map();
  let nextRequest=0;
  window.routeWeatherReply=(id,status,type,chunk,last)=>{
    const request=pending.get(id);
    if(!request)return false;
    request.chunks.push(chunk);
    if(last){
      const bytes=Uint8Array.from(atob(request.chunks.join('')),c=>c.charCodeAt(0));
      request.finish(new Response(bytes,{status,headers:{'content-type':type}}));
    }
    return true;
  };
  window.routeProviderFetch=(url,options={})=>new Promise((resolve,reject)=>{
    const id=++nextRequest,signal=options.signal;
    if(signal?.aborted){reject(signal.reason);return}
    const abort=()=>{pending.delete(id);reject(signal.reason)};
    signal?.addEventListener('abort',abort,{once:true});
    pending.set(id,{chunks:[],finish(response){
      signal?.removeEventListener('abort',abort);
      pending.delete(id);
      resolve(response);
    }});
    const accept=new Headers(options.headers).get('Accept')||'*/*';
    try{AndroidRoute.fetch(id,String(url),accept,Boolean(options.wifiOnly))}
    catch(error){pending.delete(id);signal?.removeEventListener('abort',abort);reject(error)}
  });
  window.fetch=(input,options)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);
    if(url.origin===location.origin&&url.pathname.startsWith('/api/')){
      if(url.pathname==='/api/road-reports'){
        if(!serviceOrigin)return Promise.resolve(Response.json({error:'Shared reports are unavailable.'},{status:503}));
        return browserFetch(serviceOrigin+'/app-api/road-reports'+url.search,options);
      }
      if(sharedEndpoint.test(url.pathname)){
        const offline=window.routeWeatherOffline;
        if(url.pathname==='/api/search'&&offline?.shouldUseOffline('search')){
          return Promise.resolve(offline.search(url.searchParams));
        }
        if(url.pathname==='/api/route'&&offline?.shouldUseOffline('route')){
          return Promise.resolve(offline.route(url.searchParams));
        }
        if(url.pathname==='/api/provider-status'&&offline?.shouldUseOffline('search')){
          return Promise.resolve(Response.json({studioTraffic:false,placesSearch:true,offlineReady:true}));
        }
        if(!serviceOrigin){
          if(url.pathname==='/api/search'&&offline?.getStatus().hasSearch)return Promise.resolve(offline.search(url.searchParams));
          if(url.pathname==='/api/route'&&offline?.getStatus().hasRouting)return Promise.resolve(offline.route(url.searchParams));
          return Promise.resolve(Response.json(
            {error:'This build needs the Route Weather service URL.'},{status:503}));
        }
        return window.routeProviderFetch(serviceOrigin+'/app-api'+url.pathname.slice(4)+url.search,options)
          .then(response=>{
            if(!response.ok&&response.status>=500&&offline&&offline.getMode()!=='online'){
              if(url.pathname==='/api/search'&&offline.getStatus().hasSearch)return offline.search(url.searchParams);
              if(url.pathname==='/api/route'&&offline.getStatus().hasRouting)return offline.route(url.searchParams);
              if(url.pathname==='/api/provider-status'&&offline.getStatus().hasSearch){
                return Response.json({studioTraffic:false,placesSearch:true,offlineReady:true});
              }
            }
            return response;
          })
          .catch(error=>{
            if(offline&&offline.getMode()!=='online'){
              if(url.pathname==='/api/search'&&offline.getStatus().hasSearch)return offline.search(url.searchParams);
              if(url.pathname==='/api/route'&&offline.getStatus().hasRouting)return offline.route(url.searchParams);
            }
            throw error;
          });
      }
      return window.routeWeatherWorker.fetch(new Request(url,options));
    }
    if(url.origin==='https://tiles.openfreemap.org')return window.routeProviderFetch(url,options);
    return browserFetch(input,options);
  };
})();
