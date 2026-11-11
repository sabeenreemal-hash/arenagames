// backend/routes/memoryMatch.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');
const { creditReferralCommission } = require('../services/referralService');

// ---------------------------------------------------------------------------
// 1. Fetch User Game State & Progress
// ---------------------------------------------------------------------------
router.get('/progress', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.get(
    'SELECT * FROM memory_match_user_progress WHERE user_id = ?',
    [userId],
    (err, progress) => {
      if (err) {
        console.error('[Memory Match GET Error]:', err);
        return res.status(500).json({ error: 'Failed to fetch progress' });
      }

      if (!progress) {
        // Initialize new user progress
        const defaultState = {
          unlocked_level: 1,
          level_stars: '{}',
          level_coins: '{}',
          peek_count: 2,
          hint_count: 2,
          moves_count: 2,
          shuffle_count: 2,
          daily_cooldown_until: 0,
          daily_locked_level: 0
        };

        db.run(
          `INSERT INTO memory_match_user_progress 
           (user_id, unlocked_level, level_stars, level_coins, peek_count, hint_count, moves_count, shuffle_count) 
           VALUES (?, 1, '{}', '{}', 2, 2, 2, 2)`,
          [userId],
          (insertErr) => {
            if (insertErr) return res.status(500).json({ error: 'Init failed' });
            return res.json({
              success: true,
              data: {
                unlockedLevel: 1,
                stars: {},
                coins: {},
                powerUps: { peek: 2, hint: 2, moves: 2, shuffle: 2 },
                dailyCooldownUntil: 0,
                dailyLockedLevel: 0
              }
            });
          }
        );
      } else {
        return res.json({
          success: true,
          data: {
            unlockedLevel: progress.unlocked_level || 1,
            stars: JSON.parse(progress.level_stars || '{}'),
            coins: JSON.parse(progress.level_coins || '{}'),
            powerUps: {
              peek: progress.peek_count ?? 2,
              hint: progress.hint_count ?? 2,
              moves: progress.moves_count ?? 2,
              shuffle: progress.shuffle_count ?? 2
            },
            dailyCooldownUntil: progress.daily_cooldown_until || 0,
            dailyLockedLevel: progress.daily_locked_level || 0
          }
        });
      }
    }
  );
});

