(() => {
  const zoom = 10;
  const tileSize = 256;
  const mapSize = tileSize * 2 ** zoom;
  const feetPerMeter = 3.28084;

  function sampleTerrainRoute(coordinates, distanceKm) {
    const distances = [0];
    for (let i = 1; i < coordinates.length; i++) {
      distances.push(distances[i - 1] + distanceKm(coordinates[i - 1], coordinates[i]) * 1000);
    }
    const total = distances.at(-1);
    if (total < 100) return [];
    const count = Math.min(81, Math.max(2, Math.ceil(total / 1000) + 1));
    let index = 1;
    return Array.from({length: count}, (_, i) => {
      const distance = total * i / (count - 1);
      if (i === 0) return {coordinates: coordinates[0], distance};
      if (i === count - 1) return {coordinates: coordinates.at(-1), distance};
      while (index < distances.length - 1 && distances[index] < distance) index++;
      const ratio = (distance - distances[index - 1]) / (distances[index] - distances[index - 1]);
      const [lon, lat] = coordinates[index - 1];
      const [endLon, endLat] = coordinates[index];
      const delta = ((endLon - lon + 540) % 360) - 180;
      return {
        coordinates: [((lon + delta * ratio + 540) % 360) - 180, lat + (endLat - lat) * ratio],
        distance,
      };
    });
  }

  function terrainPixel([lon, lat]) {
    const latitude = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const north = Math.asinh(Math.tan(latitude * Math.PI / 180));
    const x = Math.min(mapSize - 1, Math.max(0, Math.floor((lon + 180) / 360 * mapSize)));
    const y = Math.min(mapSize - 1, Math.max(0, Math.floor((1 - north / Math.PI) / 2 * mapSize)));
    return {tile: [zoom, Math.floor(x / tileSize), Math.floor(y / tileSize)].join('/'), x: x % tileSize, y: y % tileSize};
  }

  function terrariumHeight(data) {
    return data[3] === 0 ? null : data[0] * 256 + data[1] + data[2] / 256 - 32768;
  }

  function gradeBetween(previous, current) {
    if (!previous || !Number.isFinite(previous.elevation) || !Number.isFinite(current.elevation)) return null;
    const distance = current.distance - previous.distance;
    return distance >= 100 ? 100 * (current.elevation - previous.elevation) / distance : null;
  }

  const terrainTiles=new Map();

  async function readTerrain(points, signal) {
    const groups = new Map();
    for (const point of points) {
      const pixel = terrainPixel(point.coordinates);
      if (!groups.has(pixel.tile)) groups.set(pixel.tile, []);
      groups.get(pixel.tile).push({point, ...pixel});
    }
    const entries = [...groups];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = tileSize;
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) throw Error('Terrain image decoding is unavailable.');
    for (let i = 0; i < entries.length && !signal.aborted; i += 4) {
      await Promise.allSettled(entries.slice(i, i + 4).map(async ([tile, group]) => {
        let pixels=terrainTiles.get(tile);
        if(!pixels){
          const response=await fetch('/api/terrain/'+tile+'.png',{signal});
          if(!response.ok||signal.aborted)return;
          const image=await createImageBitmap(await response.blob());
          try{
            if(image.width!==tileSize||image.height!==tileSize)return;
            context.clearRect(0,0,tileSize,tileSize);
            context.drawImage(image,0,0);
            pixels=context.getImageData(0,0,tileSize,tileSize).data;
          }finally{
            image.close();
          }
          if(terrainTiles.size>=4)terrainTiles.delete(terrainTiles.keys().next().value);
          terrainTiles.set(tile,pixels);
        }
        for(const {point,x,y} of group){
          const index=(y*tileSize+x)*4;
          point.elevation=terrariumHeight(pixels.subarray(index,index+4));
        }
      }));
    }
    return points;
  }

  globalThis.routeWeatherTerrain = {sampleTerrainRoute, terrainPixel, terrariumHeight, gradeBetween, readTerrain, feetPerMeter};
})();
