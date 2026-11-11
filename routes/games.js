// backend/routes/games.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const crypto = require('crypto');
const authenticateToken = require('../middleware/auth');

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

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// 1. Start a verified game session (color_tap, tictactoe_1v1, rps_1v1, mines, memory_match)
// ---------------------------------------------------------------------------
router.post('/session/start', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { gameId } = req.body;

  if (!gameId) {
    return res.status(400).json({ error: 'Game ID is required' });
  }

  db.get('SELECT * FROM games WHERE id = ? AND is_enabled = 1', [gameId], (err, game) => {
    if (err || !game) {
      console.error(`[SESSION START REJECTED] Game '${gameId}' is not registered in the games table or is disabled.`);
      return res.status(404).json({ error: `Game ${gameId} not registered or offline` });
    }

    const sessionId = crypto.randomUUID();
    db.run(
      `INSERT INTO game_sessions (id, user_id, game_id, status) VALUES (?, ?, ?, 'STARTED')`,
      [sessionId, userId, gameId],
      (err) => {
        if (err) return res.status(500).json({ error: 'Failed to establish session' });
        console.log(`[SESSION STARTED] User: ${userId}, Game: ${gameId}, Session: ${sessionId}`);
        res.json({ sessionId });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Settle match rewards & automatically advance daily streak
// ---------------------------------------------------------------------------
router.post('/session/end', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { sessionId, gameId, score, moves } = req.body;

  if (!sessionId || !gameId || score === undefined) {
    return res.status(400).json({ error: 'Invalid match completion payload' });
  }

  // ✅ Authorized game titles (Added 'memory_match')
  const allowedGames = ['color_tap', 'mines', 'tictactoe_1v1', 'rps_1v1', 'dot_connect', 'memory_match'];
  if (!allowedGames.includes(gameId)) {
    console.error(`[REWARD REJECTED] Unauthorized game title: ${gameId}`);
    return res.status(400).json({ error: 'Unauthorized game title' });
  }

  db.get(
    `SELECT gs.*, g.max_daily_reward, g.reward_multiplier 
     FROM game_sessions gs 
     JOIN games g ON gs.game_id = g.id 
     WHERE gs.id = ? AND gs.user_id = ? AND gs.game_id = ? AND gs.status = 'STARTED'`,
    [sessionId, userId, gameId],
    (err, session) => {
      if (err || !session) {
        console.error(`[REWARD REJECTED] Invalid or expired session '${sessionId}' for game '${gameId}'.`);
        return res.status(400).json({ error: 'Session expired or invalid' });
      }

      // Check user daily reward cap for this specific game
      db.get(
        `SELECT SUM(amount) as total_today FROM transactions 
         WHERE user_id = ? AND type = 'GAME_REWARD' AND reference_id LIKE 'GAME_' || ? || '_%' AND created_at >= date('now')`,
        [userId, gameId],
        (err, result) => {
          const todayRewards = (result && result.total_today) || 0;
          if (todayRewards >= session.max_daily_reward) {
            return res.status(400).json({ error: 'Daily reward cap reached for this title' });
          }

          const multiplier = session.reward_multiplier || 1.0;
          const pointsEarned = Math.min(
            Math.floor(score * multiplier),
            session.max_daily_reward - todayRewards
          );

          if (pointsEarned <= 0) {
            return res.json({ success: true, earned: 0, message: 'No coins awarded or cap met' });
          }

          // Fetch user profile to calculate streak progress
          db.get('SELECT * FROM users WHERE id = ?', [userId], (userErr, user) => {
            if (userErr || !user) {
              return res.status(404).json({ error: 'User not found' });
            }

            const today = getTodayStr();
            const yesterday = getYesterdayStr();

            let currentStreak = user.current_streak || 0;
            let highestStreak = user.highest_streak || 0;
            let lastStreakDate = user.last_streak_date || '';
            let streakActivatedNow = false;

            // 1. Add game win coins to today's streak eligibility
            let newEligible = (user.last_eligible_date === today)
              ? ((user.eligible_daily_coins || 0) + pointsEarned)
              : pointsEarned;

            // 2. Check if streak broke yesterday
            if (user.last_eligible_date !== today && lastStreakDate !== yesterday && lastStreakDate !== today && currentStreak > 0) {
              currentStreak = 0; // Streak broken
            }

            // 3. Milestone check: Crossing >= 100 coins activates streak
            if (newEligible >= 100 && lastStreakDate !== today) {
              currentStreak += 1;
              lastStreakDate = today;
              streakActivatedNow = true;

              if (currentStreak > highestStreak) {
                highestStreak = currentStreak;
              }
            }

            // 4. Recalculate Active Stone Badge
            const currentStone = calculateStoneBadge(currentStreak);

            // 5. Database transaction write: credits wallet and logs history
            db.serialize(() => {
              db.run('BEGIN TRANSACTION');

              db.run(
                `UPDATE game_sessions SET status = 'COMPLETED', end_time = CURRENT_TIMESTAMP WHERE id = ?`,
                [sessionId]
              );

              db.run(
                `UPDATE users SET 
                  balance = balance + ?, 
                  total_coins_earned = COALESCE(total_coins_earned, 0) + ?, 
                  eligible_daily_coins = ?, 
                  last_eligible_date = ?, 
                  current_streak = ?, 
                  highest_streak = ?, 
                  last_streak_date = ?, 
                  current_stone = ? 
                 WHERE id = ?`,
                [
                  pointsEarned,
                  pointsEarned,
                  newEligible,
                  today,
                  currentStreak,
                  highestStreak,
                  lastStreakDate,
                  currentStone,
                  userId,
                ]
              );

              const refId = `GAME_${gameId}_${sessionId}`;
              db.run(
                `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'GAME_REWARD', ?, ?)`,
                [userId, pointsEarned, refId]
              );

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to record match reward' });
                }

                console.log(`🎉 [MATCH WIN] User ${userId} won +${pointsEarned} coins in ${gameId}. Streak: ${currentStreak}d`);

                res.json({
                  success: true,
                  earned: pointsEarned,
                  dailyEligibleCoins: newEligible,
                  currentStreak,
                  currentStone,
                  streakActivatedNow,
                  message: streakActivatedNow
                    ? `🔥 Streak Protected! Current Streak: ${currentStreak} Days`
                    : `+${pointsEarned} Coins added to your wallet!`,
                });
              });
            });
          });
        }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Universal Cloud Progress API (Used by ApiService.fetchGameProgress)
// ---------------------------------------------------------------------------
router.get('/:gameId/progress', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const gameId = req.params.gameId;

  db.get(
    'SELECT level, data FROM user_game_data WHERE user_id = ? AND game_id = ?',
    [userId, gameId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to fetch game progress' });
      }

      if (!row) {
        return res.json({ success: true, level: 1, data: null });
      }

      let parsedData = {};
      try {
        parsedData = JSON.parse(row.data || '{}');
      } catch (_) {}

      res.json({
        success: true,
        level: row.level || 1,
        data: parsedData,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Universal Cloud Progress Sync (Used by ApiService.syncGameProgress)
// ---------------------------------------------------------------------------
router.post('/:gameId/progress', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const gameId = req.params.gameId;
  const payload = req.body.data || {};

  const level = parseInt(payload.level || payload.unlockedLevel || 1, 10);
  const dataJson = JSON.stringify(payload);

  db.run(
    `INSERT INTO user_game_data (user_id, game_id, level, data, updated_at) 
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, game_id) DO UPDATE SET 
       level = excluded.level, 
       data = excluded.data, 
       updated_at = CURRENT_TIMESTAMP`,
    [userId, gameId, level, dataJson],
    (err) => {
      if (err) {
        console.error('[Sync Progress Error]:', err.message);
        return res.status(500).json({ error: 'Failed to sync progress' });
      }

      console.log(`💾 [PROGRESS SAVED] User: ${userId}, Game: ${gameId}, Level: ${level}`);
      res.json({ success: true, level });
    }
  );
});

module.exports = router;
