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

const JWT_ADMIN_SECRET = 'ARENA_GAMES_ADMIN_SECRET_KEY';

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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

// ---------------------------------------------------------------------------
// A. Admin Login
// ---------------------------------------------------------------------------
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
        // Fallback check for plain text legacy passwords
        if (password.trim() === storedHash) {
          const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_ADMIN_SECRET, { expiresIn: '7d' });
          return res.json({ success: true, token });
        }
        return res.status(401).json({ error: 'Invalid admin credentials' });
      }

      const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_ADMIN_SECRET, { expiresIn: '7d' });
      res.json({ success: true, token });
    });
  });
});

// ---------------------------------------------------------------------------
// B. Fast Dashboard Overview Metrics (Heavy Active-User Query Removed)
// ---------------------------------------------------------------------------
router.get('/dashboard', adminAuth, (req, res) => {
  const stats = {};
  
  db.get('SELECT COUNT(*) as users, COALESCE(SUM(balance), 0) as coins FROM users', (err, r1) => {
    stats.totalUsers = r1 ? r1.users : 0;
    stats.totalCoins = r1 ? r1.coins : 0;

    db.get("SELECT COUNT(*) as p FROM withdrawals WHERE status = 'PENDING'", (wErr, r2) => {
      stats.pendingWithdrawals = r2 ? r2.p : 0;

      db.get("SELECT COUNT(*) as t FROM task_submissions WHERE status = 'pending'", (tErr, r3) => {
        stats.pendingTasks = r3 ? r3.t : 0;
        res.json(stats);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// C. Users Registry
// ---------------------------------------------------------------------------
router.get('/users', adminAuth, (req, res) => {
  db.all(
    `SELECT 
      id, 
      full_name, 
      username, 
      email, 
      balance, 
      COALESCE(current_streak, 0) as current_streak,
      is_banned, 
      created_at
     FROM users
     ORDER BY id DESC LIMIT 500`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to retrieve users' });
      res.json(rows || []);
    }
  );
});

// ---------------------------------------------------------------------------
// D. Admin Accounts Management
// ---------------------------------------------------------------------------
router.get('/admins', adminAuth, (req, res) => {
  db.all('SELECT id, username, full_name, created_at FROM admins ORDER BY id ASC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch admin accounts' });
    res.json(rows || []);
  });
});

router.post('/admins/create', adminAuth, (req, res) => {
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
        res.json({ success: true, message: `Admin @${cleanUser} created successfully!` });
      }
    );
  });
});

router.post('/admins/password', adminAuth, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password || password.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  bcrypt.hash(password.trim(), 10, (bErr, hash) => {
    if (bErr) return res.status(500).json({ error: 'Encryption failure' });

    db.run(
      'UPDATE admins SET password_hash = ? WHERE LOWER(username) = ?',
      [hash, username.trim().toLowerCase()],
      function (err) {
        if (err) return res.status(500).json({ error: 'Failed to update password' });
        res.json({ success: true, message: `Password updated for @${username}` });
      }
    );
  });
});

router.post('/admins/delete', adminAuth, (req, res) => {
  const { username } = req.body;

  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (username.trim().toLowerCase() === 'admin') {
    return res.status(403).json({ error: 'Root admin account cannot be deleted' });
  }

  db.run('DELETE FROM admins WHERE LOWER(username) = ?', [username.trim().toLowerCase()], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to delete admin' });
    res.json({ success: true, message: `Admin @${username} removed` });
  });
});

