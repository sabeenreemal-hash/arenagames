// backend/routes/games.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const crypto = require('crypto');
const authenticateToken = require('../middleware/auth');

// Auto-ensure user_game_data table exists with proper constraints
db.run(`
  CREATE TABLE IF NOT EXISTS user_game_data (
    user_id INTEGER NOT NULL,
    game_id TEXT NOT NULL,
    level INTEGER DEFAULT 1,
    data TEXT DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, game_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
  )
`, (err) => {
  if (!err) {
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_game_data ON user_game_data(user_id, game_id);`, () => {});
  }
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

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// 1. Start a verified game session
// ---------------------------------------------------------------------------
router.post('/session/start', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { gameId } = req.body;

  if (!gameId) {
    return res.status(400).json({ error: 'Game ID is required' });
  }

  db.get('SELECT * FROM games WHERE id = ? AND is_enabled = 1', [gameId], (err, game) => {
    if (err || !game) {
      console.error(`[SESSION START REJECTED] Game '${gameId}' is not registered in games table or is disabled.`);
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
// 2. Settle match rewards & automatically advance daily streak + progress
// ---------------------------------------------------------------------------
router.post('/session/end', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { sessionId, gameId, score, moves, level } = req.body;

  if (!sessionId || !gameId || score === undefined) {
    return res.status(400).json({ error: 'Invalid match completion payload' });
  }

  // Authorized game titles
  const allowedGames = [
    'color_tap',
    'mines',
    'tictactoe_1v1',
    'rps_1v1',
    'dot_connect',
    'memory_match',
    'memoryMatch',
  ];

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

          // Extract completed level from body or action audit moves
          let wonLevel = parseInt(level, 10);
          if (isNaN(wonLevel) && Array.isArray(moves)) {
            for (const move of moves) {
              const match = String(move).match(/LEVEL_WON:(?:lvl_)?(\d+)/i);
              if (match) {
                wonLevel = parseInt(match[1], 10);
                break;
              }
            }
          }

          // Fetch user profile to calculate streak progress & check referral
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
              currentStreak = 0;
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

              if (pointsEarned > 0) {
                // Credit user earnings
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

                // --- 6. Referral Commission (10%) ---
                if (user.referred_by_id) {
                  const commission = Math.floor(pointsEarned * 0.10);
                  if (commission > 0) {
                    // Credit referrer
                    db.run(
                      `UPDATE users 
                       SET balance = balance + ?, 
                           total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
                       WHERE id = ?`,
                      [commission, commission, user.referred_by_id]
                    );

                    // Insert referral commission record
                    const referralTxRef = `USER_${userId}_GAME_${sessionId}`;
                    db.run(
                      `INSERT INTO transactions (user_id, type, amount, reference_id) 
                       VALUES (?, 'REFERRAL_COMMISSION', ?, ?)`,
                      [user.referred_by_id, commission, referralTxRef]
                    );

                    console.log(`🤝 [REFERRAL COMMISSION] +${commission} coins given to Referrer ID ${user.referred_by_id} from User ${userId}`);
                  }
                }
              }

              // Auto-advance level in user_game_data if wonLevel is verified
              if (!isNaN(wonLevel) && wonLevel >= 1) {
                const nextUnlocked = wonLevel + 1;
                db.run(
                  `UPDATE user_game_data 
                   SET level = MAX(level, ?), updated_at = CURRENT_TIMESTAMP 
                   WHERE user_id = ? AND game_id = ?`,
                  [nextUnlocked, userId, gameId]
                );
              }

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
// 3. Universal Cloud Progress API (GET /api/games/:gameId/progress)
// ---------------------------------------------------------------------------
router.get('/:gameId/progress', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const gameId = req.params.gameId;

  db.get(
    'SELECT level, data FROM user_game_data WHERE user_id = ? AND game_id = ?',
    [userId, gameId],
    (err, row) => {
      if (err) {
        console.error(`[PROGRESS GET ERROR] User: ${userId}, Game: ${gameId}:`, err.message);
        return res.status(500).json({ error: 'Failed to fetch game progress' });
      }

      if (!row) {
        console.log(`[PROGRESS GET] User: ${userId}, Game: ${gameId} -> No progress found. Initializing Level 1.`);
        return res.json({ success: true, level: 1, data: null });
      }

      let parsedData = {};
      try {
        parsedData = JSON.parse(row.data || '{}');
      } catch (_) {}

      // Guarantee consistent level fields
      const currentLevel = Math.max(row.level || 1, parsedData.level || 1, parsedData.unlockedLevel || 1);
      parsedData.level = currentLevel;
      parsedData.unlockedLevel = currentLevel;

      console.log(`📖 [PROGRESS GET] User: ${userId}, Game: ${gameId}, Restored Level: ${currentLevel}`);

      res.json({
        success: true,
        level: currentLevel,
        data: parsedData,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Universal Cloud Progress Sync (POST /api/games/:gameId/progress)
// ---------------------------------------------------------------------------
router.post('/:gameId/progress', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const gameId = req.params.gameId;

  // Flexible payload parsing
  const rawPayload = req.body.data || req.body || {};
  let incomingData = {};
  if (typeof rawPayload === 'string') {
    try {
      incomingData = JSON.parse(rawPayload);
    } catch (_) {
      incomingData = {};
    }
  } else {
    incomingData = { ...rawPayload };
  }

  const rawLevel =
    incomingData.level ??
    incomingData.unlockedLevel ??
    incomingData.unlocked_level ??
    req.body.level ??
    1;

  const targetLevel = Math.max(1, parseInt(rawLevel, 10) || 1);

  // Fetch existing data first to merge seamlessly without overwriting
  db.get(
    'SELECT level, data FROM user_game_data WHERE user_id = ? AND game_id = ?',
    [userId, gameId],
    (err, existing) => {
      if (err) {
        console.error('[Progress Fetch Error]:', err.message);
        return res.status(500).json({ error: 'Database check failed' });
      }

      let existingData = {};
      let highestLevel = targetLevel;

      if (existing) {
        try {
          existingData = JSON.parse(existing.data || '{}');
        } catch (_) {}
        highestLevel = Math.max(existing.level || 1, targetLevel);
      }

      // Merge existing data with incoming data so inventory & stars are preserved
      const mergedData = {
        ...existingData,
        ...incomingData,
        level: highestLevel,
        unlockedLevel: highestLevel,
      };

      const dataJson = JSON.stringify(mergedData);

      if (existing) {
        db.run(
          `UPDATE user_game_data 
           SET level = ?, data = ?, updated_at = CURRENT_TIMESTAMP 
           WHERE user_id = ? AND game_id = ?`,
          [highestLevel, dataJson, userId, gameId],
          (updateErr) => {
            if (updateErr) {
              console.error('[Progress Update Error]:', updateErr.message);
              return res.status(500).json({ error: 'Failed to update progress' });
            }
            console.log(`💾 [PROGRESS UPDATED] User: ${userId}, Game: ${gameId}, Level: ${highestLevel}`);
            res.json({ success: true, level: highestLevel });
          }
        );
      } else {
        db.run(
          `INSERT INTO user_game_data (user_id, game_id, level, data, updated_at) 
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [userId, gameId, highestLevel, dataJson],
          (insertErr) => {
            if (insertErr) {
              console.error('[Progress Insert Error]:', insertErr.message);
              return res.status(500).json({ error: 'Failed to insert progress' });
            }
            console.log(`💾 [PROGRESS CREATED] User: ${userId}, Game: ${gameId}, Level: ${highestLevel}`);
            res.json({ success: true, level: highestLevel });
          }
        );
      }
    }
  );
});

module.exports = router;
