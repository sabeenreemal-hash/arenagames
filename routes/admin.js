// backend/routes/admin.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const adminAuth = require('../middleware/adminAuth');

const JWT_ADMIN_SECRET = 'ARENA_GAMES_ADMIN_SECRET_KEY';

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

  db.get('SELECT * FROM admins WHERE username = ?', [username], async (err, admin) => {
    if (err || !admin) return res.status(401).json({ error: 'Invalid admin credentials' });

    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Invalid admin credentials' });

    const token = jwt.sign(
      { id: admin.id, username: admin.username },
      JWT_ADMIN_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, token });
  });
});

// ---------------------------------------------------------------------------
// B. Dashboard Overview Metrics
// ---------------------------------------------------------------------------
router.get('/dashboard', adminAuth, (req, res) => {
  const stats = {};
  db.get('SELECT COUNT(*) as users FROM users', (err, r) => {
    stats.totalUsers = r ? r.users : 0;
    db.get('SELECT SUM(balance) as coins FROM users', (err, r) => {
      stats.totalCoins = r ? (r.coins || 0) : 0;
      db.get("SELECT COUNT(*) as p FROM withdrawals WHERE status = 'PENDING'", (err, r) => {
        stats.pendingWithdrawals = r ? r.p : 0;
        db.get('SELECT COUNT(*) as creators FROM users WHERE creator_badge_enabled = 1', (err, cr) => {
          stats.totalCreators = cr ? cr.creators : 0;
          res.json(stats);
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// C. Users Registry (Includes Streaks, Stones, and Creator Badge Status)
// ---------------------------------------------------------------------------
router.get('/users', adminAuth, (req, res) => {
  db.all(
    `SELECT 
      u.id, 
      u.full_name, 
      u.username, 
      u.email, 
      u.balance, 
      COALESCE(u.total_coins_earned, 0) as total_coins_earned,
      COALESCE(u.current_streak, 0) as current_streak,
      COALESCE(u.highest_streak, 0) as highest_streak,
      COALESCE(u.current_stone, 'NONE') as current_stone,
      COALESCE(u.creator_badge_enabled, 0) as creator_badge_enabled,
      u.creator_badge_id,
      b.icon_url as creator_badge_icon,
      b.name as creator_badge_name,
      u.is_banned, 
      u.created_at 
     FROM users u
     LEFT JOIN badges b ON u.creator_badge_id = b.id
     ORDER BY u.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to retrieve users' });
      res.json(rows || []);
    }
  );
});

// ---------------------------------------------------------------------------
// D. Creator Badge System Endpoints
// ---------------------------------------------------------------------------

// 1. Get all available badges
router.get('/badges', adminAuth, (req, res) => {
  db.all('SELECT * FROM badges ORDER BY id ASC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch badges' });
    res.json(rows || []);
  });
});

// 2. Create or Update Badge
router.post('/badges', adminAuth, (req, res) => {
  const { id, name, icon_url, is_enabled } = req.body;
  if (!name || !icon_url) {
    return res.status(400).json({ error: 'Badge name and icon URL are required' });
  }

  if (id) {
    db.run(
      'UPDATE badges SET name = ?, icon_url = ?, is_enabled = ? WHERE id = ?',
      [name, icon_url, is_enabled !== undefined ? (is_enabled ? 1 : 0) : 1, id],
      function (err) {
        if (err) return res.status(500).json({ error: 'Failed to update badge' });
        res.json({ success: true, message: 'Badge updated successfully' });
      }
    );
  } else {
    db.run(
      'INSERT INTO badges (name, icon_url, is_enabled) VALUES (?, ?, ?)',
      [name, icon_url, is_enabled !== undefined ? (is_enabled ? 1 : 0) : 1],
      function (err) {
        if (err) return res.status(500).json({ error: 'Failed to insert badge' });
        res.json({ success: true, id: this.lastID, message: 'Badge created successfully' });
      }
    );
  }
});

// 3. Enable / Disable Creator Badge for a User
router.post('/users/:id/creator-badge', adminAuth, (req, res) => {
  const { enabled, badgeId } = req.body;
  const userId = req.params.id;

  const isEnabled = enabled ? 1 : 0;
  const assignedBadgeId = isEnabled ? (badgeId || 1) : null;

  db.run(
    'UPDATE users SET creator_badge_enabled = ?, creator_badge_id = ? WHERE id = ?',
    [isEnabled, assignedBadgeId, userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to update creator badge status' });
      res.json({
        success: true,
        message: isEnabled ? 'Creator badge granted to user!' : 'Creator badge disabled for user.',
        creator_badge_enabled: isEnabled === 1,
        creator_badge_id: assignedBadgeId,
      });
    }
  );
});

// 4. Issue Monthly Creator Coins Reward
router.post('/users/:id/creator-reward', adminAuth, (req, res) => {
  const userId = req.params.id;
  const { coin_amount, month, admin_note } = req.body;

  const coins = parseInt(coin_amount, 10);
  if (isNaN(coins) || coins <= 0) {
    return res.status(400).json({ error: 'A positive integer coin amount is required' });
  }

  const rewardMonth = (month && month.trim().length > 0)
    ? month.trim()
    : new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const note = admin_note ? admin_note.trim() : 'Monthly creator reward';

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    // Insert into creator_rewards history
    db.run(
      `INSERT INTO creator_rewards (user_id, coin_amount, month, admin_note) 
       VALUES (?, ?, ?, ?)`,
      [userId, coins, rewardMonth, note],
      function (rewardErr) {
        if (rewardErr) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Failed to record creator reward' });
        }

        const rewardId = this.lastID;

        // Credit user's wallet
        db.run(
          `UPDATE users SET 
            balance = balance + ?, 
            total_coins_earned = total_coins_earned + ? 
           WHERE id = ?`,
          [coins, coins, userId],
          function (userErr) {
            if (userErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to credit user wallet balance' });
            }

            // Write unified ledger transaction record
            db.run(
              `INSERT INTO transactions (user_id, type, amount, reference_id) 
               VALUES (?, 'CREATOR_REWARD', ?, ?)`,
              [userId, coins, `CREATOR_REWARD_${rewardId}_${rewardMonth}`],
              function (txErr) {
                if (txErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to record transaction log' });
                }

                db.run('COMMIT');
                res.json({
                  success: true,
                  message: `Successfully rewarded ${coins.toLocaleString()} coins to user for ${rewardMonth}!`,
                  rewardId,
                });
              }
            );
          }
        );
      }
    );
  });
});

// 5. Get Creator Rewards History
router.get('/creator-rewards', adminAuth, (req, res) => {
  db.all(
    `SELECT 
      cr.*, 
      u.username, 
      u.full_name,
      u.email 
     FROM creator_rewards cr
     JOIN users u ON cr.user_id = u.id
     ORDER BY cr.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch creator reward history' });
      res.json(rows || []);
    }
  );
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
      if (err) {
        return res.status(500).json({ error: 'Failed to update streak' });
      }
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
router.post('/users/:id/password', adminAuth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to reset password' });
      res.json({ success: true });
    });
  } catch (e) {
    res.status(500).json({ error: 'Encryption failure' });
  }
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