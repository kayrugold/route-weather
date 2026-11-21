// NCEP GRIB2 templates 5.0, 5.2 and 5.3; the GFS PRATE surface field is a regular global grid.
const signedMagnitude=(number,bits)=>number>=2**(bits-1)?2**(bits-1)-number:number;
export function readPrecipitationRate(buffer){
  const data=new DataView(buffer);
  if(data.byteLength<20||data.getUint32(0)!==0x47524942||data.getUint8(7)!==2||
    data.getUint32(8)!==0||data.getUint32(12)!==data.byteLength)throw Error('Invalid GFS GRIB2 message');
  const sections=[];
  for(let start=16;start<data.byteLength-4;){
    const size=data.getUint32(start);
    if(size<5||start+size>data.byteLength-4)throw Error('Truncated GFS field');
    sections[data.getUint8(start+4)]=new DataView(buffer,start,size);
    start+=size;
  }
  const [grid,product,format,bitmap,packed]=sections.slice(3,8);
  if(!grid||!product||!format||!bitmap||!packed||
    grid.getUint16(12)!==0||grid.getUint8(71)!==0||bitmap.getUint8(5)!==255||
    product.getUint16(7)!==0||product.getUint8(9)!==1||product.getUint8(10)!==7)
    throw Error('Unsupported GFS grid');
  const width=grid.getUint32(30),height=grid.getUint32(34);
  if(width!==1440||height!==721||format.getUint32(5)!==width*height||
    grid.getUint32(50)!==0||grid.getUint32(63)!==250000||grid.getUint32(67)!==250000)
    throw Error('Unexpected GFS grid dimensions');
  const kind=format.getUint16(9),bits=format.getUint8(19);
  const reference=format.getFloat32(11),binary=2**signedMagnitude(format.getUint16(15),16);
  const decimal=10**(-signedMagnitude(format.getUint16(17),16))*3600;
  let cursor=40;
  function read(n){
    if(n>32||cursor+n>packed.byteLength*8)throw Error('Invalid GFS packing');
    let value=0;
    for(let left=n;left;){
      const position=cursor%8,used=Math.min(left,8-position);
      value=value*2**used+((packed.getUint8(cursor>>3)>>(8-position-used))&(2**used-1));
      cursor+=used;
      left-=used;
    }
    return value;
  }
  const align=()=>{cursor=Math.ceil(cursor/8)*8};
  const rates=new Float32Array(width*height);
  const put=(i,value)=>{rates[i]=Math.max(0,(reference+value*binary)*decimal)};
  if(kind===0){
    for(let i=0;i<rates.length;i++)put(i,read(bits));
    return {width,height,rates};
  }
  if(![2,3].includes(kind)||format.getUint8(21)!==1||format.getUint8(22)!==0)
    throw Error('Unsupported GFS data packing');
  const order=kind===3?format.getUint8(47):0;
  const descriptor=kind===3?8*format.getUint8(48):0;
  if(order>2||kind===3&&(!order||!descriptor||descriptor>32))throw Error('Invalid GFS spatial differencing');
  const first=Array.from({length:order},()=>read(descriptor));
  const minimum=order?signedMagnitude(read(descriptor),descriptor):0;
  const count=format.getUint32(31);
  if(count>rates.length)throw Error('Invalid GFS group count');
  const refs=Array.from({length:count},()=>read(bits));
  align();
  const widths=Array.from({length:count},()=>format.getUint8(35)+read(format.getUint8(36)));
  align();
  const lengths=Array.from({length:count},()=>format.getUint32(37)+format.getUint8(41)*read(format.getUint8(46)));
  align();
  if(count)lengths[count-1]=format.getUint32(42);
  let i=0,previous=0,beforePrevious=0;
  for(let group=0;group<count;group++){
    const end=i+lengths[group];
    if(end>rates.length)throw Error('Invalid GFS group lengths');
    for(;i<end;i++){
      const encoded=refs[group]+read(widths[group]);
      let value=encoded;
      if(i<order)value=first[i];
      else if(order===1)value=encoded+minimum+previous;
      else if(order===2)value=encoded+minimum+2*previous-beforePrevious;
      put(i,value);
      beforePrevious=previous;
      previous=value;
    }
  }
  if(!count)for(;i<rates.length;i++)put(i,0);
  if(i!==rates.length)throw Error('Incomplete GFS field');
  return {width,height,rates};
}

