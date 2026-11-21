const remoteImageTile=L.TileLayer.prototype.createTile;
L.TileLayer.include({
  createTile(coords,done){
    const url=this.getTileUrl(coords);
    if(!url.startsWith('/api/'))return remoteImageTile.call(this,coords,done);
    const tile=document.createElement('img');
    tile.alt='';
    tile.setAttribute('role','presentation');
    fetch(url,{signal:AbortSignal.timeout(22000)}).then(async response=>{
      if(!response.ok||!response.headers.get('content-type')?.startsWith('image/'))throw Error('Weather image unavailable');
      const source=URL.createObjectURL(await response.blob());
      const finish=error=>{URL.revokeObjectURL(source);done(error,tile)};
      tile.onload=()=>finish(null);
      tile.onerror=()=>finish(Error('Weather image could not be drawn'));
      tile.src=source;
    }).catch(error=>done(error,tile));
    return tile;
  }
});
