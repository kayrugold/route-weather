/**
 * Pure geo + channel helpers for Atlas CB Radio (shared by Worker DOs and unit tests).
 */

const EARTH_RADIUS_MI = 3958.7613;

export function haversineMiles(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) || !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) || !Number.isFinite(lon2)
  ) {
    return null;
  }
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDegrees(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) || !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) || !Number.isFinite(lon2)
  ) {
    return null;
  }
  const toRad = d => (d * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function cardinalDirection(deg) {
  if (!Number.isFinite(deg)) return '';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/**
 * Normalize a public channel identifier (e.g. "CH 19", "19", "ch17", "custom 42")
 * into canonical form "CH19", "CH17", "CH42" (1..999). Returns null if invalid.
 */
export function normalizePublicChannel(raw) {
  const s = String(raw || '').trim().toUpperCase();
  const m = s.match(/^(?:CH\s*|CHANNEL\s*|CUSTOM\s*)?(\d{1,3})$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isInteger(num) || num < 1 || num > 999) return null;
  return 'CH' + num;
}

/**
 * Determine whether a listener should receive a transmission from a sender on a public channel.
 * rangeMi === 0 means Global.
 */
export function isWithinReceptionRange(sender, listener) {
  const listenerRange = Number(listener?.rangeMi ?? 30);
  if (listenerRange === 0) return true; // Listener set to Global
  const dist = haversineMiles(sender?.lat, sender?.lon, listener?.lat, listener?.lon);
  if (dist === null) {
    // If either device lacks a GPS fix (e.g. indoor tablet/laptop or tunnel), allow channel audio
    return true;
  }
  return dist <= listenerRange;
}

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateInviteCode(type) {
  const prefix = type === 'CMP' ? 'CMP' : 'FAM';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < bytes.length; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `${prefix}-${code}`;
}

export function generateToken(len = 24) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function sanitizeHandle(raw) {
  const clean = String(raw || '')
    .replace(/[^\w\s.\-#']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return clean || 'Driver';
}
