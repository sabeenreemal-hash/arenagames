// backend/routes/admin.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const db = require('../database');
const adminAuth = require('../middleware/adminAuth');
const { creditReferralCommission } = require('../services/referralService');
const fcmService = require('../services/fcmService');

const JWT_ADMIN_SECRET = 'ARENA_GAMES_ADMIN_SECRET_KEY';
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;
const MAX_HEARTBEAT_DELTA_SEC = 150;
const REFERRAL_SIGNUP_BONUS_COINS = 100;

// Default payment methods seeded if none exists in database
const DEFAULT_PAYMENT_METHODS = [
  {
    id: "eSewa",
    name: "eSewa",
    icon: "🟢",
    currency: "NPR",
    min: 5000,
    rate: 1000,
    label: "eSewa Mobile Number",
    hint: "98XXXXXXXX",
    is_active: true
  },
  {
    id: "Khalti",
    name: "Khalti",
    icon: "🟣",
    currency: "NPR",
    min: 5000,
    rate: 1000,
    label: "Khalti Mobile Number",
    hint: "98XXXXXXXX",
    is_active: true
  }
];

// Helper: Safely delete screenshot from VPS disk to keep storage clean
function deleteScreenshotFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return;

  try {
    const fileName = path.basename(filePath);
    const diskPath = path.join(__dirname, '../uploads/task_proofs', fileName);

    if (fs.existsSync(diskPath)) {
      fs.unlink(diskPath, (err) => {
        if (err) {
          console.error('[VPS Storage Cleanup Error]: Failed to delete file:', diskPath, err.message);
        } else {
          console.log('[VPS Storage Cleanup Success]: Deleted screenshot:', fileName);
        }
      });
    }
  } catch (e) {
    console.error('[VPS Storage Cleanup Exception]:', e.message);
  }
}

// Helper: Safe column migration
function addColumnSafe(table, column, type, defaultVal) {
  db.all(`PRAGMA table_info(${table})`, (err, cols) => {
    if (!err && Array.isArray(cols) && cols.length > 0) {
      if (!cols.some(c => c.name === column)) {
        let sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`;
        if (defaultVal !== undefined && defaultVal !== null) {
          sql += ` DEFAULT ${defaultVal}`;
        }
        db.run(sql, (aErr) => {
          if (aErr) console.error(`[DB Migration Error] ${table}.${column}:`, aErr.message);
        });
      }
    }
  });
}

// Helper: Extract admin identity from req (compatible with any adminAuth middleware)
function extractAdmin(req) {
  const source = req.admin || req.user;
  if (source && (source.id || source.username)) {
    return {
      id: source.id || null,
      username: String(source.username || '').trim()
    };
  }
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.slice(7).trim(), JWT_ADMIN_SECRET);
      return {
        id: decoded.id || null,
        username: String(decoded.username || '').trim()
      };
    } catch (_) {}
  }
  return { id: null, username: 'unknown' };
}

function isMasterUsername(username) {
  return String(username || '').trim().toLowerCase() === 'admin';
}

function requireMasterAdmin(req, res, next) {
  const actor = extractAdmin(req);
  if (!isMasterUsername(actor.username)) {
    return res.status(403).json({ error: 'Master admin privileges required' });
  }
  next();
}

// Helper: Async fire-and-forget audit log (zero latency impact)
function logAdminActivity(actorInput, actionType, targetType = '', targetId = '', targetLabel = '', details = '') {
  try {
    const actor = actorInput && actorInput.headers ? extractAdmin(actorInput) : (actorInput || {});
    db.run(
      `INSERT INTO admin_activity_logs (admin_id, admin_username, action_type, target_type, target_id, target_label, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        actor.id || null,
        actor.username || 'unknown',
        String(actionType || 'UNKNOWN'),
        String(targetType || ''),
        targetId !== undefined && targetId !== null ? String(targetId) : '',
        String(targetLabel || ''),
        String(details || '')
      ],
      (err) => {
        if (err) console.error('[Activity Log Error]:', err.message);
      }
    );
  } catch (e) {
    console.error('[Activity Log Exception]:', e.message);
  }
}

// Helper: Date & Online time accrual
function getUtcToday() {
  return new Date().toISOString().slice(0, 10);
}

function computeOnlineAccrual(adminRow, nowMs = Date.now()) {
  const today = getUtcToday();
  let totalSec = Number(adminRow.total_online_seconds || 0);
  let dailySec = adminRow.daily_online_date === today ? Number(adminRow.daily_online_seconds || 0) : 0;

  if (adminRow.is_online === 1 && adminRow.last_heartbeat_at) {
    const lastMs = Date.parse(adminRow.last_heartbeat_at);
    if (!Number.isNaN(lastMs) && nowMs > lastMs) {
      const deltaSec = Math.min(Math.floor((nowMs - lastMs) / 1000), MAX_HEARTBEAT_DELTA_SEC);
      if (deltaSec > 0) {
        totalSec += deltaSec;
        dailySec += deltaSec;
      }
    }
  }

  return { totalSec, dailySec, today };
}

function expireStaleAdminSessions(callback) {
  db.all('SELECT * FROM admins WHERE is_online = 1', (err, rows) => {
    if (err || !rows || rows.length === 0) return callback();
    const nowMs = Date.now();
    const staleRows = rows.filter(r => {
      if (!r.last_heartbeat_at) return true;
      const lastMs = Date.parse(r.last_heartbeat_at);
      return Number.isNaN(lastMs) || (nowMs - lastMs) > STALE_HEARTBEAT_MS;
    });

    if (staleRows.length === 0) return callback();

    let pending = staleRows.length;
    staleRows.forEach(r => {
      const { totalSec, dailySec, today } = computeOnlineAccrual(r, nowMs);
      db.run(
        `UPDATE admins
         SET is_online = 0,
             online_since = NULL,
             total_online_seconds = ?,
             daily_online_seconds = ?,
             daily_online_date = ?
         WHERE id = ?`,
        [totalSec, dailySec, today, r.id],
        () => {
          pending -= 1;
          if (pending === 0) callback();
        }
      );
    });
  });
}

function isSignupBonusTx(tx) {
  const t = String(tx.type || '').toUpperCase();
  const amt = Number(tx.amount || 0);
  return amt === REFERRAL_SIGNUP_BONUS_COINS && (t.includes('BONUS') || t.includes('SIGNUP') || t === 'REFERRAL');
}

// ---------------------------------------------------------------------------
// 0. Safe Database Initialization
// ---------------------------------------------------------------------------
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      full_name TEXT,
      password_hash TEXT,
      is_online INTEGER DEFAULT 0,
      online_since TEXT DEFAULT NULL,
      last_heartbeat_at TEXT DEFAULT NULL,
      last_login_at TEXT DEFAULT NULL,
      total_online_seconds INTEGER DEFAULT 0,
      daily_online_seconds INTEGER DEFAULT 0,
      daily_online_date TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  addColumnSafe('admins', 'full_name', 'TEXT', 'NULL');
  addColumnSafe('admins', 'is_online', 'INTEGER', 0);
  addColumnSafe('admins', 'online_since', 'TEXT', 'NULL');
  addColumnSafe('admins', 'last_heartbeat_at', 'TEXT', 'NULL');
  addColumnSafe('admins', 'last_login_at', 'TEXT', 'NULL');
  addColumnSafe('admins', 'total_online_seconds', 'INTEGER', 0);
  addColumnSafe('admins', 'daily_online_seconds', 'INTEGER', 0);
  addColumnSafe('admins', 'daily_online_date', 'TEXT', "''");
  addColumnSafe('admins', 'created_at', 'TEXT', 'NULL');

  db.run(`
    CREATE TABLE IF NOT EXISTS admin_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      admin_username TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target_type TEXT DEFAULT '',
      target_id TEXT DEFAULT '',
      target_label TEXT DEFAULT '',
      details TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS push_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_username TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_user_id INTEGER DEFAULT NULL,
      target_label TEXT DEFAULT '',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      screen TEXT DEFAULT '',
      targeted_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_activity_logs(id DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_activity_logs(admin_username, id DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_activity_logs(action_type, id DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_id)`);

  db.get("SELECT COUNT(*) as count FROM admins", (cErr, row) => {
    if (!cErr && row && row.count === 0) {
      bcrypt.hash('admin123', 10, (hErr, hash) => {
        if (!hErr && hash) {
          db.run(
            "INSERT INTO admins (username, full_name, password_hash) VALUES (?, ?, ?)",
            ['admin', 'Master Admin', hash]
          );
        }
      });
    }
  });

  // Ensure default payment methods exist
  db.get("SELECT value FROM app_config WHERE key = 'payment_methods'", (err, row) => {
    if (!err && (!row || !row.value)) {
      db.run(
        "INSERT OR REPLACE INTO app_config (key, value) VALUES ('payment_methods', ?)",
        [JSON.stringify(DEFAULT_PAYMENT_METHODS)]
      );
    }
  });

  // Ensure user ban, FCM, and activity columns exist
  addColumnSafe('users', 'ban_reason', 'TEXT', 'NULL');
  addColumnSafe('users', 'fcm_token', 'TEXT', 'NULL');
  addColumnSafe('users', 'fcm_updated_at', 'DATETIME', 'NULL');
  addColumnSafe('users', 'last_active_at', 'DATETIME', 'NULL');
});

