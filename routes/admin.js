// backend/routes/admin.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const adminAuth = require('../middleware/adminAuth');

const JWT_ADMIN_SECRET = 'ARENA_GAMES_ADMIN_SECRET_KEY';

// ---------------------------------------------------------------------------
// 0. Safe Initialization (No unhandled exceptions)
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
  `, (err) => {
    if (err) {
      console.error("[Admins Table Init Error]:", err.message);
      return;
    }

    // Seed default admin account if table is empty
    db.get("SELECT COUNT(*) as count FROM admins", (cErr, row) => {
      if (!cErr && row && row.count === 0) {
        bcrypt.hash('admin123', 10, (hErr, hash) => {
          if (!hErr && hash) {
            db.run(
              "INSERT INTO admins (username, full_name, password_hash) VALUES (?, ?, ?)",
              ['admin', 'Master Admin', hash],
              (iErr) => {
                if (!iErr) console.log("[Admin Init] Created default admin: admin / admin123");
              }
            );
          }
        });
      }
    });
  });
});

// 7-Level Stone Badge Tier Definitions
const STONE_TIERS = [
  { rank: 7, name: 'RUBY', days: 100 },
  { rank: 6, name: 'DIAMOND', days: 75 },
  { rank: 5, name: 'AMETHYST', days: 50 },
  { rank: 4, name: 'SAPPHIRE', days: 35 },
  { rank: 3, name: 'JADE', days: 20 },
  { rank: 2, name: 'QUARTZ', days: 10 },
  { rank: 1, name: 'AGATE', days: 5 },
];

function calculateStoneBadge(streakDays) {
  for (const stone of STONE_TIERS) {
    if (streakDays >= stone.days) return stone.name;
  }
  return 'NONE';
}

// ---------------------------------------------------------------------------
// A. Admin Authentication Login
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

    // Compare with bcrypt; fallback to plain text if old test row
    if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
      bcrypt.compare(password.trim(), storedHash, (cmpErr, isValid) => {
        if (cmpErr || !isValid) {
          return res.status(401).json({ error: 'Invalid admin credentials' });
        }
        const token = jwt.sign(
          { id: admin.id, username: admin.username },
          JWT_ADMIN_SECRET,
          { expiresIn: '7d' }
        );
        res.json({ success: true, token });
      });
    } else {
      if (password.trim() !== storedHash) {
        return res.status(401).json({ error: 'Invalid admin credentials' });
      }
      const token = jwt.sign(
        { id: admin.id, username: admin.username },
        JWT_ADMIN_SECRET,
        { expiresIn: '7d' }
      );
      res.json({ success: true, token });
    }
  });
});

// ---------------------------------------------------------------------------
// B. Dashboard Overview Metrics
// ---------------------------------------------------------------------------
router.get('/dashboard', adminAuth, (req, res) => {
  const stats = {};
  db.get('SELECT COUNT(*) as users FROM users', (err, r) => {
    stats.totalUsers = r ? r.users : 0;
    db.get('SELECT SUM(balance) as coins FROM users', (err, r2) => {
      stats.totalCoins = r2 ? (r2.coins || 0) : 0;
      db.get("SELECT COUNT(*) as p FROM withdrawals WHERE status = 'PENDING'", (err, r3) => {
        stats.pendingWithdrawals = r3 ? r3.p : 0;
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
      COALESCE(total_coins_earned, 0) as total_coins_earned,
      COALESCE(current_streak, 0) as current_streak,
      COALESCE(highest_streak, 0) as highest_streak,
      COALESCE(current_stone, 'NONE') as current_stone,
      is_banned, 
      created_at 
     FROM users
     ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to retrieve users' });
      res.json(rows || []);
    }
  );
});

// ---------------------------------------------------------------------------
// D. Admin Accounts Management
// ---------------------------------------------------------------------------

// 1. Get all admins (safe wildcard query)
router.get('/admins', adminAuth, (req, res) => {
  db.all('SELECT * FROM admins ORDER BY id ASC', (err, rows) => {
    if (err) {
      console.error("[Get Admins SQL Error]:", err.message);
      return res.status(500).json({ error: 'Failed to fetch admin accounts' });
    }
    const sanitized = (rows || []).map(admin => ({
      id: admin.id,
      username: admin.username,
      full_name: admin.full_name || 'Admin Staff',
      created_at: admin.created_at || null
    }));
    res.json(sanitized);
  });
});

// 2. Create new admin
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
          console.error("[Admin Create Error]:", err.message);
          if (err.message && (err.message.includes('UNIQUE') || err.message.includes('PRIMARY KEY'))) {
            return res.status(400).json({ error: `Username @${cleanUser} already exists.` });
          }
          return res.status(500).json({ error: 'Database error creating admin' });
        }
        res.json({ success: true, message: `Admin @${cleanUser} created successfully!` });
      }
    );
  });
});

// 3. Reset admin password
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
        if (this.changes === 0) return res.status(404).json({ error: 'Admin account not found' });
        res.json({ success: true, message: `Password updated for @${username}` });
      }
    );
  });
});

// 4. Delete admin account
router.post('/admins/delete', adminAuth, (req, res) => {
  const { username } = req.body;

  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (username.trim().toLowerCase() === 'admin') {
    return res.status(403).json({ error: 'Root admin account cannot be deleted' });
  }

  db.run('DELETE FROM admins WHERE LOWER(username) = ?', [username.trim().toLowerCase()], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to delete admin' });
    if (this.changes === 0) return res.status(404).json({ error: 'Admin account not found' });
    res.json({ success: true, message: `Admin @${username} removed` });
  });
});

// ---------------------------------------------------------------------------
// E. Set / Modify User Streak & Stone Badge
// ---------------------------------------------------------------------------
router.post('/users/:id/streak', adminAuth, (req, res) => {
  const { streak } = req.body;
  const userId = req.params.id;

  const streakNum = parseInt(streak, 10);
  if (isNaN(streakNum) || streakNum < 0) {
    return res.status(400).json({ error: 'Valid positive streak count is required' });
  }

  const stoneName = calculateStoneBadge(streakNum);
  const today = new Date().toISOString().split('T')[0];

  db.run(
    `UPDATE users SET 
      current_streak = ?, 
      highest_streak = MAX(COALESCE(highest_streak, 0), ?), 
      current_stone = ?, 
      last_streak_date = ? 
     WHERE id = ?`,
    [streakNum, streakNum, stoneName, today, userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to update streak' });
      res.json({
        success: true,
        message: `Streak set to ${streakNum} days! Active Badge: ${stoneName}`,
        currentStreak: streakNum,
        currentStone: stoneName,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// F. Reset User Password
// ---------------------------------------------------------------------------
router.post('/users/:id/password', adminAuth, (req, res) => {
  const { password } = req.body;
  if (!password || password.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  bcrypt.hash(password, 10, (bErr, hash) => {
    if (bErr) return res.status(500).json({ error: 'Encryption failure' });
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to reset password' });
      res.json({ success: true });
    });
  });
});

// ---------------------------------------------------------------------------
// G. Manual Coin Balance Adjustment
// ---------------------------------------------------------------------------
router.post('/users/:id/coins', adminAuth, (req, res) => {
  const { amount } = req.body;
  const userId = req.params.id;

  if (amount === undefined || isNaN(amount)) {
    return res.status(400).json({ error: 'Valid coin amount is required' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.run(
      'UPDATE users SET balance = MAX(0, balance + ?), total_coins_earned = MAX(0, COALESCE(total_coins_earned, 0) + ?) WHERE id = ?',
      [amount, amount > 0 ? amount : 0, userId],
      function (err) {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Failed to adjust coins' });
        }

        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) 
           VALUES (?, 'GAME_REWARD', ?, 'MANUAL_ADMIN_ADJUSTMENT')`,
          [userId, amount],
          (txErr) => {
            if (txErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to write transaction record' });
            }

            db.run('COMMIT');
            res.json({ success: true });
          }
        );
      }
    );
  });
});

