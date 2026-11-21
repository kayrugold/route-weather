const androidLocation = (() => {
  if (!window.isRouteWeatherAndroid) {
    return navigator.geolocation ?? {
      getCurrentPosition(_success, failure) {
        queueMicrotask(() => failure({code: 2, message: 'Location is unavailable in this browser.'}));
      },
      watchPosition(success, failure) { this.getCurrentPosition(success, failure); return null; },
      clearWatch() {},
    };
  }
  let nextId = 0;
  const requests = new Map();

  window.routeWeatherLocation = (id, position, error) => {
    const request = requests.get(id);
    if (!request) return;
    if (error || !request.watch) requests.delete(id);
    if (error) request.failure(error);
    else request.success(position);
  };

  function start(watch, success, failure, options = {}) {
    const id = ++nextId;
    requests.set(id, {watch, success, failure});
    try {
      AndroidRoute.locationStart(id, watch, options.timeout ?? 20000, options.maximumAge ?? 0);
    } catch {
      queueMicrotask(() => window.routeWeatherLocation(id, null, {
        code: 2, message: 'Route Weather could not start Android location. Close and reopen the app, then try again.'
      }));
    }
    return id;
  }

  return {
    getCurrentPosition(success, failure, options) { start(false, success, failure, options); },
    watchPosition(success, failure, options) { return start(true, success, failure, options); },
    clearWatch(id) {
      requests.delete(id);
      AndroidRoute.locationStop(id);
    }
  };
})();
