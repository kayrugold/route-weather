const androidOrigin = 'https://appassets.androidplatform.net';
const titles = new Set(['Debris in road', 'Stopped vehicle', 'Crash', 'Road blocked']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validId = value => typeof value === 'string' && uuid.test(value);
const validPoint = (lat, lon) => Number.isFinite(lat) && Math.abs(lat) <= 90 &&
  Number.isFinite(lon) && Math.abs(lon) <= 180;
const lifetime = 90 * 60_000;
const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
const failure = (status, error) => json({error}, status);

async function readBody(request) {
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  for (;;) {
    const {value, done} = await reader.read();
    if (done) return JSON.parse(text + decoder.decode());
    bytes += value.length;
    if (bytes > 1024) {
      await reader.cancel();
      throw new Error('Report body is too large.');
    }
    text += decoder.decode(value, {stream: true});
  }
}

export async function handleRoadReports(request, env, app) {
  const origin = request.headers.get('Origin');
  const url = new URL(request.url);
  if (origin && origin !== (app ? androidOrigin : url.origin)) return failure(403, 'Origin unavailable.');
  const headers = {Vary: 'Origin'};
  if (app && origin === androidOrigin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers});
  const reply = async () => {
    if (!env.ROAD_REPORTS) return failure(503, 'Shared reports are unavailable.');
    if (request.method === 'GET') {
      const peers = url.searchParams;
      if (!peers.get('lat')?.trim() || !peers.get('lon')?.trim() ||
          !validPoint(Number(peers.get('lat')), Number(peers.get('lon')))) return failure(400, 'Invalid location.');
    } else if (request.method === 'POST') {
      if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
        return failure(415, 'Expected a JSON report.');
      }
      const ip = request.headers.get('CF-Connecting-IP');
      if (ip && env.REPORT_WRITE_RATE && !(await env.REPORT_WRITE_RATE.limit({key: ip})).success) {
        return failure(429, 'Too many report updates. Try again in a minute.');
      }
      let report;
      try { report = await readBody(request); }
      catch { return failure(400, 'Invalid report.'); }
      if (!validId(report?.reporter) || !validId(report.id)) return failure(400, 'Invalid report.');
      const {id, reporter, action, title, lat, lon} = report;
      if (action === 'create' ? !titles.has(title) || !validPoint(lat, lon) :
          action !== 'still-there' && action !== 'clear') return failure(400, 'Invalid report.');
      return env.ROAD_REPORTS.getByName('shared').fetch(new Request('https://road-reports.internal', {
        method: 'POST', body: JSON.stringify({id, reporter, action, title, lat, lon}),
      }));
    } else return failure(405, 'Method not allowed.');
    return env.ROAD_REPORTS.getByName('shared').fetch('https://road-reports.internal' + url.search);
  };
  let response;
  try { response = await reply(); }
  catch { response = failure(503, 'Shared reports are unavailable.'); }
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) result.headers.set(name, value);
  return result;
}

export class RoadReports {
  constructor(state) {
    this.storage = state.storage;
    this.sql = this.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
        lat REAL NOT NULL, lon REAL NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
        cleared INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS report_location ON reports(lat, lon);
      CREATE INDEX IF NOT EXISTS report_owner ON reports(owner);
      CREATE INDEX IF NOT EXISTS report_expiry ON reports(end);
      CREATE TABLE IF NOT EXISTS votes (
        report TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        reporter TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY(report, reporter)
      );
    `);
  }

  async fetch(request) {
    const now = Date.now();
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const lat = Number(params.get('lat')), lon = Number(params.get('lon'));
      const latSpan = .135;
      const lonSpan = Math.min(180, latSpan / Math.cos(Math.min(90, Math.abs(lat) + latSpan) * Math.PI / 180));
      const reports = this.sql.exec(`
        SELECT id, title, lat, lon, start, end,
          (SELECT max(at) FROM votes WHERE report = reports.id AND action = 'still-there') AS confirmed
        FROM reports
        WHERE cleared = 0 AND end > ? AND lat BETWEEN ? AND ?
          AND (abs(lon - ?) <= ? OR abs(lon - ?) >= 360 - ?)
        ORDER BY start DESC LIMIT 100
      `, now, lat - latSpan, lat + latSpan, lon, lonSpan, lon, lonSpan).toArray();
      return json({reports});
    }

    const {id, reporter, action, title, lat, lon} = await request.json();
    const owner = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reporter))),
      byte => byte.toString(16).padStart(2, '0')).join('');
    const row = this.sql.exec('SELECT owner, start, end, cleared FROM reports WHERE id = ?', id).toArray()[0];
    if (action === 'create') {
      if (row) return row.owner === owner && !row.cleared && row.end > now ? json({end: row.end}) :
        failure(409, 'Report is no longer active.');
      if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(now + lifetime);
      const entry = this.sql.exec(`
        INSERT INTO reports(id, owner, title, lat, lon, start, end)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT count(*) FROM reports WHERE owner = ? AND start > ?) < 8
        ON CONFLICT(id) DO NOTHING RETURNING end
      `, id, owner, title, lat, lon, now, now + lifetime, owner, now - lifetime).toArray()[0];
      if (entry) return json(entry, 201);
      const duplicate = this.sql.exec('SELECT owner, end, cleared FROM reports WHERE id = ?', id).toArray()[0];
      return duplicate?.owner === owner && !duplicate.cleared ? json({end: duplicate.end}) :
        failure(429, 'Report limit reached. Try again later.');
    }

    if (!row || row.end <= now || row.cleared) return json({cleared: true});
    if (action === 'clear' && row.owner === owner) {
      this.sql.exec('UPDATE reports SET cleared = 1 WHERE id = ?', id);
      return json({cleared: true});
    }
    this.sql.exec(`
      INSERT INTO votes(report, reporter, action, at) VALUES (?, ?, ?, ?)
      ON CONFLICT(report, reporter) DO UPDATE SET action = excluded.action, at = excluded.at
    `, id, owner, action, now);
    if (action === 'clear') {
      const {count} = this.sql.exec("SELECT count(*) AS count FROM votes WHERE report = ? AND action = 'clear'", id).one();
      if (count >= 2) {
        this.sql.exec('UPDATE reports SET cleared = 1 WHERE id = ?', id);
        return json({cleared: true});
      }
    }
    return json({cleared: false});
  }

  async alarm() {
    this.sql.exec('DELETE FROM reports WHERE end <= ?', Date.now());
    const {next} = this.sql.exec('SELECT min(end) AS next FROM reports').one();
    if (next !== null) await this.storage.setAlarm(next);
  }
}