// ---------------------------------------------------------------------------
// PUBLIC ROUTES FOR MOBILE APP (NO adminAuth REQUIRED)
// ---------------------------------------------------------------------------

// 1. Version Check & Force Update Endpoint
router.get('/public/config', (req, res) => {
  db.all('SELECT key, value FROM app_config', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database read error' });

    const config = {};
    (rows || []).forEach(r => {
      config[r.key] = r.value;
    });

    res.json({
      min_version: config.min_version || '1.0.0',
      update_url: config.update_url || 'https://play.google.com/store',
      force_update: config.force_update === 'true' || config.force_update === true || config.force_update === '1'
    });
  });
});

// 2. Public Payment Gateways (Redemption Options for Mobile App)
router.get('/public/payment-methods', (req, res) => {
  db.get("SELECT value FROM app_config WHERE key = 'payment_methods'", (err, row) => {
    if (err) return res.status(500).json({ error: 'Database read error' });
    try {
      const data = row && row.value ? JSON.parse(row.value) : DEFAULT_PAYMENT_METHODS;
      res.json(data);
    } catch {
      res.json(DEFAULT_PAYMENT_METHODS);
    }
  });
});

// 3. Public User Ban Status Check for Mobile App
router.get('/public/user-status', (req, res) => {
  const { userId, username } = req.query;
  if (!userId && !username) {
    return res.json({ is_banned: false, ban_reason: '' });
  }

  const cleanId = userId && userId !== '0' ? userId : null;
  const cleanUser = username ? String(username).trim().toLowerCase() : null;

  let sql = '';
  let params = [];
  if (cleanId && cleanUser) {
    sql = 'SELECT is_banned, ban_reason FROM users WHERE id = ? OR LOWER(username) = ? LIMIT 1';
    params = [cleanId, cleanUser];
  } else if (cleanId) {
    sql = 'SELECT is_banned, ban_reason FROM users WHERE id = ? LIMIT 1';
    params = [cleanId];
  } else {
    sql = 'SELECT is_banned, ban_reason FROM users WHERE LOWER(username) = ? LIMIT 1';
    params = [cleanUser];
  }

  db.get(sql, params, (err, row) => {
    if (err || !row) {
      return res.json({ is_banned: false, ban_reason: '' });
    }
    res.json({
      is_banned: row.is_banned === 1 || row.is_banned === true,
      ban_reason: row.ban_reason || ''
    });
  });
});

// ---------------------------------------------------------------------------
// A. Admin Login, Profile & Online/Offline Presence
// ---------------------------------------------------------------------------
function completeAdminLogin(admin, res) {
  const nowIso = new Date().toISOString();
  const today = getUtcToday();
  const dailySec = admin.daily_online_date === today ? Number(admin.daily_online_seconds || 0) : 0;

  db.run(
    `UPDATE admins
     SET is_online = 1,
         online_since = COALESCE(online_since, ?),
         last_heartbeat_at = ?,
         last_login_at = ?,
         daily_online_seconds = ?,
         daily_online_date = ?
     WHERE id = ?`,
    [nowIso, nowIso, nowIso, dailySec, today, admin.id],
    () => {
      const token = jwt.sign(
        { id: admin.id, username: admin.username, is_master: isMasterUsername(admin.username) },
        JWT_ADMIN_SECRET,
        { expiresIn: '7d' }
      );

      logAdminActivity(
        { id: admin.id, username: admin.username },
        'ADMIN_LOGIN',
        'admin',
        admin.id,
        `@${admin.username}`,
        'Logged into admin console (Online)'
      );

      res.json({
        success: true,
        token,
        admin: {
          id: admin.id,
          username: admin.username,
          full_name: admin.full_name || 'Admin',
          is_master: isMasterUsername(admin.username),
          is_online: true,
          online_since: nowIso,
          total_online_seconds: Number(admin.total_online_seconds || 0),
          daily_online_seconds: dailySec
        }
      });
    }
  );
}

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  db.get('SELECT * FROM admins WHERE LOWER(username) = ?', [username.trim().toLowerCase()], (err, admin) => {
    if (err || !admin) return res.status(401).json({ error: 'Invalid admin credentials' });

    const storedHash = admin.password_hash || admin.password;
    if (!storedHash) return res.status(401).json({ error: 'No password set for this account' });

    bcrypt.compare(password.trim(), storedHash, (cmpErr, isValid) => {
      if (cmpErr || !isValid) {
        if (password.trim() === storedHash) {
          return completeAdminLogin(admin, res);
        }
        return res.status(401).json({ error: 'Invalid admin credentials' });
      }
      return completeAdminLogin(admin, res);
    });
  });
});

// Get currently logged-in admin details
router.get('/me', adminAuth, (req, res) => {
  const actor = extractAdmin(req);
  const query = actor.id
    ? 'SELECT * FROM admins WHERE id = ? LIMIT 1'
    : 'SELECT * FROM admins WHERE LOWER(username) = ? LIMIT 1';
  const param = actor.id ? actor.id : actor.username.toLowerCase();

  db.get(query, [param], (err, admin) => {
    if (err || !admin) return res.status(401).json({ error: 'Admin account not found' });
    const today = getUtcToday();
    const dailySec = admin.daily_online_date === today ? Number(admin.daily_online_seconds || 0) : 0;

    res.json({
      id: admin.id,
      username: admin.username,
      full_name: admin.full_name || 'Admin',
      is_master: isMasterUsername(admin.username),
      is_online: admin.is_online === 1,
      online_since: admin.online_since,
      total_online_seconds: Number(admin.total_online_seconds || 0),
      daily_online_seconds: dailySec
    });
  });
});

// Self Online / Offline Toggle
router.post('/status', adminAuth, (req, res) => {
  const actor = extractAdmin(req);
  const wantOnline = req.body.is_online === true || req.body.is_online === 1 || req.body.is_online === 'true';

  db.get('SELECT * FROM admins WHERE id = ? OR LOWER(username) = ? LIMIT 1', [actor.id || -1, actor.username.toLowerCase()], (err, admin) => {
    if (err || !admin) return res.status(404).json({ error: 'Admin not found' });

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const { totalSec, dailySec, today } = computeOnlineAccrual(admin, nowMs);

    if (wantOnline) {
      db.run(
        `UPDATE admins
         SET is_online = 1,
             online_since = COALESCE(online_since, ?),
             last_heartbeat_at = ?,
             total_online_seconds = ?,
             daily_online_seconds = ?,
             daily_online_date = ?
         WHERE id = ?`,
        [nowIso, nowIso, totalSec, dailySec, today, admin.id],
        (uErr) => {
          if (uErr) return res.status(500).json({ error: 'Failed to go online' });
          logAdminActivity(actor, 'STATUS_ONLINE', 'admin', admin.id, `@${admin.username}`, 'Switched status to Online');
          res.json({
            success: true,
            is_online: true,
            online_since: admin.online_since || nowIso,
            total_online_seconds: totalSec,
            daily_online_seconds: dailySec
          });
        }
      );
    } else {
      db.run(
        `UPDATE admins
         SET is_online = 0,
             online_since = NULL,
             last_heartbeat_at = ?,
             total_online_seconds = ?,
             daily_online_seconds = ?,
             daily_online_date = ?
         WHERE id = ?`,
        [nowIso, totalSec, dailySec, today, admin.id],
        (uErr) => {
          if (uErr) return res.status(500).json({ error: 'Failed to go offline' });
          logAdminActivity(actor, 'STATUS_OFFLINE', 'admin', admin.id, `@${admin.username}`, 'Switched status to Offline');
          res.json({
            success: true,
            is_online: false,
            online_since: null,
            total_online_seconds: totalSec,
            daily_online_seconds: dailySec
          });
        }
      );
    }
  });
});

