import {DurableObject} from 'cloudflare:workers';
import {generateInviteCode, generateToken, sanitizeHandle} from './geo.mjs';

/**
 * SQLite-backed Durable Object managing private FAM and CMP groups,
 * invite codes, 1-tap owner approvals, and membership tokens.
 */
export class GroupDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        invite_code TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        handle TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        member_token TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_groups_code ON groups(invite_code);
      CREATE INDEX IF NOT EXISTS idx_members_token ON members(member_token);
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST' && path === '/create') {
        const body = await request.json();
        return this.handleCreate(body);
      }
      if (request.method === 'POST' && path === '/join') {
        const body = await request.json();
        return this.handleJoin(body);
      }
      if (request.method === 'GET' && path === '/status') {
        return this.handleStatus(url.searchParams.get('groupId'), url.searchParams.get('userId'));
      }
      if (request.method === 'GET' && path === '/pending') {
        return this.handlePending(url.searchParams.get('groupId'), url.searchParams.get('token'));
      }
      if (request.method === 'POST' && path === '/approve') {
        const body = await request.json();
        return this.handleApprove(body);
      }
      if (request.method === 'POST' && path === '/leave') {
        const body = await request.json();
        return this.handleLeave(body);
      }
      if (request.method === 'POST' && path === '/update-handle') {
        const body = await request.json();
        return this.handleUpdateHandle(body);
      }
      if (request.method === 'GET' && path === '/verify') {
        return this.handleVerify(url.searchParams.get('groupId'), url.searchParams.get('token'));
      }
      return Response.json({error: 'Not found'}, {status: 404});
    } catch (err) {
      return Response.json({error: String(err?.message || err)}, {status: 400});
    }
  }

  handleCreate(body) {
    const type = body?.type === 'CMP' ? 'CMP' : 'FAM';
    const name = String(body?.name || (type === 'CMP' ? 'Company Fleet' : 'Family')).trim().slice(0, 40);
    const ownerId = String(body?.userId || '').trim().slice(0, 64);
    if (!ownerId) return Response.json({error: 'Missing userId'}, {status: 400});
    const handle = sanitizeHandle(body?.handle);

    const groupId = `${type.toLowerCase()}_${generateToken(8)}`;
    let inviteCode = generateInviteCode(type);
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = [...this.sql.exec('SELECT 1 FROM groups WHERE invite_code = ?', inviteCode)];
      if (!existing.length) break;
      inviteCode = generateInviteCode(type);
    }
    const memberToken = generateToken(24);
    const now = Date.now();

    this.sql.exec(
      'INSERT INTO groups (group_id, invite_code, type, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      groupId, inviteCode, type, name, ownerId, now
    );
    this.sql.exec(
      'INSERT INTO members (group_id, user_id, handle, role, status, member_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      groupId, ownerId, handle, 'owner', 'approved', memberToken, now
    );

    return Response.json({
      groupId,
      type,
      name,
      inviteCode,
      role: 'owner',
      status: 'approved',
      memberToken,
    });
  }

  handleJoin(body) {
    const rawCode = String(body?.inviteCode || '').trim().toUpperCase();
    const userId = String(body?.userId || '').trim().slice(0, 64);
    if (!rawCode || !userId) {
      return Response.json({error: 'Invite code and userId are required'}, {status: 400});
    }
    const handle = sanitizeHandle(body?.handle);

    const rows = [...this.sql.exec('SELECT group_id, type, name, invite_code FROM groups WHERE invite_code = ?', rawCode)];
    if (!rows.length) {
      return Response.json({error: 'Invalid invite code'}, {status: 404});
    }
    const group = rows[0];

    const existing = [
      ...this.sql.exec(
        'SELECT role, status, member_token FROM members WHERE group_id = ? AND user_id = ?',
        group.group_id, userId
      ),
    ];
    if (existing.length) {
      const rec = existing[0];
      if (rec.status === 'approved') {
        return Response.json({
          groupId: group.group_id,
          type: group.type,
          name: group.name,
          inviteCode: group.invite_code,
          role: rec.role,
          status: 'approved',
          memberToken: rec.member_token,
        });
      }
      // Re-submit if previously pending or rejected
      this.sql.exec(
        'UPDATE members SET handle = ?, status = ?, created_at = ? WHERE group_id = ? AND user_id = ?',
        handle, 'pending', Date.now(), group.group_id, userId
      );
    } else {
      this.sql.exec(
        'INSERT INTO members (group_id, user_id, handle, role, status, member_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        group.group_id, userId, handle, 'member', 'pending', null, Date.now()
      );
    }

    return Response.json({
      groupId: group.group_id,
      type: group.type,
      name: group.name,
      inviteCode: group.invite_code,
      role: 'member',
      status: 'pending',
    });
  }

  handleStatus(groupId, userId) {
    if (!groupId || !userId) return Response.json({error: 'Missing groupId or userId'}, {status: 400});
    const rows = [
      ...this.sql.exec(
        `SELECT m.role, m.status, m.member_token, g.type, g.name, g.invite_code
         FROM members m JOIN groups g ON g.group_id = m.group_id
         WHERE m.group_id = ? AND m.user_id = ?`,
        groupId, userId
      ),
    ];
    if (!rows.length) return Response.json({status: 'none'});
    const r = rows[0];
    return Response.json({
      groupId,
      type: r.type,
      name: r.name,
      inviteCode: r.invite_code,
      role: r.role,
      status: r.status,
      memberToken: r.status === 'approved' ? r.member_token : null,
    });
  }

  handlePending(groupId, token) {
    if (!groupId || !token) return Response.json({error: 'Unauthorized'}, {status: 401});
    const auth = [
      ...this.sql.exec(
        'SELECT role, status FROM members WHERE group_id = ? AND member_token = ?',
        groupId, token
      ),
    ];
    if (!auth.length || auth[0].status !== 'approved') {
      return Response.json({error: 'Unauthorized'}, {status: 401});
    }
    const isOwner = auth[0].role === 'owner';
    const members = [
      ...this.sql.exec(
        'SELECT user_id, handle, role, status, created_at FROM members WHERE group_id = ? ORDER BY created_at DESC',
        groupId
      ),
    ];
    return Response.json({
      isOwner,
      pending: isOwner ? members.filter(m => m.status === 'pending') : [],
      approved: members.filter(m => m.status === 'approved'),
    });
  }

  handleApprove(body) {
    const groupId = String(body?.groupId || '');
    const token = String(body?.token || '');
    const targetUserId = String(body?.targetUserId || '');
    const approve = Boolean(body?.approve);

    const auth = [
      ...this.sql.exec(
        'SELECT role, status FROM members WHERE group_id = ? AND member_token = ?',
        groupId, token
      ),
    ];
    if (!auth.length || auth[0].role !== 'owner' || auth[0].status !== 'approved') {
      return Response.json({error: 'Owner authorization required'}, {status: 403});
    }
    if (!targetUserId) return Response.json({error: 'Missing targetUserId'}, {status: 400});

    if (approve) {
      const newToken = generateToken(24);
      this.sql.exec(
        'UPDATE members SET status = ?, member_token = ? WHERE group_id = ? AND user_id = ?',
        'approved', newToken, groupId, targetUserId
      );
      return Response.json({ok: true, status: 'approved', targetUserId});
    }
    this.sql.exec(
      'UPDATE members SET status = ?, member_token = NULL WHERE group_id = ? AND user_id = ?',
      'rejected', groupId, targetUserId
    );
    return Response.json({ok: true, status: 'rejected', targetUserId});
  }

  handleLeave(body) {
    const groupId = String(body?.groupId || '');
    const token = String(body?.token || '');
    const targetUserId = body?.targetUserId ? String(body.targetUserId) : '';

    const auth = [
      ...this.sql.exec(
        'SELECT user_id, role, status FROM members WHERE group_id = ? AND member_token = ?',
        groupId, token
      ),
    ];
    if (!auth.length || auth[0].status !== 'approved') {
      return Response.json({error: 'Unauthorized'}, {status: 401});
    }
    const removeId = targetUserId && auth[0].role === 'owner' ? targetUserId : auth[0].user_id;
    this.sql.exec('DELETE FROM members WHERE group_id = ? AND user_id = ?', groupId, removeId);
    return Response.json({ok: true, removedUserId: removeId});
  }

  handleUpdateHandle(body) {
    const groupId = String(body?.groupId || '');
    const token = String(body?.token || '');
    const handle = sanitizeHandle(body?.handle);
    if (!groupId || !token) return Response.json({error: 'Unauthorized'}, {status: 401});
    const auth = [
      ...this.sql.exec(
        'SELECT user_id FROM members WHERE group_id = ? AND member_token = ? AND status = ?',
        groupId, token, 'approved'
      ),
    ];
    if (!auth.length) return Response.json({error: 'Unauthorized'}, {status: 401});
    this.sql.exec(
      'UPDATE members SET handle = ? WHERE group_id = ? AND user_id = ?',
      handle, groupId, auth[0].user_id
    );
    return Response.json({ok: true, handle});
  }

  handleVerify(groupId, token) {
    if (!groupId || !token) return Response.json({valid: false}, {status: 401});
    const rows = [
      ...this.sql.exec(
        `SELECT m.user_id, m.handle, m.role, m.status, g.type, g.name
         FROM members m JOIN groups g ON g.group_id = m.group_id
         WHERE m.group_id = ? AND m.member_token = ? AND m.status = 'approved'`,
        groupId, token
      ),
    ];
    if (!rows.length) return Response.json({valid: false}, {status: 403});
    return Response.json({
      valid: true,
      userId: rows[0].user_id,
      handle: rows[0].handle,
      role: rows[0].role,
      type: rows[0].type,
      name: rows[0].name,
    });
  }
}
