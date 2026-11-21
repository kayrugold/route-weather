(() => {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function routeSteps(route, project) {
    const coordinates = route.geometry.coordinates;
    const ordered = [];
    for (const step of route.legs.flatMap(leg => leg.steps ?? [])) {
      const text = step.instruction?.trim();
      const type = String(step.maneuver?.type ?? '').toUpperCase();
      if (!text || type === 'DEPART') continue;
      const point = step.maneuver?.location;
      let offset = step.offset;
      if (!Number.isFinite(offset) && point?.length === 2) {
        const match = project(coordinates, point);
        if (match.total) offset = match.along / match.total * route.distance;
      }
      if (!Number.isFinite(offset) || offset < 0 || offset > route.distance + 20) continue;
      ordered.push({offset, text, endpoint: /^(ARRIVE|WAYPOINT)/.test(type)});
    }
    return ordered.sort((a, b) => a.offset - b.offset);
  }

  function approach(distance) {
    if (distance > 320) {
      const miles = (Math.round(distance / 160.9344) / 10).toFixed(1).replace(/\.0$/, '');
      return 'In ' + miles + (miles === '1' ? ' mile, ' : ' miles, ');
    }
    return 'In about ' + Math.max(50, Math.round(distance / 15.24) * 50) + ' feet, ';
  }

  function createTracker(steps) {
    let index = 0, advance = false, last = null, paused = false;
    return {
      update({distance, offRouteMeters, accuracy, speed, time}) {
        if (!Number.isFinite(distance) || !Number.isFinite(offRouteMeters) ||
          !Number.isFinite(accuracy) || accuracy > 80) {
          if (paused) return {};
          paused = true;
          return {stop: true, reason: 'Voice directions paused. Waiting for a better GPS fix.'};
        }
        const seconds = last ? Math.max(0, (time - last.time) / 1000) : 0;
        const jumped = last && (distance < last.distance - 85 || distance > last.distance + Math.max(135, seconds * 65));
        if (offRouteMeters > clamp(accuracy * 2, 45, 80) || jumped) {
          if (paused) return {};
          paused = true;
          return {stop: true, reason: 'Voice directions paused. Return to the planned route or replan.'};
        }
        const resumed = paused;
        paused = false;
        const progress = Math.max(distance, last?.distance ?? distance);
        last = {distance: progress, time};
        while (steps[index] && steps[index].offset < progress - 25) {
          index++;
          advance = false;
        }
        const step = steps[index];
        if (!step) return {resumed};
        const remaining = step.offset - progress;
        const metersPerSecond = Number.isFinite(speed) && speed >= 0 ? speed : 12;
        const near = step.endpoint ? 25 : clamp(metersPerSecond * 5, 35, 150);
        if (remaining <= near && (!step.endpoint || offRouteMeters <= 25)) {
          index++;
          advance = false;
          return {resumed, text: step.endpoint || remaining <= 25 ? step.text : approach(remaining) + step.text};
        }
        if (!step.endpoint && !advance && remaining <= clamp(metersPerSecond * 22, 150, 750)) {
          advance = true;
          return {resumed, text: approach(remaining) + step.text};
        }
        return {resumed};
      },
    };
  }

  globalThis.routeVoice = {routeSteps, createTracker};
})();
