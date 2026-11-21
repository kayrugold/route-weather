(() => {
  const drivingZoom = 12;
  const drivingMaxAge = 10 * 60 * 1000;
  const browsingMaxAge = 15 * 60 * 1000;
  const tileKey = (x, y) => x + ':' + y;

  function projectTile([lon, lat], zoom) {
    const n = 2 ** zoom;
    const radians = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
    return [(lon + 180) * n / 360, (1 - Math.asinh(Math.tan(radians)) / Math.PI) * n / 2];
  }

  function routeTiles(coordinates, zoom) {
    const tiles = new Set();
    const world = 2 ** zoom;
    function add(x, y) {
      if (y >= 0 && y < world) tiles.add(tileKey((x + world) % world, y));
    }
    let previous = null;
    for (const coordinate of coordinates) {
      const [x, y] = projectTile(coordinate, zoom);
      if (previous) {
        const [ax, ay] = previous;
        // Sample at intervals no longer than a quarter tile. The thin buffer also
        // includes neighboring roads close to a tile boundary.
        const dx = ((x - ax + world * 1.5) % world) - world / 2;
        const steps = Math.max(1, Math.ceil(4 * Math.max(Math.abs(dx), Math.abs(y - ay))));
        for (let i = 0; i <= steps; i++) {
          const sx = ax + dx * i / steps, sy = ay + (y - ay) * i / steps;
          for (const ix of [Math.floor(sx - .18), Math.floor(sx + .18)]) {
            for (const iy of [Math.floor(sy - .18), Math.floor(sy + .18)]) add(ix, iy);
          }
        }
      } else add(Math.floor(x), Math.floor(y));
      previous = [x, y];
    }
    return tiles;
  }

  globalThis.routeTrafficPlan = {drivingZoom, drivingMaxAge, browsingMaxAge, projectTile, routeTiles, tileKey};
})();
