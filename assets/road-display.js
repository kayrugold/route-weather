(() => {
  // Draw advisory markers first so safety-critical reports stay above them.
  const priority={full:0,collision:1,stopped:2,debris:3,police:4,hold:5,incident:6,chain:7,lane:8,winter:9,work:10,cms:11,cctv:12,rwis:13};
  const drawOrder=Object.keys(priority).reverse();
  const colors={full:'#ff737c',collision:'#ff9287',stopped:'#f4d07e',debris:'#f9bb74',police:'#acd6ff',hold:'#ff9c57',incident:'#ff9871',chain:'#9ddcff',
    lane:'#ffc06d',winter:'#c9e9ff',work:'#ffa254',cms:'#ffd26d',cctv:'#6fcaff',rwis:'#b5eab8'};

  function makeSprite(kind,size,scale){
    const canvas=document.createElement('canvas');
    canvas.width=canvas.height=Math.ceil(size*scale);
    const ctx=canvas.getContext('2d');
    ctx.scale(canvas.width/24,canvas.height/24);
    ctx.lineWidth=2;
    ctx.lineJoin='round';
    ctx.lineCap='round';
    ctx.strokeStyle='#182533';
    ctx.fillStyle=colors[kind];
    const shape=points=>{
      ctx.beginPath();ctx.moveTo(...points[0]);
      for(const point of points.slice(1))ctx.lineTo(...point);
      ctx.closePath();ctx.fill();ctx.stroke();
    };
    const line=points=>{
      ctx.beginPath();ctx.moveTo(...points[0]);
      for(const point of points.slice(1))ctx.lineTo(...point);
      ctx.stroke();
    };
    if(kind==='cctv'){
      shape([[3,7],[15,7],[15,10],[21,7],[21,17],[15,14],[15,17],[3,17]]);
    }else if(kind==='cms'){
      shape([[3,5],[21,5],[21,16],[3,16]]);
      line([[7,16],[7,20]]);line([[17,16],[17,20]]);line([[7,10],[17,10]]);
    }else if(kind==='lane'||kind==='work'){
      shape([[11,3],[13,3],[19,18],[21,18],[21,21],[3,21],[3,18],[5,18]]);
      line([[8,13],[16,13]]);
    }else if(kind==='full'){
      shape([[8,2],[16,2],[22,8],[22,16],[16,22],[8,22],[2,16],[2,8]]);
      line([[8,8],[16,16]]);line([[16,8],[8,16]]);
    }else if(kind==='police'||kind==='stopped'){
      shape([[3,12],[6,11],[8,7],[16,7],[18,11],[21,12],[21,18],[3,18]]);
      line([[6,18],[6,20]]);line([[18,18],[18,20]]);line([[8,12],[16,12]]);
      if(kind==='police'){
        ctx.strokeStyle='#f7717b';line([[9,4],[12,4]]);
        ctx.strokeStyle='#61a9ff';line([[12,4],[15,4]]);
      }
    }else if(kind==='collision'){
      shape([[12,2],[14,8],[20,5],[18,11],[23,14],[17,15],[18,22],[12,18],[6,22],[7,15],[1,14],[6,11],[4,5],[10,8]]);
    }else if(kind==='debris'){
      shape([[2,19],[4,14],[8,15],[10,19]]);
      shape([[8,17],[13,7],[18,9],[21,17]]);
    }else if(kind==='incident'||kind==='hold'){
      shape([[12,2],[22,20],[2,20]]);
      line([[12,8],[12,13]]);line([[12,16],[12,16.2]]);
    }else{
      shape([[4,4],[20,4],[20,20],[4,20]]);
      if(kind==='rwis'){
        line([[7,9],[17,9]]);line([[7,12],[17,12]]);line([[7,15],[14,15]]);
      }else{
        line([[6,12],[18,12]]);line([[9,7],[15,17]]);line([[15,7],[9,17]]);
      }
    }
    return canvas;
  }

  function iconSize(kind,zoom){
    const advisory=priority[kind]>=priority.cms;
    return (zoom<8?11:zoom<11?14:zoom<14?17:20)+(advisory?0:3);
  }

  function reportsAtPoint(points,x,y){
    const hits=[];
    for(const point of points){
      const distance=Math.hypot(point.x-x,point.y-y);
      if(distance<=Math.max(12,point.size/2+3))hits.push({...point,distance});
    }
    return hits.sort((a,b)=>priority[a.item.kind]-priority[b.item.kind]||a.distance-b.distance).map(hit=>hit.item);
  }

  function hazardKind(report,fallback='incident'){
    const title=report.title||'';
    if(/^(road blocked|blocked road)$/i.test(title)||/full closure|road closure|all lanes blocked/i.test(title))return 'full';
    if(/debris|object in (?:the )?(?:road|lane)|rockslide/i.test(title))return 'debris';
    if(/stopped vehicle|disabled vehicle|vehicle stopped|stalled vehicle|11[- ]?26/i.test(title))return 'stopped';
    if(/crash|collision|traffic accident|hit and run|^TC[- ]|^11(?:79|80|81|82)[- ]/i.test(title))return 'collision';
    if(report.source==='CHP')return 'police';
    return fallback;
  }

  function createRoadDisplay(L,getReports,openReports){
    return new (L.Layer.extend({
      onAdd(map){
        this.canvas=L.DomUtil.create('canvas','route-road-canvas');
        this.canvas.setAttribute('aria-hidden','true');
        this.canvas.style.cssText='position:absolute;pointer-events:none;z-index:550';
        this.context=this.canvas.getContext('2d');
        this.sprites=new Map();
        this.points=[];
        this.zooming=false;
        map.getPane('mapPane').append(this.canvas);
        this.refresh();
      },
      onRemove(){
        cancelAnimationFrame(this.frame);
        this.frame=0;
        this.points=[];
        this.canvas.remove();
      },
      getEvents(){
        return {moveend:this.refresh,resize:this.refresh,rotate:this.refresh,
          zoomstart:this.startZoom,zoomend:this.endZoom};
      },
      startZoom(){
        this.zooming=true;
        this.canvas.style.visibility='hidden';
      },
      endZoom(){
        this.zooming=false;
        this.refresh();
      },
      refresh(){
        if(this.frame||this.zooming)return;
        this.frame=requestAnimationFrame(()=>{
          this.frame=0;
          if(this._map&&this.context&&!this.zooming)this.draw();
        });
      },
      draw(){
        const map=this._map;
        const size=map.getSize(), pad=72, scale=Math.min(devicePixelRatio||1,2);
        const width=size.x+2*pad,height=size.y+2*pad;
        const pane=L.DomUtil.getPosition(map.getPane('mapPane'));
        this.origin=L.point(-pane.x-pad,-pane.y-pad);
        L.DomUtil.setPosition(this.canvas,this.origin);
        if(this.canvas.width!==Math.ceil(width*scale)||this.canvas.height!==Math.ceil(height*scale)){
          this.canvas.width=Math.ceil(width*scale);
          this.canvas.height=Math.ceil(height*scale);
          this.canvas.style.width=width+'px';
          this.canvas.style.height=height+'px';
        }
        const ctx=this.context;
        ctx.setTransform(scale,0,0,scale,0,0);
        ctx.clearRect(0,0,width,height);
        const zoom=map.getZoom(), buckets=Object.fromEntries(drawOrder.map(kind=>[kind,[]]));
        const bounds=L.latLngBounds([[-pad,-pad],[size.x+pad,-pad],[size.x+pad,size.y+pad],[-pad,size.y+pad]]
          .map(point=>map.containerPointToLatLng(point)));
        for(const item of getReports(bounds)){
          const point=map.latLngToContainerPoint([item.lat,item.lon]);
          const x=point.x+pad,y=point.y+pad;
          if(x<0||y<0||x>width||y>height)continue;
          buckets[item.kind].push({item,x,y,size:iconSize(item.kind,zoom)});
        }
        this.points=[];
        for(const kind of drawOrder){
          if(!buckets[kind].length)continue;
          const edge=buckets[kind][0].size;
          const key=kind+':'+edge+':'+scale;
          if(!this.sprites.has(key))this.sprites.set(key,makeSprite(kind,edge,scale));
          const sprite=this.sprites.get(key);
          for(const point of buckets[kind]){
            ctx.drawImage(sprite,point.x-edge/2,point.y-edge/2,edge,edge);
            this.points.push(point);
          }
        }
        this.canvas.style.visibility='';
      },
      handleClick(point){
        if(!this._map||!this.origin||this.zooming)return false;
        const pane=L.DomUtil.getPosition(this._map.getPane('mapPane'));
        const hits=reportsAtPoint(this.points,point.x-pane.x-this.origin.x,point.y-pane.y-this.origin.y);
        if(!hits.length)return false;
        openReports(hits[0],hits);
        return true;
      }
    }))();
  }

  globalThis.routeWeatherRoadDisplay={createRoadDisplay,hazardKind,iconSize,priority,reportsAtPoint};
})();