const hour=3600000;
const bucket='https://noaa-gfs-bdp-pds.s3.amazonaws.com';
const frameCache=new Map();
export function gfsHour(timestamp){return Math.round(timestamp/hour)*hour}
export function gfsRange(index,lead){
  const entries=index.trim().split(/\r?\n/).map(line=>line.split(':'));
  const i=entries.findIndex(parts=>parts[3]==='PRATE'&&parts[4]==='surface'&&
    (parts[5]===lead+' hour fcst'||lead===0&&parts[5]==='anl'));
  const start=Number(entries[i]?.[1]),end=Number(entries[i+1]?.[1])-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end-start>12_000_000)
    throw Error('GFS precipitation field is unavailable');
  return [start,end];
}
async function fetchGfsFrame(timestamp){
  const firstCycle=Math.min(Math.floor((Date.now()-3*hour)/(6*hour)),Math.floor(timestamp/(6*hour)))*6*hour;
  for(let attempt=0;attempt<3;attempt++){
    const run=firstCycle-attempt*6*hour;
    const lead=(timestamp-run)/hour;
    if(lead<0||lead>120)continue;
    const iso=new Date(run).toISOString();
    const day=iso.slice(0,10).replaceAll('-',''),cycle=iso.slice(11,13);
    const url=bucket+'/gfs.'+day+'/'+cycle+'/atmos/gfs.t'+cycle+'z.pgrb2.0p25.f'+String(lead).padStart(3,'0');
    try{
      const index=await fetch(url+'.idx',{signal:AbortSignal.timeout(8000)});
      if(!index.ok)continue;
      const [start,end]=gfsRange(await index.text(),lead);
      const response=await fetch(url,{headers:{Range:'bytes='+start+'-'+end},signal:AbortSignal.timeout(12000)});
      if(response.status!==206||Number(response.headers.get('content-length'))!==end-start+1)continue;
      const bytes=await response.arrayBuffer();
      if(bytes.byteLength!==end-start+1)continue;
      return readPrecipitationRate(bytes);
    }catch{ /* Move to the previous run when this field cannot be read. */ }
  }
  throw Error('GFS precipitation is unavailable');
}
export function gfsFrame(timestamp){
  const valid=gfsHour(timestamp);
  if(!frameCache.has(valid)){
    const frame=fetchGfsFrame(valid).catch(error=>{
      if(frameCache.get(valid)===frame)frameCache.delete(valid);
      throw error;
    });
    frameCache.set(valid,frame);
    if(frameCache.size>5)frameCache.delete(frameCache.keys().next().value);
  }
  return frameCache.get(valid);
}

const rateColors=[
  [.1,88,180,232,135],[.5,48,162,221,175],[1,20,136,199,195],
  [2.5,28,104,187,210],[5,93,81,179,220],[10,158,66,166,230],
  [20,235,106,125,235]
];
export const mercatorLimit=Math.atan(Math.sinh(Math.PI))*180/Math.PI;
export function gfsImage({width,height,rates},region){
  const south=region?.getSouth(),north=region?.getNorth(),west=region?.getWest(),east=region?.getEast();
  const canvas=document.createElement('canvas');
  canvas.width=width;
  canvas.height=width;
  const context=canvas.getContext('2d');
  const image=context.createImageData(width,width);
  for(let y=0;y<width;y++){
    const lat=Math.atan(Math.sinh(Math.PI*(1-2*(y+.5)/width)))*180/Math.PI;
    const gridRow=Math.min(height-1,Math.round((90-lat)*4))*width;
    for(let x=0;x<width;x++){
      const lon=(x+.5)*360/width-180;
      if(region&&lat>=south&&lat<=north&&lon>=west&&lon<=east)continue;
      const rate=rates[gridRow+(x+width/2)%width];
      if(rate<rateColors[0][0]||!Number.isFinite(rate))continue;
      let color=rateColors[0];
      for(let i=1;i<rateColors.length&&rate>=rateColors[i][0];i++)color=rateColors[i];
      const offset=(y*width+x)*4;
      image.data[offset]=color[1];
      image.data[offset+1]=color[2];
      image.data[offset+2]=color[3];
      image.data[offset+3]=color[4];
    }
  }
  context.putImageData(image,0,0);
  return canvas.toDataURL('image/png');
}
