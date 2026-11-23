// backend/routes/highLowAdminRoutes.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

function requireAdmin(req, res, next) {
  const userId = req.user.id;
  db.get('SELECT id, username FROM admins WHERE id = ?', [userId], (err, admin) => {
    if (err || !admin) {
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
// 1. DASHBOARD SUMMARY
// ---------------------------------------------------------------------------
router.get('/dashboard', authenticateToken, requireAdmin, (req, res) => {
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
  `;

  db.get(query, (err, stats) => {
    if (err) return res.status(500).json({ error: 'Failed to aggregate dashboard analytics' });

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
// 2. LIVE ACTIVE GAMES
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
// 3. TARGET USER MONITORING
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
// 4. GAME CONFIGURATION (FIXED SYNC)
// ---------------------------------------------------------------------------
router.get('/config', authenticateToken, requireAdmin, (req, res) => {
  db.get("SELECT value FROM app_config WHERE key = 'high_low_config'", (err, row) => {
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
      try {
        const parsed = JSON.parse(row.value);
        config = { ...config, ...parsed };
      } catch (_) {}
    }
    res.json({ config });
  });
});

router.post('/config', authenticateToken, requireAdmin, (req, res) => {
  const incoming = req.body;

  db.get("SELECT value FROM app_config WHERE key = 'high_low_config'", (err, row) => {
    let current = {};
    if (row && row.value) {
      try { current = JSON.parse(row.value); } catch (_) {}
    }

    const entryFee = parseInt(incoming.entryCost ?? current.entryCost ?? 500, 10);
    const startReward = parseInt(incoming.startingReward ?? current.startingReward ?? entryFee, 10);
    const mult = parseFloat(incoming.multiplier ?? current.multiplier ?? 2.0);
    const minWins = parseInt(incoming.minWinsForClaim ?? current.minWinsForClaim ?? 3, 10);
    const ace = incoming.aceRule === 'LOWEST' ? 'LOWEST' : 'HIGHEST';
    const tie = ['WIN', 'PUSH', 'LOSE'].includes(incoming.tieRule) ? incoming.tieRule : 'LOSE';
    const isEnabled = incoming.isEnabled !== false;

    const updated = {
      entryCost: entryFee,
      startingReward: startReward,
      multiplier: mult,
      minWinsForClaim: minWins,
      aceRule: ace,
      tieRule: tie,
      isEnabled: isEnabled,
      version: (current.version || 1) + 1,
      updated_at: new Date().toISOString()
    };

    db.run(
      `INSERT INTO app_config (key, value) VALUES ('high_low_config', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(updated)],
      (saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Config save failed: ' + saveErr.message });
        console.log(`[HL CONFIG SYNCED]`, updated);
        res.json({ success: true, config: updated, message: 'Configuration synchronized successfully' });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 5. CANCEL AND REFUND GAME
// ---------------------------------------------------------------------------
router.post('/game/cancel', authenticateToken, requireAdmin, (req, res) => {
  const { gameId } = req.body;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });

  db.get(`SELECT * FROM high_low_games WHERE id = ? AND status = 'ACTIVE'`, [gameId], (err, game) => {
    if (err || !game) return res.status(400).json({ error: 'Game not active or non-existent' });

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      db.run(`UPDATE high_low_games SET status = 'CANCELLED', completed_at = CURRENT_TIMESTAMP WHERE id = ?`, [gameId]);
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
        res.json({ success: true, message: `Game ${gameId} cancelled and ${game.entry_cost} coins refunded.` });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 6. ISOLATED SANDBOX TESTING
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
    outcome: result
  });
});

module.exports = router;
