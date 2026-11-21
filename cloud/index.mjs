import '../assets/provider-worker.js';
import {handleTomTom, isTomTomEndpoint} from './tomtom.mjs';
export {TripQuota} from './quota.mjs';

const framePolicy = "frame-ancestors 'self' https://andysdevstudio.pages.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const app = url.pathname.startsWith('/app-api/');
    if (app || url.pathname.startsWith('/api/')) {
      const endpoint = url.pathname.slice(app ? 8 : 4);
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
