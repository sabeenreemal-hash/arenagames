// backend/routes/games.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const crypto = require('crypto');
const authenticateToken = require('../middleware/auth');

// Auto-create user_game_data table if not exists
db.run(`
  CREATE TABLE IF NOT EXISTS user_game_data (
    user_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, game_id)
  )
`, (err) => {
  if (err) console.error("[DB ERROR] Creating user_game_data table failed:", err);
  else console.log("[DB SUCCESS] user_game_data table ready.");
});

// Helper to safely extract user ID from any JWT token format
function getUserIdFromReq(req) {
  if (!req.user) return null;
  return req.user.id || req.user.userId || req.user._id || req.user.sub;
}

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
    if (streakDays >= stone.days) {
      return stone.name;
    }
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
// 1. GET User Game Progress (GET /api/games/:gameId/progress)
// ---------------------------------------------------------------------------
router.get('/:gameId/progress', authenticateToken, (req, res) => {
  const userId = getUserIdFromReq(req);
  const { gameId } = req.params;

  console.log(`[PROGRESS GET] User: ${userId}, Game: ${gameId}`);

  if (!userId || !gameId) {
    return res.status(400).json({ success: false, error: 'User ID and Game ID are required' });
  }

  db.get(
    'SELECT data FROM user_game_data WHERE user_id = ? AND game_id = ?',
    [userId, gameId],
    (err, row) => {
      if (err) {
        console.error('[DB ERROR] Fetching game progress:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch game progress' });
      }

      if (row && row.data) {
        try {
          const parsed = JSON.parse(row.data);
          console.log(`[PROGRESS GET FOUND] Level: ${parsed.level || 1}`);
          return res.json({ success: true, data: parsed });
        } catch (parseErr) {
          return res.json({ success: true, data: null });
        }
      }

      return res.json({ success: true, data: null });
    }
  );
});

