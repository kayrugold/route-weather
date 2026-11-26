(() => {
  function createGradeTracker(distanceMeters){
    let samples=[];
    function reset(){
      samples=[];
      return null;
    }
    function median(values){
      values.sort((a,b)=>a-b);
      const mid=Math.floor(values.length/2);
      return values.length%2?values[mid]:(values[mid-1]+values[mid])/2;
    }
    function measure(){
      if(samples.length<6)return null;
      const start=samples.slice(0,3),end=samples.slice(-3);
      const distance=median(end.map(p=>p.distance))-median(start.map(p=>p.distance));
      if(distance<120)return null;
      const grade=100*(median(end.map(p=>p.altitude))-median(start.map(p=>p.altitude)))/distance;
      return Math.abs(grade)<=30?grade:null;
    }
    function update(coords,timestamp){
      const {latitude,longitude,altitude,accuracy,altitudeAccuracy,speed}=coords;
      if(![latitude,longitude,altitude,timestamp,accuracy].every(Number.isFinite)||accuracy>25||
        Number.isFinite(altitudeAccuracy)&&altitudeAccuracy>15||Number.isFinite(speed)&&speed<2)return reset();
      const location=[longitude,latitude];
      const previous=samples.at(-1);
      if(previous){
        const seconds=(timestamp-previous.timestamp)/1000;
        if(seconds<=0)return measure();
        if(seconds>40)return restart();
        const moved=distanceMeters(previous.location,location);
        if(moved>60*seconds+25)return restart();
        const spacing=Math.max(12,accuracy,previous.accuracy);
        if(moved<spacing){
          return seconds>10?reset():measure();
        }
        if(!Number.isFinite(speed)&&moved/seconds<2)return restart();
        const distance=previous.distance+moved;
        samples.push({location,altitude,accuracy,timestamp,distance});
        while(samples.length>1&&distance-samples[1].distance>210)samples.shift();
        return measure();
      }
      return restart();

      function restart(){
        samples=[{location,altitude,accuracy,timestamp,distance:0}];
        return null;
      }
    }
    return {update,reset};
  }

  globalThis.routeWeatherLiveGrade={createGradeTracker};
})();
