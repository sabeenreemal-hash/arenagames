// backend/routes/highLowAdminRoutes.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');

// Middleware: Admin Authorization Check
function requireAdmin(req, res, next) {
  const userId = req.user.id;
  db.get('SELECT id, username FROM admins WHERE id = ?', [userId], (err, admin) => {
    if (err || !admin) {
      // Fallback check against users table if admin was granted in users
      db.get('SELECT id, is_banned FROM users WHERE id = ?', [userId], (uErr, user) => {
        if (uErr || !user) return res.status(403).json({ error: 'Forbidden: Admin access required' });
        next();
      });
      return;
    }
    req.admin = admin;
    next();
  });
}

// ---------------------------------------------------------------------------
// 1. ADMIN DASHBOARD SUMMARY (GET /api/admin/high-low/dashboard)
// ---------------------------------------------------------------------------
router.get('/dashboard', authenticateToken, requireAdmin, (req, res) => {
  const { timeframe } = req.query; // 'today', '7days', '30days', 'all'

  let dateFilter = "";
  if (timeframe === 'today') {
    dateFilter = "WHERE started_at >= date('now')";
  } else if (timeframe === '7days') {
    dateFilter = "WHERE started_at >= date('now', '-7 days')";
  } else if (timeframe === '30days') {
    dateFilter = "WHERE started_at >= date('now', '-30 days')";
  }

  const query = `
    SELECT 
      COUNT(*) AS total_games,
      COUNT(DISTINCT user_id) AS total_players,
      SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) AS total_wins,
      SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) AS total_losses,
      SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_games,
      COALESCE(SUM(entry_cost), 0) AS total_coins_collected,
      COALESCE(SUM(claimed_reward), 0) AS total_coins_rewarded,
      AVG(consecutive_wins) AS avg_consecutive_wins,
      MAX(claimed_reward) AS highest_reward_claimed
    FROM high_low_games
    ${dateFilter}
  `;

  db.get(query, (err, stats) => {
    if (err) return res.status(500).json({ error: 'Failed to aggregate dashboard analytics' });

    // Recent 10 games
    db.all(
      `SELECT g.*, u.username 
       FROM high_low_games g 
       JOIN users u ON g.user_id = u.id 
       ORDER BY g.started_at DESC LIMIT 10`,
      (rErr, recent) => {
        res.json({
          summary: stats || {},
          recentGames: recent || []
        });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 2. LIVE ACTIVE GAMES MONITORING (GET /api/admin/high-low/live)
// ---------------------------------------------------------------------------
router.get('/live', authenticateToken, requireAdmin, (req, res) => {
  const sql = `
    SELECT 
      g.id, g.user_id, u.username, g.entry_cost, g.current_card, 
      g.consecutive_wins, g.potential_reward, g.started_at, g.status
    FROM high_low_games g
    JOIN users u ON g.user_id = u.id
    WHERE g.status = 'ACTIVE'
    ORDER BY g.started_at DESC
  `;

  db.all(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to retrieve active sessions' });
    res.json({ liveGames: rows || [] });
  });
});

// ---------------------------------------------------------------------------
// 3. TARGET USER MONITORING (GET & POST)
// ---------------------------------------------------------------------------
router.get('/target-users', authenticateToken, requireAdmin, (req, res) => {
  const sql = `
    SELECT t.*, u.username, u.email, u.balance, s.total_games, s.total_wins, s.total_losses
    FROM high_low_target_users t
    JOIN users u ON t.user_id = u.id
    LEFT JOIN high_low_user_stats s ON t.user_id = s.user_id
    ORDER BY t.created_at DESC
  `;
  db.all(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch targeted users' });
    res.json({ targetUsers: rows || [] });
  });
});

router.post('/target-users/add', authenticateToken, requireAdmin, (req, res) => {
  const { userId, reason } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  db.run(
    `INSERT INTO high_low_target_users (user_id, reason) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason`,
    [userId, reason || 'Flagged for observation'],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to add target user' });
      res.json({ success: true, message: 'Target user added to observation list' });
    }
  );
});

router.post('/target-users/remove', authenticateToken, requireAdmin, (req, res) => {
  const { userId } = req.body;
  db.run('DELETE FROM high_low_target_users WHERE user_id = ?', [userId], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to remove target user' });
    res.json({ success: true, message: 'User removed from observation' });
  });
});

// ---------------------------------------------------------------------------
// 4. GAME CONFIGURATION (GET & POST)
// ---------------------------------------------------------------------------
router.get('/config', authenticateToken, requireAdmin, (req, res) => {
  db.get("SELECT value FROM app_config WHERE key = 'high_low_config'", (err, row) => {
    if (err) return res.status(500).json({ error: 'Config fetch failed' });
    let config = {
      entryCost: 500,
      startingReward: 500,
      multiplier: 2.0,
      minWinsForClaim: 3,
      aceRule: 'HIGHEST',
      tieRule: 'LOSE',
      isEnabled: true,
      version: 1
    };
    if (row && row.value) {
      try { config = JSON.parse(row.value); } catch (_) {}
    }
    res.json({ config });
  });
});

router.post('/config', authenticateToken, requireAdmin, (req, res) => {
  const incoming = req.body;
  db.get("SELECT value FROM app_config WHERE key = 'high_low_config'", (err, row) => {
    let oldConfig = {};
    if (row && row.value) {
      try { oldConfig = JSON.parse(row.value); } catch (_) {}
    }
    const updated = {
      ...oldConfig,
      ...incoming,
      version: (oldConfig.version || 1) + 1,
      updated_at: new Date().toISOString()
    };

    db.run(
      `INSERT OR REPLACE INTO app_config (key, value) VALUES ('high_low_config', ?)`,
      [JSON.stringify(updated)],
      (saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Config save failed' });
        res.json({ success: true, config: updated, message: 'High or Low configuration updated' });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 5. CANCEL AND REFUND GAME (POST /api/admin/high-low/game/cancel)
// ---------------------------------------------------------------------------
router.post('/game/cancel', authenticateToken, requireAdmin, (req, res) => {
  const { gameId, reason } = req.body;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });

  db.get(`SELECT * FROM high_low_games WHERE id = ? AND status = 'ACTIVE'`, [gameId], (err, game) => {
    if (err || !game) return res.status(400).json({ error: 'Game not active or non-existent' });

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      db.run(`UPDATE high_low_games SET status = 'CANCELLED', completed_at = CURRENT_TIMESTAMP WHERE id = ?`, [gameId]);
      
      // Refund entry fee
      db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [game.entry_cost, game.user_id]);
      
      db.run(
        `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'HIGH_LOW_REFUND', ?, ?)`,
        [game.user_id, game.entry_cost, `REFUND_${gameId}`]
      );

      db.run('COMMIT', (commitErr) => {
        if (commitErr) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Refund cancellation failed' });
        }
        res.json({ success: true, message: `Game ${gameId} cancelled and ${game.entry_cost} coins refunded to User ${game.user_id}` });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 6. ISOLATED SANDBOX TESTING (POST /api/admin/high-low/sandbox/simulate)
// ---------------------------------------------------------------------------
router.post('/sandbox/simulate', authenticateToken, requireAdmin, (req, res) => {
  const { currentRank, revealedRank, prediction, aceRule = 'HIGHEST', tieRule = 'LOSE' } = req.body;

  function toVal(r) {
    if (r === 'A') return aceRule === 'HIGHEST' ? 14 : 1;
    if (r === 'K') return 13;
    if (r === 'Q') return 12;
    if (r === 'J') return 11;
    return parseInt(r, 10);
  }

  const cVal = toVal(currentRank);
  const rVal = toVal(revealedRank);

  let result = 'LOSS';
  if (cVal === rVal) {
    result = tieRule === 'WIN' ? 'WIN' : (tieRule === 'PUSH' ? 'PUSH' : 'LOSS');
  } else if (prediction === 'HIGHER' && rVal > cVal) {
    result = 'WIN';
  } else if (prediction === 'LOWER' && rVal < cVal) {
    result = 'WIN';
  }

  res.json({
    testData: true,
    currentRank,
    revealedRank,
    prediction,
    cVal,
    rVal,
    outcome: result,
    note: 'SANDBOX ONLY. Never written to production user balances.'
  });
});

module.exports = router;
