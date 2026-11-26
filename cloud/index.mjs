import '../assets/provider-worker.js';
import {handleTomTom, isTomTomEndpoint} from './tomtom.mjs';
import {handleRoadReports} from './road-reports.mjs';
import {handleAlabamaRoads} from './alabama-roads.mjs';
export {TripQuota} from './quota.mjs';
export {RoadReports} from './road-reports.mjs';

const framePolicy = "frame-ancestors 'self' https://andysdevstudio.pages.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const app = url.pathname.startsWith('/app-api/');
    if (app || url.pathname.startsWith('/api/')) {
      const endpoint = url.pathname.slice(app ? 8 : 4);
      if(endpoint === '/state-road-overlay' && url.searchParams.get('state') === 'AL') return handleAlabamaRoads(request);
      if (endpoint === '/road-reports') return handleRoadReports(request, env, app);
      if (isTomTomEndpoint(endpoint)) return handleTomTom(request, endpoint, env, app ? 'app' : 'demo');
      if (app || request.method !== 'GET') return new Response(null, {status: 404});
      return globalThis.routeWeatherWorker.fetch(request);
    }
    const asset = await env.ASSETS.fetch(request);
    if (!asset.headers.get('Content-Type')?.includes('text/html')) return asset;
    const response = new Response(asset.body, asset);
    response.headers.set('Content-Security-Policy', framePolicy);
    return response;
  },
};