// ---------------------------------------------------------------------------
// E. Quick User Management Operations
// ---------------------------------------------------------------------------
router.post('/users/:id/password', adminAuth, (req, res) => {
  const { password } = req.body;
  if (!password || password.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  bcrypt.hash(password.trim(), 10, (bErr, hash) => {
    if (bErr) return res.status(500).json({ error: 'Encryption failure' });
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to reset password' });
      res.json({ success: true });
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

  db.run(
    'UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?',
    [coinAmount, userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to adjust coins' });
      res.json({ success: true });
    }
  );
});

router.post('/users/:id/ban', adminAuth, (req, res) => {
  const { isBanned } = req.body;
  db.run('UPDATE users SET is_banned = ? WHERE id = ?', [isBanned ? 1 : 0, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to alter ban state' });
    res.json({ success: true });
  });
});

router.post('/users/:id/delete', adminAuth, (req, res) => {
  const userId = req.params.id;

  db.all('SELECT screenshot_path FROM task_submissions WHERE user_id = ?', [userId], (err, rows) => {
    if (!err && rows) {
      rows.forEach(r => deleteScreenshotFile(r.screenshot_path));
    }

    db.run('DELETE FROM users WHERE id = ?', [userId], function (delErr) {
      if (delErr) return res.status(500).json({ error: 'Database error deleting user' });
      res.json({ success: true, message: `User #${userId} deleted.` });
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
      res.json({ success: true, message: 'Payment methods updated!' });
    }
  );
});

// ---------------------------------------------------------------------------
// G. Withdrawals Pipeline
// ---------------------------------------------------------------------------
router.get('/withdrawals', adminAuth, (req, res) => {
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
     ORDER BY w.id DESC LIMIT 200`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database read failure' });
      res.json(rows || []);
    }
  );
});

router.post('/withdrawals/:id/status', adminAuth, (req, res) => {
  const { status } = req.body;
  const withdrawalId = req.params.id;

  if (!['APPROVED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId], (err, record) => {
    if (err || !record) return res.status(404).json({ error: 'Withdrawal not found' });
    if (record.status !== 'PENDING') return res.status(400).json({ error: 'Already resolved' });

    const nowIso = new Date().toISOString();

    if (status === 'APPROVED') {
      db.run(
        'UPDATE users SET balance = balance - ?, last_withdrawal_at = ? WHERE id = ?',
        [record.coin_amount, nowIso, record.user_id],
        (uErr) => {
          if (uErr) return res.status(500).json({ error: 'Failed to deduct balance' });

          db.run(
            'UPDATE withdrawals SET status = ?, processed_at = ? WHERE id = ?',
            ['APPROVED', nowIso, withdrawalId],
            () => res.json({ success: true })
          );
        }
      );
    } else {
      db.run(
        'UPDATE withdrawals SET status = ?, processed_at = ? WHERE id = ?',
        ['REJECTED', nowIso, withdrawalId],
        () => res.json({ success: true })
      );
    }
  });
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

  db.run(
    `INSERT INTO tasks (title, reward_coins, instructions, proof_type, action_url, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [title.trim(), parseInt(reward_coins, 10), (instructions || '').trim(), proof_type || 'both', (action_url || '').trim()],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to create task' });
      res.json({ success: true, taskId: this.lastID });
    }
  );
});

router.post('/tasks/:id/update', adminAuth, (req, res) => {
  const { is_active } = req.body;
  db.run('UPDATE tasks SET is_active = ? WHERE id = ?', [is_active, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to update task' });
    res.json({ success: true });
  });
});

router.post('/tasks/:id/delete', adminAuth, (req, res) => {
  db.run('DELETE FROM tasks WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete task' });
    res.json({ success: true });
  });
});

// ---------------------------------------------------------------------------
// J. Task Submissions & Approval / Rejection
// ---------------------------------------------------------------------------
router.get('/task-submissions', adminAuth, (req, res) => {
  const { status } = req.query;
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

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to retrieve task submissions' });

    const formatted = (rows || []).map(r => {
      if (r.screenshot_path) {
        r.screenshot_path = `/uploads/task_proofs/${path.basename(r.screenshot_path)}`;
      }
      return r;
    });

    res.json(formatted);
  });
});

router.post('/task-submissions/:id/approve', adminAuth, (req, res) => {
  const subId = req.params.id;

  db.get(
    `SELECT ts.*, t.reward_coins 
     FROM task_submissions ts
     JOIN tasks t ON ts.task_id = t.id
     WHERE ts.id = ?`,
    [subId],
    (err, sub) => {
      if (err || !sub) return res.status(404).json({ error: 'Submission not found' });
      if (sub.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });

      db.run(
        `UPDATE task_submissions SET status = 'approved', screenshot_path = NULL WHERE id = ?`,
        [subId],
        (uErr) => {
          if (uErr) return res.status(500).json({ error: 'Failed to approve' });

          db.run(
            `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
            [sub.reward_coins, sub.reward_coins, sub.user_id],
            () => {
              // Delete screenshot immediately to save VPS storage
              deleteScreenshotFile(sub.screenshot_path);
              creditReferralCommission(sub.user_id, sub.reward_coins, 'TASK', `TASK_SUB_${subId}`, 0.10);
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

  db.get('SELECT * FROM task_submissions WHERE id = ?', [subId], (err, sub) => {
    if (err || !sub) return res.status(404).json({ error: 'Submission not found' });
    if (sub.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });

    db.run(
      `UPDATE task_submissions SET status = 'rejected', rejection_reason = ?, screenshot_path = NULL WHERE id = ?`,
      [reason ? reason.trim() : 'Rejected', subId],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: 'Failed to reject' });
        deleteScreenshotFile(sub.screenshot_path);
        res.json({ success: true });
      }
    );
  });
});

module.exports = router;
