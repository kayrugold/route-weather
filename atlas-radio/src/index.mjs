import {normalizePublicChannel} from './geo.mjs';
export {RadioRoom} from './radio-room.mjs';
export {GroupDirectory} from './group-directory.mjs';

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: corsHeaders(request)});
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health' || path === '/') {
      return withCors(
        Response.json({ok: true, service: 'atlas-radio', version: '1.0.0'}),
        request
      );
    }

    const dirStub = () => env.GROUP_DIRECTORY.get(env.GROUP_DIRECTORY.idFromName('global'));

    // Private Group REST API
    if (path === '/api/groups/create' && request.method === 'POST') {
      const res = await dirStub().fetch(new Request('https://dir/create', {method: 'POST', body: request.body}));
      return withCors(res, request);
    }
    if (path === '/api/groups/join' && request.method === 'POST') {
      const res = await dirStub().fetch(new Request('https://dir/join', {method: 'POST', body: request.body}));
      return withCors(res, request);
    }
    if (path === '/api/groups/status' && request.method === 'GET') {
      const res = await dirStub().fetch(new Request(`https://dir/status${url.search}`));
      return withCors(res, request);
    }
    if (path === '/api/groups/pending' && request.method === 'GET') {
      const res = await dirStub().fetch(new Request(`https://dir/pending${url.search}`));
      return withCors(res, request);
    }
    if (path === '/api/groups/approve' && request.method === 'POST') {
      const res = await dirStub().fetch(new Request('https://dir/approve', {method: 'POST', body: request.body}));
      return withCors(res, request);
    }
    if (path === '/api/groups/leave' && request.method === 'POST') {
      const res = await dirStub().fetch(new Request('https://dir/leave', {method: 'POST', body: request.body}));
      return withCors(res, request);
    }
    if (path === '/api/groups/update-handle' && request.method === 'POST') {
      const res = await dirStub().fetch(new Request('https://dir/update-handle', {method: 'POST', body: request.body}));
      return withCors(res, request);
    }

    // Public channel WebSocket: /ws/public/:channel
    const pubMatch = path.match(/^\/ws\/public\/([^/]+)$/);
    if (pubMatch) {
      const channelId = normalizePublicChannel(decodeURIComponent(pubMatch[1]));
      if (!channelId) {
        return withCors(Response.json({error: 'Invalid public channel'}, {status: 400}), request);
      }
      const roomStub = env.RADIO_ROOM.get(env.RADIO_ROOM.idFromName('pub:' + channelId));
      const fwdUrl = new URL(request.url);
      fwdUrl.searchParams.set('channelId', channelId);
      fwdUrl.searchParams.set('groupType', 'PUB');
      return roomStub.fetch(new Request(fwdUrl.toString(), request));
    }

    // Private group WebSocket: /ws/private/:groupId?token=...
    const privMatch = path.match(/^\/ws\/private\/([^/]+)$/);
    if (privMatch) {
      const groupId = decodeURIComponent(privMatch[1]);
      const token = url.searchParams.get('token') || '';
      const verifyRes = await dirStub().fetch(
        new Request(`https://dir/verify?groupId=${encodeURIComponent(groupId)}&token=${encodeURIComponent(token)}`)
      );
      if (!verifyRes.ok) {
        return withCors(Response.json({error: 'Unauthorized group member'}, {status: 403}), request);
      }
      const member = await verifyRes.json();
      const roomStub = env.RADIO_ROOM.get(env.RADIO_ROOM.idFromName('priv:' + groupId));
      const fwdUrl = new URL(request.url);
      fwdUrl.searchParams.set('channelId', groupId);
      fwdUrl.searchParams.set('groupType', member.type);
      fwdUrl.searchParams.set('clientId', member.userId);
      if (!fwdUrl.searchParams.get('handle')) {
        fwdUrl.searchParams.set('handle', member.handle);
      }
      return roomStub.fetch(new Request(fwdUrl.toString(), request));
    }

    return withCors(Response.json({error: 'Not found'}, {status: 404}), request);
  },
};