// ---------------------------------------------------------------------------
// 2. Submit Level Completion & Directly Credit User's Arena Wallet
// ---------------------------------------------------------------------------
router.post('/complete-level', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { level, stars, movesUsed, totalMoves } = req.body;

  const parsedLevel = parseInt(level, 10);
  const parsedStars = parseInt(stars, 10);

  if (!parsedLevel || parsedStars < 1 || parsedStars > 3) {
    return res.status(400).json({ error: 'Invalid level or stars' });
  }

  // Calculate Reward: 3 Stars = 5 Coins, 2 Stars = 3 Coins, 1 Star = 1 Coin
  let earnedCoins = 1;
  if (parsedStars === 3) earnedCoins = 5;
  else if (parsedStars === 2) earnedCoins = 3;

  db.get('SELECT * FROM memory_match_user_progress WHERE user_id = ?', [userId], (err, progress) => {
    if (err) return res.status(500).json({ error: 'DB Error' });

    let starsMap = {};
    let coinsMap = {};
    let unlockedLevel = 1;
    let cooldownUntil = 0;
    let lockedLevel = 0;

    if (progress) {
      try {
        starsMap = JSON.parse(progress.level_stars || '{}');
        coinsMap = JSON.parse(progress.level_coins || '{}');
      } catch (_) {}
      unlockedLevel = progress.unlocked_level || 1;
      cooldownUntil = progress.daily_cooldown_until || 0;
      lockedLevel = progress.daily_locked_level || 0;
    }

    // Check if level was already rewarded previously (prevent infinite coin exploit)
    const alreadyRewarded = coinsMap[parsedLevel.toString()] !== undefined;
    const coinsToCredit = alreadyRewarded ? 0 : earnedCoins;

    // Update stars if new record
    if (!starsMap[parsedLevel.toString()] || parsedStars > starsMap[parsedLevel.toString()]) {
      starsMap[parsedLevel.toString()] = parsedStars;
    }

    if (!alreadyRewarded) {
      coinsMap[parsedLevel.toString()] = coinsToCredit;
    }

    // Advance unlocked level
    if (parsedLevel >= unlockedLevel) {
      unlockedLevel = parsedLevel + 1;
    }

    // 80-Level Daily Tier Gate
    if (parsedLevel % 80 === 0) {
      const now = new Date();
      // Set cooldown until next midnight
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
      cooldownUntil = nextMidnight.getTime();
      lockedLevel = parsedLevel;
    }

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      // 1. Update Progress Table
      db.run(
        `INSERT INTO memory_match_user_progress 
         (user_id, unlocked_level, level_stars, level_coins, daily_cooldown_until, daily_locked_level, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET 
           unlocked_level = excluded.unlocked_level,
           level_stars = excluded.level_stars,
           level_coins = excluded.level_coins,
           daily_cooldown_until = excluded.daily_cooldown_until,
           daily_locked_level = excluded.daily_locked_level,
           updated_at = CURRENT_TIMESTAMP`,
        [
          userId,
          unlockedLevel,
          JSON.stringify(starsMap),
          JSON.stringify(coinsMap),
          cooldownUntil,
          lockedLevel
        ]
      );

      // 2. Add Coins directly into users.balance and transactions table
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
           VALUES (?, 'GAME_REWARD', ?, ?)`,
          [userId, coinsToCredit, `MEMORY_MATCH_LVL_${parsedLevel}`]
        );
      }

      db.run('COMMIT', (commitErr) => {
        if (commitErr) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Failed to record level completion' });
        }

        // Referral commission (10%)
        if (coinsToCredit > 0) {
          try {
            creditReferralCommission(userId, coinsToCredit, 'GAME_REWARD', `MEMORY_MATCH_LVL_${parsedLevel}`, 0.10);
          } catch (_) {}
        }

        return res.json({
          success: true,
          coinsCredited: coinsToCredit,
          alreadyRewarded: alreadyRewarded,
          unlockedLevel: unlockedLevel,
          dailyCooldownUntil: cooldownUntil,
          dailyLockedLevel: lockedLevel
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Unlock Next 5 Levels (Rewarded Ad)
// ---------------------------------------------------------------------------
router.post('/unlock-levels', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const count = parseInt(req.body.count || 5, 10);

  db.get('SELECT unlocked_level FROM memory_match_user_progress WHERE user_id = ?', [userId], (err, row) => {
    const current = (row && row.unlocked_level) ? row.unlocked_level : 1;
    const newLevel = current + count;

    db.run(
      `INSERT INTO memory_match_user_progress (user_id, unlocked_level, updated_at) 
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET unlocked_level = ?, updated_at = CURRENT_TIMESTAMP`,
      [userId, newLevel, newLevel],
      (updateErr) => {
        if (updateErr) return res.status(500).json({ error: 'Failed to unlock levels' });
        res.json({ success: true, unlockedLevel: newLevel });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Update Power-Ups (Consume or Refill)
// ---------------------------------------------------------------------------
router.post('/update-powerups', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { peek, hint, moves, shuffle } = req.body;

  db.run(
    `UPDATE memory_match_user_progress SET 
       peek_count = COALESCE(?, peek_count),
       hint_count = COALESCE(?, hint_count),
       moves_count = COALESCE(?, moves_count),
       shuffle_count = COALESCE(?, shuffle_count),
       updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
    [peek, hint, moves, shuffle, userId],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update power-ups' });
      res.json({ success: true });
    }
  );
});

module.exports = router;
