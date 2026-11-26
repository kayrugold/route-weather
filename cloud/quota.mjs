// These are conservative preview limits. Verify the studio account before raising them.
const limits = {
  search: {total: 10000, demo: 1000},
  places: {total: 2400, demo: 200},
  routing: {total: 5000, demo: 500},
  reverse: {total: 2000, demo: 200},
  traffic: {total: 10000, demo: 1000},
};

export class TripQuota {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS usage (
      month TEXT NOT NULL, bucket TEXT NOT NULL, total INTEGER NOT NULL, demo INTEGER NOT NULL,
      PRIMARY KEY (month, bucket)
    )`);
  }

  async fetch(request) {
    if (request.method !== 'POST') return new Response(null, {status: 405});
    const {bucket, client} = await request.json();
    if (!Object.hasOwn(limits, bucket) || !['app', 'demo'].includes(client)) {
      return new Response(null, {status: 400});
    }
    const month = new Date().toISOString().slice(0, 7);
    const demo = Number(client === 'demo');
    const cap = limits[bucket];
    // A single synchronous SQL statement reserves each upstream call atomically.
    const reserved = this.sql.exec(`
      INSERT INTO usage (month, bucket, total, demo)
      SELECT ?, ?, 1, ? WHERE ? <= ?
      ON CONFLICT (month, bucket) DO UPDATE SET total = total + 1, demo = demo + excluded.demo
      WHERE total < ? AND demo + excluded.demo <= ?
      RETURNING total
    `, month, bucket, demo, demo, cap.demo, cap.total, cap.demo).toArray();
    this.sql.exec('DELETE FROM usage WHERE month < ?', month);
    return new Response(null, {status: reserved.length ? 204 : 429});
  }
}