// ---------------------------------------------------------------------------
// H. Ban / Unban User Toggle
// ---------------------------------------------------------------------------
router.post('/users/:id/ban', adminAuth, (req, res) => {
  const { isBanned } = req.body;
  const userId = req.params.id;

  if (isBanned === undefined) {
    return res.status(400).json({ error: 'Ban state is required' });
  }

  db.run('UPDATE users SET is_banned = ? WHERE id = ?', [isBanned ? 1 : 0, userId], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to alter ban state' });
    res.json({ success: true });
  });
});

// ---------------------------------------------------------------------------
// I. Dynamic Payment Gateways Configuration
// ---------------------------------------------------------------------------
router.get('/payment-methods', adminAuth, (req, res) => {
  db.get("SELECT value FROM app_config WHERE key = 'payment_methods'", (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    try {
      const data = row && row.value ? JSON.parse(row.value) : [];
      res.json(data);
    } catch {
      res.json([]);
    }
  });
});

router.post('/payment-methods', adminAuth, (req, res) => {
  const { methods } = req.body;
  if (!methods || !Array.isArray(methods)) {
    return res.status(400).json({ error: 'Array of payment methods is required' });
  }

  const jsonStr = JSON.stringify(methods);

  db.run(
    "INSERT OR REPLACE INTO app_config (key, value) VALUES ('payment_methods', ?)",
    [jsonStr],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to save payment gateways' });
      res.json({ success: true, message: 'Payment methods updated successfully!' });
    }
  );
});

// ---------------------------------------------------------------------------
// J. Withdrawals Pipeline & Resolutions
// ---------------------------------------------------------------------------
router.get('/withdrawals', adminAuth, (req, res) => {
  db.all(
    `SELECT w.*, u.username FROM withdrawals w 
     JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database read failure' });
      res.json(rows || []);
    }
  );
});

router.post('/withdrawals/:id/status', adminAuth, (req, res) => {
  const { status } = req.body;
  const withdrawalId = req.params.id;

  db.get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId], (err, record) => {
    if (err || !record) return res.status(404).json({ error: 'Withdrawal not found' });
    if (record.status !== 'PENDING') return res.status(400).json({ error: 'Request already resolved' });

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('UPDATE withdrawals SET status = ? WHERE id = ?', [status, withdrawalId]);

      if (status === 'APPROVED') {
        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'REDEEM_APPROVED', ?, ?)`,
          [record.user_id, -record.coin_amount, withdrawalId]
        );
      } else if (status === 'REJECTED') {
        db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [record.coin_amount, record.user_id]);
        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'REDEEM_REJECTED', ?, ?)`,
          [record.user_id, record.coin_amount, withdrawalId]
        );
      }

      db.run('COMMIT', (err) => {
        if (err) return res.status(500).json({ error: 'Failed to finalize resolution' });
        res.json({ success: true });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// K. App Config Versioning
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
      stmt.run(key, val.toString());
    }
    stmt.finalize();
    db.run('COMMIT', (err) => {
      if (err) return res.status(500).json({ error: 'Update failed' });
      res.json({ success: true });
    });
  });
});

module.exports = router;
