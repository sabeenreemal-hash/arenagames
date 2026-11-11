// backend/routes/mines.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

// =============================================================================
// 0. Database Auto-Migration for Mines
// =============================================================================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS mines_user_progress (
      user_id INTEGER PRIMARY KEY,
      unlocked_level INTEGER DEFAULT 1,
      completed_levels TEXT DEFAULT '[]',
      daily_cooldown_until INTEGER DEFAULT 0,
      daily_locked_level INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_mines_user ON mines_user_progress(user_id);`, () => {});
});

// =============================================================================
// SERVER-SIDE LEVEL CONFIGURATIONS (Levels 1 to 20)
// You can change diamonds & mines here anytime without rebuilding Flutter!
// =============================================================================
const LEVEL_CONFIGS = {
  1: { gridSize: 3, diamondCount: 4, mineCount: 4, diamonds: [0, 2, 6, 8], mines: [1, 3, 5, 7] },
  2: { gridSize: 3, diamondCount: 4, mineCount: 5, diamonds: [1, 3, 5, 7], mines: [0, 2, 4, 6, 8] },
  3: { gridSize: 4, diamondCount: 5, mineCount: 7, diamonds: [0, 3, 5, 10, 15], mines: [1, 4, 6, 9, 11, 12, 14] },
  4: { gridSize: 4, diamondCount: 6, mineCount: 8, diamonds: [1, 3, 4, 6, 9, 11], mines: [0, 2, 5, 7, 8, 10, 13, 15] },
  5: { gridSize: 4, diamondCount: 6, mineCount: 9, diamonds: [1, 4, 6, 9, 11, 13], mines: [0, 2, 3, 5, 7, 8, 10, 12, 14] },
  6: { gridSize: 5, diamondCount: 8, mineCount: 12, diamonds: [0, 4, 7, 11, 13, 17, 20, 24], mines: [1, 3, 6, 8, 10, 12, 14, 16, 18, 21, 22, 23] },
  7: { gridSize: 5, diamondCount: 9, mineCount: 13, diamonds: [1, 3, 5, 7, 9, 11, 15, 19, 23], mines: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24] },
  8: { gridSize: 5, diamondCount: 10, mineCount: 14, diamonds: [1, 4, 6, 8, 10, 13, 15, 17, 20, 22], mines: [0, 2, 3, 5, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23] },
  9: { gridSize: 6, diamondCount: 12, mineCount: 17, diamonds: [0, 2, 6, 8, 11, 13, 16, 18, 22, 24, 28, 31], mines: [1, 3, 5, 7, 9, 12, 14, 17, 19, 21, 23, 25, 27, 30, 32, 33, 35] },
  10: { gridSize: 6, diamondCount: 14, mineCount: 18, diamonds: [1, 3, 5, 6, 8, 10, 12, 14, 16, 19, 21, 23, 26, 28], mines: [0, 2, 4, 7, 9, 11, 13, 15, 17, 18, 20, 22, 25, 27, 29, 31, 33, 35] },
  11: { gridSize: 5, diamondCount: 8, mineCount: 10, diamonds: [0, 2, 4, 10, 14, 20, 22, 24], mines: [1, 3, 6, 8, 11, 13, 16, 18, 21, 23] },
  12: { gridSize: 5, diamondCount: 9, mineCount: 11, diamonds: [0, 4, 6, 8, 12, 16, 18, 20, 24], mines: [1, 2, 3, 5, 9, 10, 14, 15, 19, 21, 23] },
  13: { gridSize: 5, diamondCount: 10, mineCount: 12, diamonds: [1, 3, 5, 9, 11, 13, 15, 19, 21, 23], mines: [0, 2, 4, 6, 7, 8, 12, 14, 16, 18, 20, 24] },
  14: { gridSize: 5, diamondCount: 10, mineCount: 13, diamonds: [0, 2, 6, 8, 10, 12, 14, 18, 20, 22], mines: [1, 3, 4, 5, 7, 9, 11, 13, 15, 16, 17, 19, 21] },
  15: { gridSize: 5, diamondCount: 11, mineCount: 12, diamonds: [0, 3, 4, 6, 9, 12, 15, 18, 20, 21, 24], mines: [1, 2, 5, 7, 8, 10, 11, 13, 14, 16, 17, 22] },
  16: { gridSize: 6, diamondCount: 10, mineCount: 14, diamonds: [0, 5, 6, 11, 14, 21, 24, 29, 30, 35], mines: [1, 2, 3, 4, 7, 10, 12, 17, 25, 28, 31, 32, 33, 34] },
  17: { gridSize: 6, diamondCount: 11, mineCount: 15, diamonds: [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31], mines: [0, 2, 3, 5, 8, 9, 14, 15, 20, 21, 26, 27, 32, 33, 35] },
  18: { gridSize: 6, diamondCount: 12, mineCount: 16, diamonds: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33], mines: [1, 2, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19, 20, 22, 23] },
  19: { gridSize: 6, diamondCount: 13, mineCount: 17, diamonds: [0, 2, 4, 7, 9, 11, 14, 16, 18, 21, 23, 25, 28], mines: [1, 3, 5, 6, 8, 10, 12, 13, 15, 17, 19, 20, 22, 24, 26, 27, 29] },
  20: { gridSize: 6, diamondCount: 14, mineCount: 18, diamonds: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26], mines: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 28, 29, 30, 31] }
};

// Helper: Next day midnight timestamp in milliseconds
function getNextMidnightEpoch() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  return tomorrow.getTime();
}

// -----------------------------------------------------------------------------
// 1. GET USER MINES PROGRESS
// GET /api/mines/progress
// -----------------------------------------------------------------------------
router.get('/progress', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.get('SELECT * FROM mines_user_progress WHERE user_id = ?', [userId], (err, row) => {
    if (err) {
      console.error('[MINES GET PROGRESS ERROR]:', err);
      return res.status(500).json({ error: 'Database query failed' });
    }

    const now = Date.now();
    if (!row) {
      return res.json({
        unlocked_level: 1,
        completed_levels: [],
        daily_cooldown_until: 0,
        is_daily_locked: false
      });
    }

    const completed = JSON.parse(row.completed_levels || '[]');
    const isLocked = (row.daily_cooldown_until || 0) > now;

    res.json({
      unlocked_level: row.unlocked_level || 1,
      completed_levels: completed,
      daily_cooldown_until: isLocked ? row.daily_cooldown_until : 0,
      is_daily_locked: isLocked
    });
  });
});

// -----------------------------------------------------------------------------
// 2. GET LEVEL CONFIGURATION
// GET /api/mines/level/:levelNumber
// -----------------------------------------------------------------------------
router.get('/level/:levelNumber', authenticateToken, (req, res) => {
  const level = parseInt(req.params.levelNumber, 10) || 1;

  if (LEVEL_CONFIGS[level]) {
    return res.json({ success: true, level, config: LEVEL_CONFIGS[level] });
  }

  // Procedural fallback for levels > 20
  const gridSize = level > 40 ? 7 : 6;
  const diamondCount = Math.min(12 + Math.floor(level / 5), Math.floor(gridSize * gridSize * 0.35));
  const mineCount = Math.min(16 + Math.floor(level / 4), Math.floor(gridSize * gridSize * 0.50));

  res.json({
    success: true,
    level,
    config: {
      gridSize,
      diamondCount,
      mineCount,
      diamonds: [],
      mines: []
    }
  });
});

// -----------------------------------------------------------------------------
// 3. COMPLETE LEVEL & CREDIT WALLET (10 Coins)
// POST /api/mines/complete
// -----------------------------------------------------------------------------
router.post('/complete', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const levelNum = parseInt(req.body.level, 10);

  if (!levelNum || levelNum < 1) {
    return res.status(400).json({ error: 'Valid level number is required' });
  }

  const now = Date.now();

  db.get('SELECT * FROM mines_user_progress WHERE user_id = ?', [userId], (err, row) => {
    if (err) {
      console.error('[MINES COMPLETE ERROR]:', err);
      return res.status(500).json({ error: 'Database lookup failed' });
    }

    const unlocked = row ? (row.unlocked_level || 1) : 1;
    const completed = row ? JSON.parse(row.completed_levels || '[]') : [];
    const cooldownUntil = row ? (row.daily_cooldown_until || 0) : 0;

    // A. Enforce 20-Level Daily Lock (Cannot bypass by changing phone time!)
    if (cooldownUntil > now && levelNum >= unlocked) {
      return res.status(403).json({
        error: 'Daily 20-level goal reached! Next batch unlocks tomorrow.',
        cooldown_until: cooldownUntil
      });
    }

    // B. Replay Rule: 0 coins for already completed levels, 10 coins for new levels
    const isReplay = completed.includes(levelNum);
    const coinsToCredit = isReplay ? 0 : 10;

    // C. Update progression lists
    if (!completed.includes(levelNum)) {
      completed.push(levelNum);
    }
    const newUnlocked = Math.max(unlocked, levelNum + 1);

    // D. 20-Level Daily Limit Trigger (e.g. at 20, 40, 60...)
    let newCooldown = cooldownUntil;
    let newCooldownLevel = row ? (row.daily_locked_level || 0) : 0;
    const isMilestone = (levelNum % 20 === 0);

    if (isMilestone) {
      newCooldown = getNextMidnightEpoch();
      newCooldownLevel = levelNum;
      console.log(`[MINES] 🛑 User ${userId} completed Level ${levelNum}. Locked until tomorrow midnight.`);
    }

    // E. Execute Database Updates in a Transaction
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      // 1. Update Mines Progress Table
      db.run(
        `INSERT INTO mines_user_progress (user_id, unlocked_level, completed_levels, daily_cooldown_until, daily_locked_level, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           unlocked_level = excluded.unlocked_level,
           completed_levels = excluded.completed_levels,
           daily_cooldown_until = excluded.daily_cooldown_until,
           daily_locked_level = excluded.daily_locked_level,
           updated_at = CURRENT_TIMESTAMP`,
        [userId, newUnlocked, JSON.stringify(completed), newCooldown, newCooldownLevel]
      );

      // 2. Credit Wallet and Record Transaction (Matching your exact database schema)
      if (coinsToCredit > 0) {
        db.run(
          `UPDATE users SET 
             balance = balance + ?, 
             total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
           WHERE id = ?`,
          [coinsToCredit, coinsToCredit, userId]
        );

        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) 
           VALUES (?, 'MINES_REWARD', ?, ?)`,
          [userId, coinsToCredit, `MINES_LVL_${levelNum}_${Date.now()}`]
        );
      }

      db.run('COMMIT', (commitErr) => {
        if (commitErr) {
          db.run('ROLLBACK');
          console.error('[MINES TRANSACTION COMMIT FAILED]:', commitErr);
          return res.status(500).json({ error: 'Failed to record level completion' });
        }

        console.log(`[MINES] 🎉 User ${userId} completed Level ${levelNum}. Credited: ${coinsToCredit} coins. New level: ${newUnlocked}`);

        // Fetch fresh balance to return to the Flutter app
        db.get('SELECT balance FROM users WHERE id = ?', [userId], (_, userRow) => {
          res.json({
            success: true,
            coins_earned: coinsToCredit,
            is_replay: isReplay,
            new_unlocked_level: newUnlocked,
            new_balance: userRow ? userRow.balance : null,
            daily_cooldown_until: (newCooldown > now) ? newCooldown : 0,
            is_20_level_milestone: isMilestone
          });
        });
      });
    });
  });
});

module.exports = router;
