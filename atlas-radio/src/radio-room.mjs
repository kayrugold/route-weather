import {DurableObject} from 'cloudflare:workers';
import {
  bearingDegrees,
  cardinalDirection,
  haversineMiles,
  isWithinReceptionRange,
  sanitizeHandle,
} from './geo.mjs';

const MAX_TX_DURATION_MS = 32_000;
const DEAD_KEY_TIMEOUT_MS = 4_500;
const PRESENCE_THROTTLE_MS = 2_000;

/**
 * Hibernatable WebSocket Durable Object representing a single Atlas CB Radio channel
 * (public CH17 / CH19 / CH# or private FAM / CMP group).
 */
export class RadioRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.activeTalkers = new Map(); // clientId -> { clientId, slotId, handle, lat, lon, heading, rangeMi, channelId, groupType, targetHandle, startedAt }
    this.nextSlotId = 1;
    this.lastPresenceBroadcast = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      if (url.pathname.endsWith('/stats')) {
        const sockets = this.ctx.getWebSockets();
        this.pruneExpiredTalkers();
        return Response.json({
          connected: sockets.length,
          activeTalkers: [...this.activeTalkers.values()].map(t => ({handle: t.handle, startedAt: t.startedAt})),
        });
      }
      return new Response('Expected WebSocket upgrade', {status: 426});
    }

    const channelId = url.searchParams.get('channelId') || 'CH19';
    const groupType = url.searchParams.get('groupType') || 'PUB'; // 'PUB' | 'FAM' | 'CMP'
    const clientId = (url.searchParams.get('clientId') || crypto.randomUUID()).slice(0, 64);
    const handle = sanitizeHandle(url.searchParams.get('handle'));
    const slotId = this.nextSlotId;
    this.nextSlotId = (this.nextSlotId % 250) + 1;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      clientId,
      slotId,
      handle,
      channelId,
      groupType,
      lat: null,
      lon: null,
      heading: null,
      speedMph: null,
      rangeMi: groupType === 'PUB' ? 30 : 0,
      sharePin: groupType === 'CMP',
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    });

    this.pruneExpiredTalkers();
    this.sendJson(server, {
      type: 'welcome',
      clientId,
      slotId,
      channelId,
      groupType,
      activeCount: this.activeTalkers.size,
    });

    this.broadcastPresence(true);
    return new Response(null, {status: 101, webSocket: client});
  }

  pruneExpiredTalkers() {
    const now = Date.now();
    let changed = false;
    for (const [id, tx] of this.activeTalkers.entries()) {
      const deadKey = now - (tx.lastAudioAt || tx.startedAt) > DEAD_KEY_TIMEOUT_MS;
      const maxHit = now - tx.startedAt > MAX_TX_DURATION_MS;
      if (deadKey || maxHit) {
        this.activeTalkers.delete(id);
        this.broadcastTxEnd(tx);
        changed = true;
      }
    }
    if (changed) this.broadcastClash();
  }

  sendJson(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Socket likely closing
    }
  }

  getMeta(ws) {
    try {
      return ws.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }

  setMeta(ws, meta) {
    try {
      ws.serializeAttachment(meta);
    } catch {
      // ignore
    }
  }

  webSocketMessage(ws, message) {
    const meta = this.getMeta(ws);
    meta.lastSeen = Date.now();

    // Binary frame = live audio frame from an active transmitter
    if (message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
      this.pruneExpiredTalkers();
      const tx = this.activeTalkers.get(meta.clientId);
      if (!tx) return;
      tx.lastAudioAt = Date.now();
      const src = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      if (src.byteLength < 5 || src.byteLength > 64 * 1024) return;
      // Stamp server-assigned sender slotId into byte 1 so listeners can demux overlapping talkers cleanly
      const stamped = new Uint8Array(src);
      if (stamped[0] === 0x01) {
        stamped[1] = (tx.slotId || 1) & 0xff;
      }
      this.relayAudioChunk(ws, tx, stamped.buffer);
      return;
    }

    if (typeof message !== 'string') return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
      case 'hello':
      case 'pos': {
        if (typeof data.handle === 'string') meta.handle = sanitizeHandle(data.handle);
        if (Number.isFinite(data.lat) && Number.isFinite(data.lon)) {
          meta.lat = Number(data.lat);
          meta.lon = Number(data.lon);
        }
        if (Number.isFinite(data.heading)) meta.heading = Number(data.heading);
        if (Number.isFinite(data.speedMph)) meta.speedMph = Number(data.speedMph);
        if (meta.groupType === 'PUB' && Number.isFinite(data.rangeMi)) {
          const r = Number(data.rangeMi);
          meta.rangeMi = r <= 0 ? 0 : Math.min(500, Math.max(1, r));
        }
        if (meta.groupType === 'CMP' && typeof data.sharePin === 'boolean') {
          meta.sharePin = data.sharePin;
        }
        this.setMeta(ws, meta);
        this.broadcastPresence(data.type === 'hello');
        break;
      }

      case 'tx_start': {
        this.pruneExpiredTalkers();
        // True open-carrier CB: never lock out PTT with "Channel busy".
        // If 4+ carriers pile up, drop the oldest carrier so fresh break-ins always work.
        if (this.activeTalkers.size >= 4 && !this.activeTalkers.has(meta.clientId)) {
          const oldestKey = this.activeTalkers.keys().next().value;
          const oldest = this.activeTalkers.get(oldestKey);
          if (oldest) {
            this.activeTalkers.delete(oldestKey);
            this.broadcastTxEnd(oldest);
          }
        }
        const codec = typeof data.codec === 'string' ? data.codec.slice(0, 32) : 'ulaw-12k';
        const targetHandle = typeof data.targetHandle === 'string' ? sanitizeHandle(data.targetHandle) : '';
        const now = Date.now();
        const tx = {
          clientId: meta.clientId,
          slotId: meta.slotId || 1,
          handle: meta.handle,
          lat: meta.lat,
          lon: meta.lon,
          heading: meta.heading,
          rangeMi: meta.rangeMi,
          channelId: meta.channelId,
          groupType: meta.groupType,
          codec,
          targetHandle,
          startedAt: now,
          lastAudioAt: now,
        };
        this.activeTalkers.set(meta.clientId, tx);
        this.sendJson(ws, {type: 'tx_granted', channelId: meta.channelId, slotId: tx.slotId, activeCount: this.activeTalkers.size});
        this.broadcastTxStart(ws, tx);
        if (this.activeTalkers.size >= 2) {
          this.broadcastClash();
        }
        break;
      }

      case 'tx_end': {
        const finished = this.activeTalkers.get(meta.clientId);
        if (finished) {
          this.activeTalkers.delete(meta.clientId);
          this.broadcastTxEnd(finished);
          this.broadcastClash();
        }
        break;
      }

      case 'ping': {
        this.sendJson(ws, {type: 'pong', ts: Date.now()});
        break;
      }

      case 'ping_driver': {
        if (meta.groupType !== 'CMP' || !data.targetClientId) return;
        for (const peerWs of this.ctx.getWebSockets()) {
          const peer = this.getMeta(peerWs);
          if (peer.clientId === data.targetClientId) {
            this.sendJson(peerWs, {
              type: 'driver_ping',
              fromClientId: meta.clientId,
              fromHandle: meta.handle,
              channelId: meta.channelId,
              groupType: meta.groupType,
            });
            break;
          }
        }
        break;
      }
    }
  }

  webSocketClose(ws) {
    this.handleDisconnect(ws);
  }

  webSocketError(ws) {
    this.handleDisconnect(ws);
  }

  handleDisconnect(ws) {
    const meta = this.getMeta(ws);
    const finished = this.activeTalkers.get(meta.clientId);
    if (finished) {
      this.activeTalkers.delete(meta.clientId);
      this.broadcastTxEnd(finished);
      this.broadcastClash();
    }
    this.broadcastPresence(true);
  }

  broadcastClash() {
    const handles = [...this.activeTalkers.values()].map(t => t.handle);
    const count = handles.length;
    for (const peerWs of this.ctx.getWebSockets()) {
      this.sendJson(peerWs, {
        type: 'rx_clash',
        count,
        handles,
      });
    }
  }

  shouldDeliver(sender, listener) {
    if (!listener || listener.clientId === sender.clientId) return false;
    if (sender.groupType === 'FAM' || sender.groupType === 'CMP') return true;
    return isWithinReceptionRange(sender, listener);
  }

  broadcastTxStart(senderWs, tx) {
    const priority = tx.groupType === 'FAM' || tx.groupType === 'CMP' ? 4 : 5;
    for (const peerWs of this.ctx.getWebSockets()) {
      if (peerWs === senderWs) continue;
      const peer = this.getMeta(peerWs);
      if (!this.shouldDeliver(tx, peer)) continue;
      const distMi = haversineMiles(peer.lat, peer.lon, tx.lat, tx.lon);
      const brg = bearingDegrees(peer.lat, peer.lon, tx.lat, tx.lon);
      this.sendJson(peerWs, {
        type: 'rx_start',
        fromClientId: tx.clientId,
        slotId: tx.slotId,
        handle: tx.handle,
        targetHandle: tx.targetHandle || '',
        channelId: tx.channelId,
        groupType: tx.groupType,
        priority,
        codec: tx.codec || 'ulaw-12k',
        distanceMi: distMi !== null ? Math.round(distMi * 10) / 10 : null,
        direction: cardinalDirection(brg),
      });
    }
  }

  relayAudioChunk(senderWs, senderTx, bytes) {
    for (const peerWs of this.ctx.getWebSockets()) {
      if (peerWs === senderWs) continue;
      const peer = this.getMeta(peerWs);
      if (!this.shouldDeliver(senderTx, peer)) continue;
      try {
        peerWs.send(bytes);
      } catch {
        // ignore closed sockets
      }
    }
  }

  broadcastTxEnd(tx) {
    for (const peerWs of this.ctx.getWebSockets()) {
      const peer = this.getMeta(peerWs);
      if (peer.clientId === tx.clientId) continue;
      this.sendJson(peerWs, {
        type: 'rx_end',
        fromClientId: tx.clientId,
        slotId: tx.slotId,
        handle: tx.handle,
        channelId: tx.channelId,
        groupType: tx.groupType,
      });
    }
  }

  broadcastPresence(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPresenceBroadcast < PRESENCE_THROTTLE_MS) return;
    this.lastPresenceBroadcast = now;

    const sockets = this.ctx.getWebSockets();
    const metas = sockets.map(ws => ({ws, meta: this.getMeta(ws)}));
    if (!metas.length) return;

    const groupType = metas[0].meta.groupType || 'PUB';
    const channelId = metas[0].meta.channelId || 'CH19';

    if (groupType === 'CMP') {
      const pins = metas
        .filter(({meta}) => meta.sharePin && Number.isFinite(meta.lat) && Number.isFinite(meta.lon))
        .map(({meta}) => ({
          clientId: meta.clientId,
          handle: meta.handle,
          lat: meta.lat,
          lon: meta.lon,
          heading: meta.heading,
          speedMph: meta.speedMph,
          updatedAt: meta.lastSeen,
        }));
      for (const {ws, meta} of metas) {
        this.sendJson(ws, {
          type: 'presence',
          channelId,
          groupType,
          nearbyCount: Math.max(0, metas.length - 1),
          peers: pins.filter(p => p.clientId !== meta.clientId),
        });
      }
      return;
    }

    if (groupType === 'FAM') {
      for (const {ws} of metas) {
        this.sendJson(ws, {
          type: 'presence',
          channelId,
          groupType,
          nearbyCount: Math.max(0, metas.length - 1),
        });
      }
      return;
    }

    // Public channel: compute each listener's in-range count without leaking stranger coordinates
    for (const {ws, meta} of metas) {
      let nearbyCount = 0;
      for (const other of metas) {
        if (other.meta.clientId === meta.clientId) continue;
        if (isWithinReceptionRange(other.meta, meta)) nearbyCount++;
      }
      this.sendJson(ws, {
        type: 'presence',
        channelId,
        groupType,
        nearbyCount,
      });
    }
  }
}