// ---------------------------------------------------------------------------
// 2. POST Save User Game Progress (POST /api/games/:gameId/progress)
// ---------------------------------------------------------------------------
router.post('/:gameId/progress', authenticateToken, (req, res) => {
  const userId = getUserIdFromReq(req);
  const { gameId } = req.params;
  const newData = req.body.data || {};

  console.log(`[PROGRESS SAVE] User: ${userId}, Game: ${gameId}, Data:`, newData);

  if (!userId || !gameId) {
    return res.status(400).json({ success: false, error: 'User ID and Game ID are required' });
  }

  db.get(
    'SELECT data FROM user_game_data WHERE user_id = ? AND game_id = ?',
    [userId, gameId],
    (err, existingRow) => {
      if (err) {
        console.error('[DB ERROR] Checking existing row:', err);
        return res.status(500).json({ success: false, error: 'Database query failed' });
      }

      let mergedData = newData;
      if (existingRow && existingRow.data) {
        try {
          const oldData = JSON.parse(existingRow.data);
          mergedData = { ...oldData, ...newData };
          if (oldData.level !== undefined && newData.level !== undefined) {
            mergedData.level = Math.max(Number(oldData.level), Number(newData.level));
          }
        } catch (e) {
          mergedData = newData;
        }
      }

      const serializedData = JSON.stringify(mergedData);

      // INSERT OR REPLACE works universally on all SQLite versions
      db.run(
        `INSERT OR REPLACE INTO user_game_data (user_id, game_id, data, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        [userId, gameId, serializedData],
        (insertErr) => {
          if (insertErr) {
            console.error('[DB ERROR] Saving progress:', insertErr);
            return res.status(500).json({ success: false, error: 'Failed to save game progress' });
          }

          console.log(`[PROGRESS SAVED SUCCESS] User: ${userId}, Level: ${mergedData.level}`);
          return res.json({ success: true, data: mergedData });
        }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Start Game Session (POST /api/games/session/start)
// ---------------------------------------------------------------------------
router.post('/session/start', authenticateToken, (req, res) => {
  const userId = getUserIdFromReq(req);
  const { gameId } = req.body;

  if (!userId || !gameId) {
    return res.status(400).json({ error: 'User ID and Game ID are required' });
  }

  db.get('SELECT * FROM games WHERE id = ? AND is_enabled = 1', [gameId], (err, game) => {
    if (err || !game) return res.status(404).json({ error: 'Game not registered or offline' });

    const sessionId = crypto.randomUUID();
    db.run(
      `INSERT INTO game_sessions (id, user_id, game_id, status) VALUES (?, ?, ?, 'STARTED')`,
      [sessionId, userId, gameId],
      (err) => {
        if (err) return res.status(500).json({ error: 'Failed to establish verified session' });
        res.json({ sessionId });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 4. End Game Session & Credit Rewards (POST /api/games/session/end)
// ---------------------------------------------------------------------------
router.post('/session/end', authenticateToken, (req, res) => {
  const userId = getUserIdFromReq(req);
  const { sessionId, gameId, score, moves } = req.body;

  if (!sessionId || !gameId || score === undefined || !moves) {
    return res.status(400).json({ error: 'Invalid completion request payload' });
  }

  db.get(
    `SELECT gs.*, g.max_daily_reward, g.reward_multiplier 
     FROM game_sessions gs 
     JOIN games g ON gs.game_id = g.id 
     WHERE gs.id = ? AND gs.user_id = ? AND gs.game_id = ? AND gs.status = 'STARTED'`,
    [sessionId, userId, gameId],
    (err, session) => {
      if (err || !session) {
        return res.status(400).json({ error: 'Verification session expired or invalid' });
      }

      const duration = (new Date() - new Date(session.start_time)) / 1000;

      if (duration < 3.0) {
        return res.status(400).json({ error: 'Invalid game duration (Anti-cheat triggered)' });
      }

      db.get(
        `SELECT SUM(amount) as total_today FROM transactions 
         WHERE user_id = ? AND type = 'GAME_REWARD' AND created_at >= date('now')`,
        [userId],
        (err, result) => {
          const todayRewards = result ? result.total_today || 0 : 0;
          if (todayRewards >= session.max_daily_reward) {
            return res.status(400).json({ error: 'Daily reward cap met for this game' });
          }

          const pointsEarned = Math.min(
            Math.floor(score * session.reward_multiplier),
            session.max_daily_reward - todayRewards
          );

          if (pointsEarned <= 0) {
            return res.json({ success: true, earned: 0, message: 'Daily limit reached' });
          }

          db.get('SELECT * FROM users WHERE id = ?', [userId], (userErr, user) => {
            if (userErr || !user) {
              return res.status(404).json({ error: 'User record missing' });
            }

            const today = getTodayStr();
            const yesterday = getYesterdayStr();

            let newEligible = (user.last_eligible_date === today)
              ? (user.eligible_daily_coins + pointsEarned)
              : pointsEarned;

            let currentStreak = user.current_streak || 0;
            let highestStreak = user.highest_streak || 0;
            let lastStreakDate = user.last_streak_date || '';
            let streakActivatedNow = false;

            if (user.last_eligible_date !== today && lastStreakDate !== yesterday && lastStreakDate !== today && currentStreak > 0) {
              currentStreak = 0;
            }

            if (newEligible >= 100 && lastStreakDate !== today) {
              currentStreak += 1;
              lastStreakDate = today;
              streakActivatedNow = true;

              if (currentStreak > highestStreak) {
                highestStreak = currentStreak;
              }
            }

            const currentStone = calculateStoneBadge(currentStreak);

            db.serialize(() => {
              db.run('BEGIN TRANSACTION');

              db.run(
                `UPDATE game_sessions SET status = 'COMPLETED', end_time = CURRENT_TIMESTAMP WHERE id = ?`,
                [sessionId]
              );

              db.run(
                `UPDATE users SET 
                  balance = balance + ?, 
                  total_coins_earned = total_coins_earned + ?, 
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

              if (user.referred_by_id) {
                const commission = Math.floor(pointsEarned * 0.1);
                if (commission > 0) {
                  db.run(
                    `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
                    [commission, commission, user.referred_by_id]
                  );
                  db.run(
                    `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'REFERRAL_COMMISSION', ?, ?)`,
                    [user.referred_by_id, commission, sessionId]
                  );
                }
              }

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to record match rewards' });
                }

                res.json({
                  success: true,
                  earned: pointsEarned,
                  eligibleToday: newEligible,
                  currentStreak,
                  currentStone,
                  streakActivatedNow,
                  message: `+${pointsEarned} Coins added to wallet!`
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