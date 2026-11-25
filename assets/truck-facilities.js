(() => {
  const brands = {
    pilot: {label:'Pilot / Flying J', text:'PILOT', fill:'#c7272e', ink:'#fff'},
    loves: {label:"Love’s", text:'♥', fill:'#ffdc39', ink:'#cb2027'},
    petro: {label:'Petro', text:'PETRO', fill:'#087542', ink:'#fff'},
    ta: {label:'TA', text:'TA', fill:'#174f97', ink:'#fff'},
    fleet: {label:'Fleet truck stop', text:'FLEET', fill:'#7745a6', ink:'#fff'},
    independent: {label:'Independent / other truck stop', text:'TRUCK', fill:'#435260', ink:'#fff'},
    scale: {label:'Weigh station', text:'⚖', fill:'#80deec', ink:'#102938'},
  };
  function truckBrand(item) {
    const text = [item.brand, item.name].filter(Boolean).join(' ');
    if (/\blove[’']?s\b/i.test(text)) return 'loves';
    if (/\bpetro\b/i.test(text)) return 'petro';
    if (/\b(?:TA|travel\s*centers?\s+of\s+america)\b/i.test(text)) return 'ta';
    if (/\b(?:pilot|flying\s*j)\b/i.test(text)) return 'pilot';
    if (/\bfleet\b/i.test(text)) return 'fleet';
    return 'independent';
  }
  function viewportBoxes(west, south, east, north) {
    const width = Math.min(360, east - west);
    south = Math.max(-85, south); north = Math.min(85, north);
    if (width <= 0 || south >= north) return [];
    if (width >= 360) return [[-180, south, 180, north]];
    west = ((west + 180) % 360 + 360) % 360 - 180;
    east = west + width;
    return east <= 180 ? [[west,south,east,north]] : [[west,south,180,north],[-180,south,east-360,north]];
  }
  globalThis.routeWeatherFacilities = {truckBrand, viewportBoxes, brands};
  if (typeof map === 'undefined' || !map) return;

  const kinds = {
    'weigh-stations': {button:'showScales', label:'Weigh stations'},
    'truck-stops': {button:'findTruckStops', label:'Truck stops'},
  };
  const icons = new Map(), cache = new Map();
  let timer;
  const note = $('facilityStatus');
  for (const [kind, state] of Object.entries(kinds)) {
    state.layer = L.layerGroup(); state.items = []; state.message = ''; state.enabled = false;
    try { state.enabled = localStorage.getItem('route-weather-layer-'+kind) === 'true'; } catch {}
    $(state.button).setAttribute('aria-pressed', String(state.enabled));
    if (state.enabled) state.layer.addTo(map);
    $(state.button).onclick = () => {
      state.enabled = !state.enabled;
      $(state.button).setAttribute('aria-pressed', String(state.enabled));
      try { localStorage.setItem('route-weather-layer-'+kind, String(state.enabled)); } catch {}
      state.request?.abort(); state.request = null;
      if (state.enabled) {state.layer.addTo(map); queue();}
      else {state.layer.remove(); state.message = ''; updateStatus();}
    };
  }
  function updateStatus() {
    note.hidden = !Object.values(kinds).some(state => state.enabled);
    note.textContent = Object.values(kinds).filter(state => state.enabled).map(state => state.message || state.label+': loading…').join(' · ');
  }
  function icon(brand) {
    if (!icons.has(brand)) {
      const style = brands[brand];
      const font = style.text.length > 3 ? 8 : 17;
      const graphic = brand === 'independent'
        ? '<path d="M7 10h13v11H7zm13 5h6l3 5v1h-9" fill="none" stroke="white" stroke-width="2"/><circle cx="12" cy="24" r="2.5" fill="white"/><circle cx="25" cy="24" r="2.5" fill="white"/>'
        : '<text x="18" y="22" text-anchor="middle" font-family="Arial,sans-serif" font-size="'+font+'" font-weight="bold" fill="'+style.ink+'">'+style.text+'</text>';
      icons.set(brand, L.divIcon({className:'facility-pin', iconSize:[36,40], iconAnchor:[18,39], popupAnchor:[0,-34],
        html:'<svg width="36" height="40" viewBox="0 0 36 40" aria-hidden="true"><path d="M5 1h26q4 0 4 4v25q0 4-4 4h-8l-5 5-5-5H5q-4 0-4-4V5q0-4 4-4Z" fill="'+style.fill+'" stroke="white" stroke-width="2"/>'+graphic+'</svg>'}));
    }
    return icons.get(brand);
  }
  function render(state, kind) {
    state.layer.clearLayers();
    const bounds = map.getBounds(), center = map.getCenter().lng;
    let count = 0;
    for (const item of state.items) {
      const lon = item.lon + 360 * Math.round((center-item.lon)/360);
      if (!bounds.contains([item.lat,lon])) continue;
      const brand = kind === 'weigh-stations' ? 'scale' : truckBrand(item);
      const content = document.createElement('section');
      const heading = document.createElement('strong'); heading.textContent = item.name;
      const address = document.createElement('p'); address.textContent = item.address;
      const source = document.createElement('p'); source.textContent = brands[brand].label + (String(item.id || '').startsWith('offline-') ? ' · Offline map data (OSM).' : ' · TomTom location data. Live status unavailable.');
      const plan = document.createElement('button'); plan.type = 'button'; plan.textContent = 'Route here';
      plan.onclick = () => {
        closeStateRoadPopup(); setMapLayers(false); openPlanner();
        $('end').value = item.name; pins.end = {lat:item.lat,lon:item.lon,label:item.name,text:item.name};
      };
      content.append(heading,address,source,plan);
      L.marker([item.lat,lon], {icon:icon(brand),title:item.name+' · '+brands[brand].label,
        bubblingMouseEvents:false,zIndexOffset:brand==='independent'?100:brand==='fleet'?200:300})
        .on('click', () => openStateRoadPopup([item.lat,lon], content)).addTo(state.layer);
      count++;
    }
    return count;
  }
  async function load(kind, state, boxes) {
    const controller = new AbortController(); state.request = controller;
    const timer = setTimeout(() => controller.abort(), 45000);
    state.message = state.label+': loading…'; updateStatus();
    try {
      const items = new Map(); let limited = false;
      for (const box of boxes) {
        const key = kind+':'+box.join(',');
        let saved = cache.get(key);
        if (!saved || Date.now()-saved.at > 5*60000) {
          const rows = []; let total = Infinity, offset = 0;
          while (offset < total && offset < 1000) {
            const query = new URLSearchParams({mode:'facilities',kind,bbox:box.join(','),offset:String(offset)});
            const response = await fetch('/api/search?'+query, {signal:controller.signal});
            const data = await response.json();
            if (!response.ok) throw Error(data.error || 'Locations unavailable');
            if (!Array.isArray(data.items)) throw Error('The map service needs an update.');
            rows.push(...data.items); total = data.total;
            if (data.items.length < 100) break;
            offset += 100;
          }
          // TomTom can cap totalResults at 100 even when the wider area has more POIs.
          saved = {items:rows, limited:rows.length < total || rows.length >= 100, at:Date.now()};
          if (cache.size >= 16) cache.delete(cache.keys().next().value);
          cache.set(key,saved);
        }
        limited ||= saved.limited;
        for (const item of saved.items) items.set(item.id || item.name+':'+item.lat+':'+item.lon, item);
      }
      if (state.request !== controller || !state.enabled) return;
      state.items = [...items.values()];
      const count = render(state,kind);
      state.message = state.label+': '+count+' in view'+(limited?' (zoom in for more)':'');
    } catch (error) {
      if (state.request !== controller || !state.enabled) return;
      state.message = state.label+': '+(controller.signal.aborted?'request timed out':error.message);
    } finally {
      clearTimeout(timer);
      if (state.request === controller) {state.request=null;updateStatus();}
    }
  }
  function queue() {
    clearTimeout(timer);
    for (const [kind,state] of Object.entries(kinds)) {
      state.request?.abort(); state.request=null;
      if (state.enabled) {render(state,kind); state.message=state.label+': loading…';}
    }
    updateStatus();
    timer = setTimeout(() => {
      const bounds = map.getBounds();
      const boxes = viewportBoxes(bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth())
        .map(box => box.map(value => Number(value.toFixed(5))));
      for (const [kind,state] of Object.entries(kinds)) if (state.enabled) void load(kind,state,boxes);
    }, 650);
  }
  map.on('moveend',queue);
  window.addEventListener('online',queue);
  queue();
})();
