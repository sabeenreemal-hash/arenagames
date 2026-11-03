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
// 1. Start a verified game session (tictactoe_1v1 or rps_1v1)
// ---------------------------------------------------------------------------
router.post('/session/start', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { gameId } = req.body;

  if (!gameId) {
    return res.status(400).json({ error: 'Game ID is required' });
  }

  db.get('SELECT * FROM games WHERE id = ? AND is_enabled = 1', [gameId], (err, game) => {
    if (err || !game) return res.status(404).json({ error: 'Game not registered or offline' });

    const sessionId = crypto.randomUUID();
    db.run(
      `INSERT INTO game_sessions (id, user_id, game_id, status) VALUES (?, ?, ?, 'STARTED')`,
      [sessionId, userId, gameId],
      (err) => {
        if (err) return res.status(500).json({ error: 'Failed to establish session' });
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

  // Validate allowed game titles
  const allowedGames = ['tictactoe_1v1', 'rps_1v1'];
  if (!allowedGames.includes(gameId)) {
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
        return res.status(400).json({ error: 'Session expired or invalid' });
      }

      // Check user daily reward cap for this specific game
      db.get(
        `SELECT SUM(amount) as total_today FROM transactions 
         WHERE user_id = ? AND type = 'GAME_REWARD' AND created_at >= date('now')`,
        [userId],
        (err, result) => {
          const todayRewards = result.total_today || 0;
          if (todayRewards >= session.max_daily_reward) {
            return res.status(400).json({ error: 'Daily reward cap reached for this title' });
          }

          const pointsEarned = Math.min(
            Math.floor(score * session.reward_multiplier),
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

            // 5. Database transaction write
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

              db.run(
                `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'GAME_REWARD', ?, ?)`,
                [userId, pointsEarned, sessionId]
              );

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to record match reward' });
                }

                console.log(`[MATCH WIN] User ${userId} won +${pointsEarned} coins in ${gameId}. Streak progress: ${newEligible}/100. Current Streak: ${currentStreak}d`);

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

module.exports = router;