// Lightweight 60s Heartbeat while admin is Online
router.post('/heartbeat', adminAuth, (req, res) => {
  const actor = extractAdmin(req);
  db.get('SELECT * FROM admins WHERE id = ? OR LOWER(username) = ? LIMIT 1', [actor.id || -1, actor.username.toLowerCase()], (err, admin) => {
    if (err || !admin) return res.status(404).json({ error: 'Admin not found' });

    if (admin.is_online !== 1) {
      const today = getUtcToday();
      const dailySec = admin.daily_online_date === today ? Number(admin.daily_online_seconds || 0) : 0;
      return res.json({
        success: true,
        is_online: false,
        total_online_seconds: Number(admin.total_online_seconds || 0),
        daily_online_seconds: dailySec
      });
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const { totalSec, dailySec, today } = computeOnlineAccrual(admin, nowMs);

    db.run(
      `UPDATE admins
       SET last_heartbeat_at = ?,
           total_online_seconds = ?,
           daily_online_seconds = ?,
           daily_online_date = ?
       WHERE id = ?`,
      [nowIso, totalSec, dailySec, today, admin.id],
      () => {
        res.json({
          success: true,
          is_online: true,
          total_online_seconds: totalSec,
          daily_online_seconds: dailySec
        });
      }
    );
  });
});

// Explicit Logout (settles online time and marks Offline)
router.post('/logout', adminAuth, (req, res) => {
  const actor = extractAdmin(req);
  db.get('SELECT * FROM admins WHERE id = ? OR LOWER(username) = ? LIMIT 1', [actor.id || -1, actor.username.toLowerCase()], (err, admin) => {
    if (err || !admin) return res.json({ success: true });
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const { totalSec, dailySec, today } = computeOnlineAccrual(admin, nowMs);

    db.run(
      `UPDATE admins
       SET is_online = 0,
           online_since = NULL,
           last_heartbeat_at = ?,
           total_online_seconds = ?,
           daily_online_seconds = ?,
           daily_online_date = ?
       WHERE id = ?`,
      [nowIso, totalSec, dailySec, today, admin.id],
      () => {
        logAdminActivity(actor, 'ADMIN_LOGOUT', 'admin', admin.id, `@${admin.username}`, 'Signed out (Offline)');
        res.json({ success: true });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// B. Fast Dashboard Overview Metrics
// ---------------------------------------------------------------------------
router.get('/dashboard', adminAuth, (req, res) => {
  const stats = {};

  db.get('SELECT COUNT(*) as users, COALESCE(SUM(balance), 0) as coins, SUM(CASE WHEN referred_by_id IS NOT NULL THEN 1 ELSE 0 END) as referredUsers FROM users', (err, r1) => {
    stats.totalUsers = r1 ? r1.users : 0;
    stats.totalCoins = r1 ? r1.coins : 0;
    stats.totalReferredUsers = r1 ? (r1.referredUsers || 0) : 0;

    db.get("SELECT COUNT(*) as p FROM withdrawals WHERE status = 'PENDING'", (wErr, r2) => {
      stats.pendingWithdrawals = r2 ? r2.p : 0;

      db.get("SELECT COUNT(*) as t FROM task_submissions WHERE status = 'pending'", (tErr, r3) => {
        stats.pendingTasks = r3 ? r3.t : 0;

        db.get("SELECT COUNT(*) as activeTasks FROM tasks WHERE is_active = 1", (aErr, r4) => {
          stats.activeTasks = r4 ? r4.activeTasks : 0;
          res.json(stats);
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// C. Users Registry (Server-Side Paginated + Activity & FCM Status)
// ---------------------------------------------------------------------------
router.get('/users', adminAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim().toLowerCase();
  const statusFilter = (req.query.status || 'all').trim().toLowerCase();
  const activityFilter = (req.query.activity || 'all').trim().toLowerCase();
  const sortMode = (req.query.sort || 'newest').trim().toLowerCase();

  const whereParts = [];
  const params = [];

  if (statusFilter === 'active') {
    whereParts.push('u.is_banned = 0');
  } else if (statusFilter === 'banned') {
    whereParts.push('u.is_banned = 1');
  }

  if (activityFilter === 'online_now') {
    whereParts.push(`datetime(COALESCE(u.last_active_at, u.created_at)) >= datetime('now', '-5 minutes')`);
  } else if (activityFilter === 'active_24h') {
    whereParts.push(`datetime(COALESCE(u.last_active_at, u.created_at)) >= datetime('now', '-1 day')`);
  } else if (activityFilter === 'inactive_3d') {
    whereParts.push(`datetime(COALESCE(u.last_active_at, u.created_at)) <= datetime('now', '-3 days')`);
  } else if (activityFilter === 'inactive_7d') {
    whereParts.push(`datetime(COALESCE(u.last_active_at, u.created_at)) <= datetime('now', '-7 days')`);
  } else if (activityFilter === 'inactive_30d') {
    whereParts.push(`datetime(COALESCE(u.last_active_at, u.created_at)) <= datetime('now', '-30 days')`);
  } else if (activityFilter === 'fcm_ready') {
    whereParts.push(`u.fcm_token IS NOT NULL AND TRIM(u.fcm_token) != ''`);
  }

  if (search) {
    const like = `%${search}%`;
    if (/^\d+$/.test(search)) {
      whereParts.push('(u.id = ? OR LOWER(u.username) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.referral_code) LIKE ?)');
      params.push(parseInt(search, 10), like, like, like);
    } else {
      whereParts.push('(LOWER(u.username) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.full_name) LIKE ? OR LOWER(u.referral_code) LIKE ?)');
      params.push(like, like, like, like);
    }
  }

  let orderBySql = 'u.id DESC';
  if (sortMode === 'most_inactive') {
    orderBySql = 'datetime(COALESCE(u.last_active_at, u.created_at)) ASC, u.id DESC';
  } else if (sortMode === 'recently_active') {
    orderBySql = 'datetime(COALESCE(u.last_active_at, u.created_at)) DESC, u.id DESC';
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  db.get(`SELECT COUNT(*) as total FROM users u ${whereSql}`, params, (cErr, cRow) => {
    if (cErr) return res.status(500).json({ error: 'Failed to count users' });
    const total = cRow ? cRow.total : 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const dataSql = `
      SELECT
        u.id,
        u.full_name,
        u.username,
        u.email,
        u.referral_code,
        u.referred_by_id,
        ref.username as referred_by_username,
        (SELECT COUNT(*) FROM users r WHERE r.referred_by_id = u.id) as referral_count,
        u.balance,
        COALESCE(u.current_streak, 0) as current_streak,
        u.is_banned,
        u.ban_reason,
        COALESCE(u.last_active_at, u.created_at) as last_active_at,
        CASE WHEN u.fcm_token IS NOT NULL AND TRIM(u.fcm_token) != '' THEN 1 ELSE 0 END as has_fcm,
        u.created_at
      FROM users u
      LEFT JOIN users ref ON u.referred_by_id = ref.id
      ${whereSql}
      ORDER BY ${orderBySql}
      LIMIT ? OFFSET ?
    `;

    db.all(dataSql, [...params, limit, offset], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to retrieve users' });
      res.json({
        users: rows || [],
        total,
        page,
        limit,
        totalPages
      });
    });
  });
});

// ---------------------------------------------------------------------------
// C2. Referrals Section (Referrer List, View Referred Users, Delete & Clawback)
// ---------------------------------------------------------------------------
router.get('/referrals', adminAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim().toLowerCase();

  const whereParts = [];
  const params = [];

  if (search) {
    const like = `%${search}%`;
    if (/^\d+$/.test(search)) {
      whereParts.push('(r.id = ? OR LOWER(r.username) LIKE ? OR LOWER(r.referral_code) LIKE ?)');
      params.push(parseInt(search, 10), like, like);
    } else {
      whereParts.push('(LOWER(r.username) LIKE ? OR LOWER(r.email) LIKE ? OR LOWER(r.full_name) LIKE ? OR LOWER(r.referral_code) LIKE ?)');
      params.push(like, like, like, like);
    }
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  db.get(
    `SELECT COUNT(*) as totalReferrers, COALESCE(SUM(sub.cnt), 0) as totalReferredUsers
     FROM (
       SELECT r.id, COUNT(u.id) as cnt
       FROM users r
       INNER JOIN users u ON u.referred_by_id = r.id
       ${whereSql}
       GROUP BY r.id
     ) sub`,
    params,
    (cErr, cRow) => {
      if (cErr) return res.status(500).json({ error: 'Failed to retrieve referral stats' });

      const total = cRow ? cRow.totalReferrers : 0;
      const totalReferredUsers = cRow ? cRow.totalReferredUsers : 0;
      const totalPages = Math.max(1, Math.ceil(total / limit));

      const sql = `
        SELECT
          r.id,
          r.username,
          r.full_name,
          r.email,
          r.referral_code,
          r.balance,
          r.is_banned,
          COUNT(u.id) as referral_count,
          SUM(CASE WHEN u.is_banned = 0 THEN 1 ELSE 0 END) as active_referrals,
          MAX(u.created_at) as last_referral_at,
          (
            SELECT COALESCE(SUM(t.amount), 0)
            FROM transactions t
            WHERE t.user_id = r.id
              AND (UPPER(t.type) LIKE '%REFERRAL%' OR UPPER(t.type) LIKE '%COMMISSION%')
          ) as referral_tx_coins
        FROM users r
        INNER JOIN users u ON u.referred_by_id = r.id
        ${whereSql}
        GROUP BY r.id
        ORDER BY referral_count DESC, r.id DESC
        LIMIT ? OFFSET ?
      `;

      db.all(sql, [...params, limit, offset], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to retrieve referrers' });
        res.json({
          referrers: rows || [],
          total,
          totalReferredUsers,
          page,
          limit,
          totalPages
        });
      });
    }
  );
});

router.get('/referrals/:referrerId/users', adminAuth, (req, res) => {
  const referrerId = parseInt(req.params.referrerId, 10);
  if (!referrerId) return res.status(400).json({ error: 'Invalid referrer ID' });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim().toLowerCase();

  db.get(
    'SELECT id, username, full_name, email, referral_code, balance, is_banned FROM users WHERE id = ?',
    [referrerId],
    (rErr, referrer) => {
      if (rErr || !referrer) return res.status(404).json({ error: 'Referrer not found' });

      const whereParts = ['referred_by_id = ?'];
      const params = [referrerId];

      if (search) {
        const like = `%${search}%`;
        whereParts.push('(LOWER(username) LIKE ? OR LOWER(email) LIKE ? OR LOWER(full_name) LIKE ?)');
        params.push(like, like, like);
      }

      const whereSql = `WHERE ${whereParts.join(' AND ')}`;

      db.get(`SELECT COUNT(*) as total FROM users ${whereSql}`, params, (cErr, cRow) => {
        if (cErr) return res.status(500).json({ error: 'Database read error' });
        const total = cRow ? cRow.total : 0;
        const totalPages = Math.max(1, Math.ceil(total / limit));

        db.all(
          `SELECT id, full_name, username, email, balance, COALESCE(current_streak, 0) as current_streak, is_banned, ban_reason, created_at
           FROM users
           ${whereSql}
           ORDER BY id DESC
           LIMIT ? OFFSET ?`,
          [...params, limit, offset],
          (err, rows) => {
            if (err) return res.status(500).json({ error: 'Failed to retrieve referred users' });
            res.json({
              referrer,
              users: rows || [],
              total,
              page,
              limit,
              totalPages
            });
          }
        );
      });
    }
  );
});

// Delete ALL referred users of a referrer + remove all referral commission & 100-coin/referral bonus
router.post('/referrals/:referrerId/delete-all', adminAuth, (req, res) => {
  const referrerId = parseInt(req.params.referrerId, 10);
  if (!referrerId) return res.status(400).json({ error: 'Invalid referrer ID' });

  db.get('SELECT id, username, balance FROM users WHERE id = ?', [referrerId], (rErr, referrer) => {
    if (rErr || !referrer) return res.status(404).json({ error: 'Referrer not found' });

    db.all('SELECT id, username FROM users WHERE referred_by_id = ?', [referrerId], (uErr, referredUsers) => {
      if (uErr) return res.status(500).json({ error: 'Failed to fetch referred users' });

      const deletedCount = (referredUsers || []).length;
      if (deletedCount === 0) {
        return res.status(400).json({ error: 'This user has no referred users to delete' });
      }

      const referredIds = referredUsers.map(u => u.id);
      const placeholders = referredIds.map(() => '?').join(',');

      // Collect screenshots of referred users before deletion
      db.all(
        `SELECT screenshot_path FROM task_submissions WHERE user_id IN (${placeholders}) AND screenshot_path IS NOT NULL`,
        referredIds,
        (sErr, shotRows) => {
          // Fetch all referral/commission transactions for the referrer
          db.all(
            `SELECT id, type, amount FROM transactions
             WHERE user_id = ?
               AND (UPPER(type) LIKE '%REFERRAL%' OR UPPER(type) LIKE '%COMMISSION%')`,
            [referrerId],
            (tErr, txRows) => {
              if (tErr) return res.status(500).json({ error: 'Failed to read referral transactions' });

              let bonusTxCoins = 0;
              let commissionCoins = 0;
              (txRows || []).forEach(tx => {
                const amt = Math.max(0, Number(tx.amount || 0));
                if (isSignupBonusTx(tx)) {
                  bonusTxCoins += amt;
                } else {
                  commissionCoins += amt;
                }
              });

              const perReferralBonus = deletedCount * REFERRAL_SIGNUP_BONUS_COINS;
              const bonusRemoved = Math.max(perReferralBonus, bonusTxCoins);
              const totalClawback = commissionCoins + bonusRemoved;

              db.serialize(() => {
                db.run('BEGIN TRANSACTION');

                db.run(
                  `DELETE FROM users WHERE referred_by_id = ?`,
                  [referrerId],
                  function (delErr) {
                    if (delErr) {
                      db.run('ROLLBACK');
                      return res.status(500).json({ error: 'Failed to delete referred users' });
                    }

                    db.run(
                      `DELETE FROM transactions
                       WHERE user_id = ?
                         AND (UPPER(type) LIKE '%REFERRAL%' OR UPPER(type) LIKE '%COMMISSION%')`,
                      [referrerId],
                      (txDelErr) => {
                        if (txDelErr) {
                          db.run('ROLLBACK');
                          return res.status(500).json({ error: 'Failed to remove referral transactions' });
                        }

                        db.run(
                          `UPDATE users
                           SET balance = MAX(0, balance - ?),
                               total_coins_earned = MAX(0, COALESCE(total_coins_earned, 0) - ?),
                               weekly_coins = MAX(0, COALESCE(weekly_coins, 0) - ?)
                           WHERE id = ?`,
                          [totalClawback, totalClawback, totalClawback, referrerId],
                          (balErr) => {
                            if (balErr) {
                              db.run('ROLLBACK');
                              return res.status(500).json({ error: 'Failed to deduct referral coins from referrer' });
                            }

                            db.run('COMMIT', (cErr) => {
                              if (cErr) {
                                db.run('ROLLBACK');
                                return res.status(500).json({ error: 'Transaction commit failed' });
                              }

                              if (Array.isArray(shotRows)) {
                                shotRows.forEach(r => deleteScreenshotFile(r.screenshot_path));
                              }

                              logAdminActivity(
                                req,
                                'REFERRALS_PURGED',
                                'referrer',
                                referrerId,
                                `@${referrer.username}`,
                                `Deleted ${deletedCount} referred users; removed ${commissionCoins} commission + ${bonusRemoved} bonus = ${totalClawback} coins from @${referrer.username}`
                              );

                              res.json({
                                success: true,
                                deletedCount,
                                commissionRemoved: commissionCoins,
                                bonusRemoved,
                                totalClawback
                              });
                            });
                          }
                        );
                      }
                    );
                  }
                );
              });
            }
          );
        }
      );
    });
  });
});

// Delete a SINGLE referred user from View Referred Users + clawback 100 bonus & linked commissions from referrer
router.post('/referrals/user/:userId/delete', adminAuth, (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID' });

  db.get('SELECT id, username, email, referred_by_id FROM users WHERE id = ?', [userId], (uErr, targetUser) => {
    if (uErr || !targetUser) return res.status(404).json({ error: 'Referred user not found' });

    const referrerId = targetUser.referred_by_id;

    db.all('SELECT id, screenshot_path FROM task_submissions WHERE user_id = ?', [userId], (sErr, subRows) => {
      const subRefs = (subRows || []).map(r => `TASK_SUB_${r.id}`);
      const shotPaths = (subRows || []).map(r => r.screenshot_path).filter(Boolean);

      if (!referrerId) {
        return db.run('DELETE FROM users WHERE id = ?', [userId], (delErr) => {
          if (delErr) return res.status(500).json({ error: 'Failed to delete user' });
          shotPaths.forEach(deleteScreenshotFile);
          logAdminActivity(req, 'REFERRAL_USER_DELETED', 'user', userId, `@${targetUser.username}`, 'Deleted user (no referrer)');
          res.json({ success: true, deletedUsername: targetUser.username, commissionRemoved: 0, bonusRemoved: 0, totalClawback: 0 });
        });
      }

      db.get('SELECT id, username FROM users WHERE id = ?', [referrerId], (rErr, referrer) => {
        db.all(
          `SELECT id, type, amount, reference_id FROM transactions
           WHERE user_id = ?
             AND (UPPER(type) LIKE '%REFERRAL%' OR UPPER(type) LIKE '%COMMISSION%')`,
          [referrerId],
          (tErr, txRows) => {
            if (tErr) return res.status(500).json({ error: 'Failed to inspect referral transactions' });

            const matchedCommissionTxIds = [];
            let commissionRemoved = 0;
            let singleBonusTxId = null;

            const unameLower = String(targetUser.username || '').toLowerCase();
            (txRows || []).forEach(tx => {
              const ref = String(tx.reference_id || '');
              const refLower = ref.toLowerCase();
              const isLinkedToUser =
                subRefs.includes(ref) ||
                ref === String(userId) ||
                refLower.includes(`user_${userId}`) ||
                refLower.includes(`ref_${userId}`) ||
                (unameLower && refLower.includes(unameLower));

              if (isSignupBonusTx(tx)) {
                if (!singleBonusTxId && (isLinkedToUser || !ref)) {
                  singleBonusTxId = tx.id;
                }
              } else if (isLinkedToUser) {
                matchedCommissionTxIds.push(tx.id);
                commissionRemoved += Math.max(0, Number(tx.amount || 0));
              }
            });

            const txIdsToDelete = [...matchedCommissionTxIds];
            if (singleBonusTxId) txIdsToDelete.push(singleBonusTxId);

            const bonusRemoved = REFERRAL_SIGNUP_BONUS_COINS;
            const totalClawback = bonusRemoved + commissionRemoved;

            db.serialize(() => {
              db.run('BEGIN TRANSACTION');

              db.run('DELETE FROM users WHERE id = ?', [userId], (delErr) => {
                if (delErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to delete referred user' });
                }

                const finishDeduction = () => {
                  db.run(
                    `UPDATE users
                     SET balance = MAX(0, balance - ?),
                         total_coins_earned = MAX(0, COALESCE(total_coins_earned, 0) - ?),
                         weekly_coins = MAX(0, COALESCE(weekly_coins, 0) - ?)
                     WHERE id = ?`,
                    [totalClawback, totalClawback, totalClawback, referrerId],
                    (balErr) => {
                      if (balErr) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: 'Failed to deduct coins from referrer' });
                      }

                      db.run('COMMIT', (cErr) => {
                        if (cErr) {
                          db.run('ROLLBACK');
                          return res.status(500).json({ error: 'Transaction commit failed' });
                        }

                        shotPaths.forEach(deleteScreenshotFile);
                        const refName = referrer ? `@${referrer.username}` : `Referrer #${referrerId}`;
                        logAdminActivity(
                          req,
                          'REFERRAL_USER_DELETED',
                          'user',
                          userId,
                          `@${targetUser.username}`,
                          `Deleted referred user @${targetUser.username}; deducted ${bonusRemoved} bonus + ${commissionRemoved} commission = ${totalClawback} coins from ${refName}`
                        );

                        res.json({
                          success: true,
                          deletedUsername: targetUser.username,
                          commissionRemoved,
                          bonusRemoved,
                          totalClawback
                        });
                      });
                    }
                  );
                };

                if (txIdsToDelete.length > 0) {
                  const txPh = txIdsToDelete.map(() => '?').join(',');
                  db.run(`DELETE FROM transactions WHERE id IN (${txPh})`, txIdsToDelete, (txDelErr) => {
                    if (txDelErr) {
                      db.run('ROLLBACK');
                      return res.status(500).json({ error: 'Failed to remove referral transactions' });
                    }
                    finishDeduction();
                  });
                } else {
                  finishDeduction();
                }
              });
            });
          }
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// D. Admin Accounts Management & Online Time (Master Admin Only)
// ---------------------------------------------------------------------------
router.get('/admins', adminAuth, requireMasterAdmin, (req, res) => {
  expireStaleAdminSessions(() => {
    const today = getUtcToday();
    db.all(
      `SELECT
        a.id,
        a.username,
        a.full_name,
        a.is_online,
        a.online_since,
        a.last_heartbeat_at,
        a.last_login_at,
        COALESCE(a.total_online_seconds, 0) as total_online_seconds,
        CASE WHEN a.daily_online_date = ? THEN COALESCE(a.daily_online_seconds, 0) ELSE 0 END as daily_online_seconds,
        a.created_at,
        (SELECT COUNT(*) FROM admin_activity_logs l WHERE l.admin_id = a.id OR LOWER(l.admin_username) = LOWER(a.username)) as action_count
       FROM admins a
       ORDER BY a.id ASC`,
      [today],
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch admin accounts' });
        const nowMs = Date.now();
        const formatted = (rows || []).map(a => {
          let liveExtra = 0;
          if (a.is_online === 1 && a.last_heartbeat_at) {
            const hbMs = Date.parse(a.last_heartbeat_at);
            if (!Number.isNaN(hbMs) && nowMs > hbMs) {
              liveExtra = Math.min(Math.floor((nowMs - hbMs) / 1000), MAX_HEARTBEAT_DELTA_SEC);
            }
          }
          return {
            ...a,
            is_master: isMasterUsername(a.username),
            total_online_seconds: Number(a.total_online_seconds || 0) + liveExtra,
            daily_online_seconds: Number(a.daily_online_seconds || 0) + liveExtra
          };
        });
        res.json(formatted);
      }
    );
  });
});

// Master Admin toggling an admin's Online/Offline state
router.post('/admins/:id/status', adminAuth, requireMasterAdmin, (req, res) => {
  const targetId = req.params.id;
  const wantOnline = req.body.is_online === true || req.body.is_online === 1 || req.body.is_online === 'true';

  db.get('SELECT * FROM admins WHERE id = ?', [targetId], (err, target) => {
    if (err || !target) return res.status(404).json({ error: 'Admin not found' });

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const { totalSec, dailySec, today } = computeOnlineAccrual(target, nowMs);

    const newOnline = wantOnline ? 1 : 0;
    const newSince = wantOnline ? (target.online_since || nowIso) : null;

    db.run(
      `UPDATE admins
       SET is_online = ?,
           online_since = ?,
           last_heartbeat_at = ?,
           total_online_seconds = ?,
           daily_online_seconds = ?,
           daily_online_date = ?
       WHERE id = ?`,
      [newOnline, newSince, nowIso, totalSec, dailySec, today, target.id],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: 'Failed to update admin status' });
        logAdminActivity(
          req,
          wantOnline ? 'STATUS_ONLINE' : 'STATUS_OFFLINE',
          'admin',
          target.id,
          `@${target.username}`,
          `Master admin set @${target.username} ${wantOnline ? 'Online' : 'Offline'}`
        );
        res.json({ success: true, is_online: wantOnline });
      }
    );
  });
});

router.post('/admins/create', adminAuth, requireMasterAdmin, (req, res) => {
  const { username, full_name, password } = req.body;

  if (!username || !password || password.trim().length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 characters) are required' });
  }

  const cleanUser = username.trim().toLowerCase();
  const cleanName = full_name ? full_name.trim() : 'Admin Staff';

  bcrypt.hash(password.trim(), 10, (bErr, hash) => {
    if (bErr) return res.status(500).json({ error: 'Encryption failure' });

    db.run(
      'INSERT INTO admins (username, full_name, password_hash) VALUES (?, ?, ?)',
      [cleanUser, cleanName, hash],
      function (err) {
        if (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: `Username @${cleanUser} already exists.` });
          }
          return res.status(500).json({ error: 'Database error creating admin' });
        }
        logAdminActivity(req, 'ADMIN_CREATED', 'admin', this.lastID, `@${cleanUser}`, `Created admin account (${cleanName})`);
        res.json({ success: true, message: `Admin @${cleanUser} created successfully!` });
      }
    );
  });
});

router.post('/admins/password', adminAuth, requireMasterAdmin, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password || password.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  const cleanUser = username.trim().toLowerCase();

  bcrypt.hash(password.trim(), 10, (bErr, hash) => {
    if (bErr) return res.status(500).json({ error: 'Encryption failure' });

    db.run(
      'UPDATE admins SET password_hash = ? WHERE LOWER(username) = ?',
      [hash, cleanUser],
      function (err) {
        if (err) return res.status(500).json({ error: 'Failed to update password' });
        logAdminActivity(req, 'ADMIN_PASSWORD_CHANGED', 'admin', '', `@${cleanUser}`, `Changed password for admin @${cleanUser}`);
        res.json({ success: true, message: `Password updated for @${cleanUser}` });
      }
    );
  });
});

router.post('/admins/delete', adminAuth, requireMasterAdmin, (req, res) => {
  const { username } = req.body;

  if (!username) return res.status(400).json({ error: 'Username is required' });
  const cleanUser = username.trim().toLowerCase();
  if (cleanUser === 'admin') {
    return res.status(403).json({ error: 'Root admin account cannot be deleted' });
  }

  db.run('DELETE FROM admins WHERE LOWER(username) = ?', [cleanUser], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to delete admin' });
    logAdminActivity(req, 'ADMIN_DELETED', 'admin', '', `@${cleanUser}`, `Deleted admin account @${cleanUser}`);
    res.json({ success: true, message: `Admin @${cleanUser} removed` });
  });
});

// ---------------------------------------------------------------------------
// D2. Admin Activity Logs (Master Admin Only, Fast Server-Side Pagination)
// ---------------------------------------------------------------------------
router.get('/activity-logs', adminAuth, requireMasterAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const adminUsername = (req.query.admin_username || '').trim().toLowerCase();
  const actionType = (req.query.action_type || '').trim().toUpperCase();
  const search = (req.query.search || '').trim().toLowerCase();

  const whereParts = [];
  const params = [];

  if (adminUsername && adminUsername !== 'all') {
    whereParts.push('LOWER(admin_username) = ?');
    params.push(adminUsername);
  }

  if (actionType && actionType !== 'ALL') {
    whereParts.push('action_type = ?');
    params.push(actionType);
  }

  if (search) {
    const like = `%${search}%`;
    whereParts.push('(LOWER(admin_username) LIKE ? OR LOWER(target_label) LIKE ? OR LOWER(details) LIKE ? OR LOWER(action_type) LIKE ?)');
    params.push(like, like, like, like);
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  db.get(`SELECT COUNT(*) as total FROM admin_activity_logs ${whereSql}`, params, (cErr, cRow) => {
    if (cErr) return res.status(500).json({ error: 'Failed to count activity logs' });
    const total = cRow ? cRow.total : 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    db.all(
      `SELECT id, admin_id, admin_username, action_type, target_type, target_id, target_label, details, created_at
       FROM admin_activity_logs
       ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch activity logs' });

        db.all('SELECT username FROM admins ORDER BY id ASC', (aErr, admins) => {
          res.json({
            logs: rows || [],
            total,
            page,
            limit,
            totalPages,
            adminsList: (admins || []).map(a => a.username)
          });
        });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// E. Quick User Management Operations (Preserved + Logged)
// ---------------------------------------------------------------------------
router.post('/users/:id/password', adminAuth, (req, res) => {
  const { password } = req.body;
  const userId = req.params.id;
  if (!password || password.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  db.get('SELECT username FROM users WHERE id = ?', [userId], (uErr, user) => {
    bcrypt.hash(password.trim(), 10, (bErr, hash) => {
      if (bErr) return res.status(500).json({ error: 'Encryption failure' });
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to reset password' });
        const label = user ? `@${user.username}` : `User #${userId}`;
        logAdminActivity(req, 'USER_PASSWORD_CHANGED', 'user', userId, label, 'Reset player password');
        res.json({ success: true });
      });
    });
  });
});

router.post('/users/:id/coins', adminAuth, (req, res) => {
  const { amount } = req.body;
  const userId = req.params.id;

  if (amount === undefined || isNaN(amount)) {
    return res.status(400).json({ error: 'Valid coin amount is required' });
  }

  const coinAmount = parseInt(amount, 10);

  db.get('SELECT username, balance FROM users WHERE id = ?', [userId], (uErr, user) => {
    db.run(
      'UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?',
      [coinAmount, userId],
      function (err) {
        if (err) return res.status(500).json({ error: 'Failed to adjust coins' });
        const label = user ? `@${user.username}` : `User #${userId}`;
        const sign = coinAmount >= 0 ? `+${coinAmount}` : `${coinAmount}`;
        logAdminActivity(
          req,
          'USER_COINS_CHANGED',
          'user',
          userId,
          label,
          `Adjusted balance by ${sign} coins (previous: ${user ? user.balance : '?'})`
        );
        res.json({ success: true });
      }
    );
  });
});

router.post('/users/:id/ban', adminAuth, (req, res) => {
  const { isBanned, reason } = req.body;
  const userId = req.params.id;
  if (isBanned && (!reason || !String(reason).trim())) {
    return res.status(400).json({ error: 'Ban reason is required' });
  }
  const banReason = isBanned ? String(reason).trim() : null;

  db.get('SELECT username FROM users WHERE id = ?', [userId], (uErr, user) => {
    db.run(
      'UPDATE users SET is_banned = ?, ban_reason = ? WHERE id = ?',
      [isBanned ? 1 : 0, banReason, userId],
      (err) => {
        if (err) return res.status(500).json({ error: 'Failed to alter ban state' });
        const label = user ? `@${user.username}` : `User #${userId}`;
        logAdminActivity(
          req,
          isBanned ? 'USER_BANNED' : 'USER_UNBANNED',
          'user',
          userId,
          label,
          isBanned ? `Reason: ${banReason}` : 'Account unbanned'
        );
        res.json({ success: true });
      }
    );
  });
});

router.post('/users/:id/delete', adminAuth, (req, res) => {
  const userId = req.params.id;

  db.get('SELECT username, email FROM users WHERE id = ?', [userId], (uErr, user) => {
    db.all('SELECT screenshot_path FROM task_submissions WHERE user_id = ?', [userId], (err, rows) => {
      if (!err && rows) {
        rows.forEach(r => deleteScreenshotFile(r.screenshot_path));
      }

      db.run('DELETE FROM users WHERE id = ?', [userId], function (delErr) {
        if (delErr) return res.status(500).json({ error: 'Database error deleting user' });
        const label = user ? `@${user.username}` : `User #${userId}`;
        logAdminActivity(
          req,
          'USER_DELETED',
          'user',
          userId,
          label,
          `Permanently deleted user${user && user.email ? ` (${user.email})` : ''}`
        );
        res.json({ success: true, message: `User #${userId} deleted.` });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// F. Payment Gateways Configuration
// ---------------------------------------------------------------------------
router.get('/payment-methods', adminAuth, (req, res) => {
  db.get("SELECT value FROM app_config WHERE key = 'payment_methods'", (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    try {
      res.json(row && row.value ? JSON.parse(row.value) : DEFAULT_PAYMENT_METHODS);
    } catch {
      res.json(DEFAULT_PAYMENT_METHODS);
    }
  });
});

router.post('/payment-methods', adminAuth, (req, res) => {
  const { methods } = req.body;
  if (!methods || !Array.isArray(methods)) {
    return res.status(400).json({ error: 'Array of payment methods is required' });
  }

  db.run(
    "INSERT OR REPLACE INTO app_config (key, value) VALUES ('payment_methods', ?)",
    [JSON.stringify(methods)],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to save payment gateways' });
      logAdminActivity(req, 'GATEWAY_UPDATED', 'config', 'payment_methods', 'Payment Gateways', `Updated gateways (${methods.length} configured)`);
      res.json({ success: true, message: 'Payment methods updated!' });
    }
  );
});

// ---------------------------------------------------------------------------
// G. Withdrawals Pipeline (Supports Paginated & Backward-Compatible Mode)
// ---------------------------------------------------------------------------
router.get('/withdrawals', adminAuth, (req, res) => {
  const hasPagination = req.query.page !== undefined;
  const statusFilter = (req.query.status || '').trim().toUpperCase();

  if (!hasPagination) {
    return db.all(
      `SELECT 
        w.id,
        w.user_id,
        w.payment_method,
        w.account_info,
        w.coin_amount,
        w.npr_amount,
        w.status,
        w.created_at,
        u.username
       FROM withdrawals w 
       LEFT JOIN users u ON w.user_id = u.id 
       ORDER BY w.id DESC LIMIT 200`,
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database read failure' });
        res.json(rows || []);
      }
    );
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim().toLowerCase();

  const whereParts = [];
  const params = [];

  if (statusFilter && statusFilter !== 'ALL') {
    whereParts.push('w.status = ?');
    params.push(statusFilter);
  }

  if (search) {
    const like = `%${search}%`;
    whereParts.push('(LOWER(u.username) LIKE ? OR LOWER(w.account_info) LIKE ? OR LOWER(w.payment_method) LIKE ?)');
    params.push(like, like, like);
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  db.get(
    `SELECT COUNT(*) as total FROM withdrawals w LEFT JOIN users u ON w.user_id = u.id ${whereSql}`,
    params,
    (cErr, cRow) => {
      if (cErr) return res.status(500).json({ error: 'Database count failure' });
      const total = cRow ? cRow.total : 0;
      const totalPages = Math.max(1, Math.ceil(total / limit));

      db.all(
        `SELECT 
          w.id,
          w.user_id,
          w.payment_method,
          w.account_info,
          w.coin_amount,
          w.npr_amount,
          w.status,
          w.created_at,
          u.username
         FROM withdrawals w 
         LEFT JOIN users u ON w.user_id = u.id 
         ${whereSql}
         ORDER BY w.id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        (err, rows) => {
          if (err) return res.status(500).json({ error: 'Database read failure' });
          res.json({
            withdrawals: rows || [],
            total,
            page,
            limit,
            totalPages
          });
        }
      );
    }
  );
});

router.post('/withdrawals/:id/status', adminAuth, (req, res) => {
  const { status } = req.body;
  const withdrawalId = req.params.id;

  if (!['APPROVED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.get(
    `SELECT w.*, u.username FROM withdrawals w LEFT JOIN users u ON w.user_id = u.id WHERE w.id = ?`,
    [withdrawalId],
    (err, record) => {
      if (err || !record) return res.status(404).json({ error: 'Withdrawal not found' });
      if (record.status !== 'PENDING') return res.status(400).json({ error: 'Already resolved' });

      const nowIso = new Date().toISOString();
      const targetUser = record.username ? `@${record.username}` : `User #${record.user_id}`;

      if (status === 'APPROVED') {
        db.run(
          'UPDATE users SET balance = balance - ?, last_withdrawal_at = ? WHERE id = ?',
          [record.coin_amount, nowIso, record.user_id],
          (uErr) => {
            if (uErr) return res.status(500).json({ error: 'Failed to deduct balance' });

            db.run(
              'UPDATE withdrawals SET status = ?, processed_at = ? WHERE id = ?',
              ['APPROVED', nowIso, withdrawalId],
              () => {
                logAdminActivity(
                  req,
                  'WITHDRAWAL_APPROVED',
                  'withdrawal',
                  withdrawalId,
                  targetUser,
                  `Approved ${record.coin_amount} coins via ${record.payment_method} (${record.account_info})`
                );
                res.json({ success: true });
              }
            );
          }
        );
      } else {
        db.run(
          'UPDATE withdrawals SET status = ?, processed_at = ? WHERE id = ?',
          ['REJECTED', nowIso, withdrawalId],
          () => {
            logAdminActivity(
              req,
              'WITHDRAWAL_REJECTED',
              'withdrawal',
              withdrawalId,
              targetUser,
              `Rejected ${record.coin_amount} coins via ${record.payment_method}`
            );
            res.json({ success: true });
          }
        );
      }
    }
  );
});

// ---------------------------------------------------------------------------
// H. App Config & Update Settings
// ---------------------------------------------------------------------------
router.get('/config', adminAuth, (req, res) => {
  db.all('SELECT * FROM app_config', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const configObj = {};
    rows.forEach(r => configObj[r.key] = r.value);
    res.json(configObj);
  });
});

router.post('/config/update', adminAuth, (req, res) => {
  const settings = req.body;
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)');
    for (const [key, val] of Object.entries(settings)) {
      stmt.run(key, val !== undefined && val !== null ? val.toString() : '');
    }
    stmt.finalize();
    db.run('COMMIT', (err) => {
      if (err) return res.status(500).json({ error: 'Update failed' });
      logAdminActivity(
        req,
        'CONFIG_UPDATED',
        'config',
        'app_config',
        'Version Control',
        `min_version=${settings.min_version || ''}, force_update=${settings.force_update || ''}`
      );
      res.json({ success: true });
    });
  });
});

// ---------------------------------------------------------------------------
// I. Tasks Management
// ---------------------------------------------------------------------------
router.get('/tasks', adminAuth, (req, res) => {
  db.all('SELECT * FROM tasks ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to retrieve tasks' });
    res.json(rows || []);
  });
});

router.post('/tasks/create', adminAuth, (req, res) => {
  const { title, reward_coins, instructions, proof_type, action_url } = req.body;

  if (!title || !reward_coins) {
    return res.status(400).json({ error: 'Title and reward coins are required' });
  }

  const coins = parseInt(reward_coins, 10);

  db.run(
    `INSERT INTO tasks (title, reward_coins, instructions, proof_type, action_url, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [title.trim(), coins, (instructions || '').trim(), proof_type || 'both', (action_url || '').trim()],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to create task' });
      logAdminActivity(req, 'TASK_CREATED', 'task', this.lastID, title.trim(), `Reward: ${coins} coins`);
      res.json({ success: true, taskId: this.lastID });
    }
  );
});

router.post('/tasks/:id/update', adminAuth, (req, res) => {
  const { is_active } = req.body;
  const taskId = req.params.id;
  db.get('SELECT title FROM tasks WHERE id = ?', [taskId], (tErr, task) => {
    db.run('UPDATE tasks SET is_active = ? WHERE id = ?', [is_active, taskId], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update task' });
      logAdminActivity(
        req,
        'TASK_UPDATED',
        'task',
        taskId,
        task ? task.title : `Task #${taskId}`,
        `Set status to ${Number(is_active) === 1 ? 'Active' : 'Disabled'}`
      );
      res.json({ success: true });
    });
  });
});

router.post('/tasks/:id/delete', adminAuth, (req, res) => {
  const taskId = req.params.id;
  db.get('SELECT title FROM tasks WHERE id = ?', [taskId], (tErr, task) => {
    db.run('DELETE FROM tasks WHERE id = ?', [taskId], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to delete task' });
      logAdminActivity(req, 'TASK_DELETED', 'task', taskId, task ? task.title : `Task #${taskId}`, 'Deleted task');
      res.json({ success: true });
    });
  });
});

// ---------------------------------------------------------------------------
// J. Task Submissions & Approval / Rejection (Supports Paginated Mode)
// ---------------------------------------------------------------------------
router.get('/task-submissions', adminAuth, (req, res) => {
  const { status } = req.query;
  const hasPagination = req.query.page !== undefined;

  if (!hasPagination) {
    let sql = `
      SELECT 
        ts.id,
        ts.task_id,
        ts.user_id,
        ts.proof_text,
        ts.screenshot_path,
        ts.status,
        t.title as task_title,
        t.reward_coins,
        u.username
      FROM task_submissions ts
      JOIN tasks t ON ts.task_id = t.id
      JOIN users u ON ts.user_id = u.id
    `;
    const params = [];

    if (status) {
      sql += ` WHERE ts.status = ?`;
      params.push(status.toLowerCase());
    }

    sql += ` ORDER BY ts.id DESC LIMIT 150`;

    return db.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to retrieve task submissions' });

      const formatted = (rows || []).map(r => {
        if (r.screenshot_path) {
          r.screenshot_path = `/uploads/task_proofs/${path.basename(r.screenshot_path)}`;
        }
        return r;
      });

      res.json(formatted);
    });
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim().toLowerCase();

  const whereParts = [];
  const params = [];

  if (status && status.toLowerCase() !== 'all') {
    whereParts.push('ts.status = ?');
    params.push(status.toLowerCase());
  }

  if (search) {
    const like = `%${search}%`;
    whereParts.push('(LOWER(u.username) LIKE ? OR LOWER(t.title) LIKE ? OR LOWER(ts.proof_text) LIKE ?)');
    params.push(like, like, like);
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  db.get(
    `SELECT COUNT(*) as total
     FROM task_submissions ts
     JOIN tasks t ON ts.task_id = t.id
     JOIN users u ON ts.user_id = u.id
     ${whereSql}`,
    params,
    (cErr, cRow) => {
      if (cErr) return res.status(500).json({ error: 'Failed to count submissions' });
      const total = cRow ? cRow.total : 0;
      const totalPages = Math.max(1, Math.ceil(total / limit));

      db.all(
        `SELECT 
          ts.id,
          ts.task_id,
          ts.user_id,
          ts.proof_text,
          ts.screenshot_path,
          ts.status,
          ts.rejection_reason,
          t.title as task_title,
          t.reward_coins,
          u.username
        FROM task_submissions ts
        JOIN tasks t ON ts.task_id = t.id
        JOIN users u ON ts.user_id = u.id
        ${whereSql}
        ORDER BY ts.id DESC
        LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        (err, rows) => {
          if (err) return res.status(500).json({ error: 'Failed to retrieve task submissions' });

          const formatted = (rows || []).map(r => {
            if (r.screenshot_path) {
              r.screenshot_path = `/uploads/task_proofs/${path.basename(r.screenshot_path)}`;
            }
            return r;
          });

          res.json({
            submissions: formatted,
            total,
            page,
            limit,
            totalPages
          });
        }
      );
    }
  );
});

router.post('/task-submissions/:id/approve', adminAuth, (req, res) => {
  const subId = req.params.id;

  db.get(
    `SELECT ts.*, t.reward_coins, t.title as task_title, u.username
     FROM task_submissions ts
     JOIN tasks t ON ts.task_id = t.id
     JOIN users u ON ts.user_id = u.id
     WHERE ts.id = ?`,
    [subId],
    (err, sub) => {
      if (err || !sub) return res.status(404).json({ error: 'Submission not found' });
      if (sub.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });

      const nowIso = new Date().toISOString();

      db.run(
        `UPDATE task_submissions SET status = 'approved', screenshot_path = NULL, reviewed_at = ? WHERE id = ?`,
        [nowIso, subId],
        (uErr) => {
          if (uErr) return res.status(500).json({ error: 'Failed to approve' });

          db.run(
            `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
            [sub.reward_coins, sub.reward_coins, sub.user_id],
            () => {
              deleteScreenshotFile(sub.screenshot_path);
              creditReferralCommission(sub.user_id, sub.reward_coins, 'TASK', `TASK_SUB_${subId}`, 0.10);
              logAdminActivity(
                req,
                'TASK_APPROVED',
                'submission',
                subId,
                `@${sub.username}`,
                `Approved "${sub.task_title}" (+${sub.reward_coins} coins)`
              );
              res.json({ success: true });
            }
          );
        }
      );
    }
  );
});

router.post('/task-submissions/:id/reject', adminAuth, (req, res) => {
  const subId = req.params.id;
  const { reason } = req.body;

  db.get(
    `SELECT ts.*, t.title as task_title, u.username
     FROM task_submissions ts
     JOIN tasks t ON ts.task_id = t.id
     JOIN users u ON ts.user_id = u.id
     WHERE ts.id = ?`,
    [subId],
    (err, sub) => {
      if (err || !sub) return res.status(404).json({ error: 'Submission not found' });
      if (sub.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });

      const cleanReason = reason ? reason.trim() : 'Rejected';
      const nowIso = new Date().toISOString();

      db.run(
        `UPDATE task_submissions SET status = 'rejected', rejection_reason = ?, screenshot_path = NULL, reviewed_at = ? WHERE id = ?`,
        [cleanReason, nowIso, subId],
        (uErr) => {
          if (uErr) return res.status(500).json({ error: 'Failed to reject' });
          deleteScreenshotFile(sub.screenshot_path);
          logAdminActivity(
            req,
            'TASK_REJECTED',
            'submission',
            subId,
            `@${sub.username}`,
            `Rejected "${sub.task_title}" — Reason: ${cleanReason}`
          );
          res.json({ success: true });
        }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// K. Firebase Push Notifications (Stats, Send to Specific User, Send to All)
// ---------------------------------------------------------------------------
router.get('/notifications/stats', adminAuth, (req, res) => {
  db.get(
    `SELECT
       COUNT(*) as totalUsers,
       SUM(CASE WHEN fcm_token IS NOT NULL AND TRIM(fcm_token) != '' AND is_banned = 0 THEN 1 ELSE 0 END) as fcmUsers,
       SUM(CASE WHEN datetime(COALESCE(last_active_at, created_at)) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) as active24h,
       SUM(CASE WHEN datetime(COALESCE(last_active_at, created_at)) <= datetime('now', '-3 days') THEN 1 ELSE 0 END) as inactive3d,
       SUM(CASE WHEN datetime(COALESCE(last_active_at, created_at)) <= datetime('now', '-7 days') THEN 1 ELSE 0 END) as inactive7d
     FROM users`,
    (err, stats) => {
      if (err) return res.status(500).json({ error: 'Failed to read notification stats' });

      db.all(
        `SELECT * FROM push_notifications ORDER BY id DESC LIMIT 30`,
        (hErr, history) => {
          res.json({
            stats: stats || { totalUsers: 0, fcmUsers: 0, active24h: 0, inactive3d: 0, inactive7d: 0 },
            history: history || []
          });
        }
      );
    }
  );
});

// Send FCM notification to a specific user (by ID or @username)
router.post('/notifications/send-user', adminAuth, async (req, res) => {
  const { userId, usernameOrId, title, body, screen } = req.body;

  if (!title || !String(title).trim() || !body || !String(body).trim()) {
    return res.status(400).json({ error: 'Notification title and message body are required' });
  }

  const lookupInput = String(userId || usernameOrId || '').trim().replace(/^@/, '');
  if (!lookupInput) {
    return res.status(400).json({ error: 'Target User ID or Username is required' });
  }

  const isNumeric = /^\d+$/.test(lookupInput);
  const query = isNumeric
    ? 'SELECT id, username FROM users WHERE id = ? LIMIT 1'
    : 'SELECT id, username FROM users WHERE LOWER(username) = ? LIMIT 1';
  const param = isNumeric ? parseInt(lookupInput, 10) : lookupInput.toLowerCase();

  db.get(query, [param], async (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: `User "${lookupInput}" not found` });
    }

    const cleanTitle = String(title).trim();
    const cleanBody = String(body).trim();
    const cleanScreen = screen ? String(screen).trim() : '';
    const actor = extractAdmin(req);

    const result = await fcmService.sendToUser(user.id, {
      title: cleanTitle,
      body: cleanBody,
      data: cleanScreen ? { screen: cleanScreen } : {}
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to send notification' });
    }

    db.run(
      `INSERT INTO push_notifications
         (admin_username, target_type, target_user_id, target_label, title, body, screen, targeted_count, success_count, failure_count)
       VALUES (?, 'USER', ?, ?, ?, ?, ?, 1, 1, 0)`,
      [actor.username, user.id, `@${user.username} (#${user.id})`, cleanTitle, cleanBody, cleanScreen]
    );

    logAdminActivity(
      req,
      'NOTIFICATION_SENT_USER',
      'user',
      user.id,
      `@${user.username}`,
      `Sent FCM push: "${cleanTitle}"`
    );

    res.json({
      success: true,
      message: `Notification sent to @${user.username}!`,
      result
    });
  });
});

// Send FCM notification to all users (or filtered by activity)
router.post('/notifications/send-all', adminAuth, async (req, res) => {
  const { title, body, screen, audience } = req.body;

  if (!title || !String(title).trim() || !body || !String(body).trim()) {
    return res.status(400).json({ error: 'Notification title and message body are required' });
  }

  const cleanTitle = String(title).trim();
  const cleanBody = String(body).trim();
  const cleanScreen = screen ? String(screen).trim() : '';
  const cleanAudience = ['all', 'active_24h', 'inactive_3d', 'inactive_7d', 'inactive_30d'].includes(audience)
    ? audience
    : 'all';

  const actor = extractAdmin(req);
  const result = await fcmService.sendToAudience({
    title: cleanTitle,
    body: cleanBody,
    data: cleanScreen ? { screen: cleanScreen } : {},
    audience: cleanAudience
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error || 'Failed to send broadcast notification' });
  }

  const audienceLabels = {
    all: 'All Users',
    active_24h: 'Active (Last 24h)',
    inactive_3d: 'Inactive 3+ Days',
    inactive_7d: 'Inactive 7+ Days',
    inactive_30d: 'Inactive 30+ Days'
  };

  db.run(
    `INSERT INTO push_notifications
       (admin_username, target_type, target_user_id, target_label, title, body, screen, targeted_count, success_count, failure_count)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actor.username,
      cleanAudience.toUpperCase(),
      audienceLabels[cleanAudience] || 'All Users',
      cleanTitle,
      cleanBody,
      cleanScreen,
      result.targetedCount,
      result.successCount,
      result.failureCount
    ]
  );

  logAdminActivity(
    req,
    'NOTIFICATION_SENT_ALL',
    'notification',
    cleanAudience,
    audienceLabels[cleanAudience],
    `Broadcast "${cleanTitle}" → ${result.successCount}/${result.targetedCount} delivered`
  );

  res.json({
    success: true,
    message: `Sent to ${result.successCount} of ${result.targetedCount} devices (${result.failureCount} failed).`,
    ...result
  });
});

module.exports = router;
