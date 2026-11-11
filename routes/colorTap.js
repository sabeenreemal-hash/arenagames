// backend/routes/colorTap.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

// Helper: Calculate next midnight in epoch ms
function getNextMidnightEpoch() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return nextMidnight.getTime();
}

// ---------------------------------------------------------------------------
// 1. GET User Progress & Current Balance
// ---------------------------------------------------------------------------
router.get('/progress', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.get(
    'SELECT * FROM color_tap_user_progress WHERE user_id = ?',
    [userId],
    (err, row) => {
      if (err) {
        console.error('[ColorTap Progress GET Error]:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve progress' });
      }

      // If user has no progress record yet, initialize one
      if (!row) {
        const defaultStars = '{}';
        const defaultScores = '{}';
        const defaultCoins = '{}';

        db.run(
          `INSERT INTO color_tap_user_progress 
           (user_id, unlocked_level, level_stars, level_scores, level_coins, freeze_count, bomb_count, life_count, hint_count, daily_cooldown_until) 
           VALUES (?, 1, ?, ?, ?, 3, 2, 3, 3, 0)`,
          [userId, defaultStars, defaultScores, defaultCoins],
          (insertErr) => {
            if (insertErr) {
              return res.status(500).json({ error: 'Failed to initialize progress' });
            }

            return res.json({
              success: true,
              progress: {
                unlockedLevel: 1,
                levelStars: {},
                levelScores: {},
                levelCoins: {},
                freezeCount: 3,
                bombCount: 2,
                lifeCount: 3,
                hintCount: 3,
                dailyCooldownUntil: 0,
              },
            });
          }
        );
        return;
      }

      // Safely parse stored JSON
      let stars = {};
      let scores = {};
      let coins = {};
      try { stars = JSON.parse(row.level_stars || '{}'); } catch (_) {}
      try { scores = JSON.parse(row.level_scores || '{}'); } catch (_) {}
      try { coins = JSON.parse(row.level_coins || '{}'); } catch (_) {}

      res.json({
        success: true,
        progress: {
          unlockedLevel: row.unlocked_level || 1,
          levelStars: stars,
          levelScores: scores,
          levelCoins: coins,
          freezeCount: row.freeze_count ?? 3,
          bombCount: row.bomb_count ?? 2,
          lifeCount: row.life_count ?? 3,
          hintCount: row.hint_count ?? 3,
          dailyCooldownUntil: row.daily_cooldown_until || 0,
        },
      });
    }
  );
});

// ---------------------------------------------------------------------------
// 2. POST Complete Level -> Add Coins to Wallet + Update Progress
// ---------------------------------------------------------------------------
router.post('/complete-level', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { level, score, stars, wrongTaps } = req.body;

  const lvl = parseInt(level, 10);
  const earnedStars = parseInt(stars, 10);
  const earnedScore = parseInt(score, 10) || 0;
  const mistakes = parseInt(wrongTaps, 10) || 0;

  if (isNaN(lvl) || lvl < 1 || isNaN(earnedStars) || earnedStars < 1 || earnedStars > 3) {
    return res.status(400).json({ error: 'Invalid level or stars parameters' });
  }

  db.get('SELECT * FROM color_tap_user_progress WHERE user_id = ?', [userId], (err, progress) => {
    if (err) {
      return res.status(500).json({ error: 'Database error reading progress' });
    }

    const now = Date.now();

    // Check if 80-level daily cooldown is still active
    if (progress && progress.daily_cooldown_until && now < progress.daily_cooldown_until) {
      return res.status(403).json({
        error: 'Daily limit active. Next levels unlock tomorrow.',
        dailyCooldownUntil: progress.daily_cooldown_until,
      });
    }

    let starsMap = {};
    let scoresMap = {};
    let coinsMap = {};

    if (progress) {
      try { starsMap = JSON.parse(progress.level_stars || '{}'); } catch (_) {}
      try { scoresMap = JSON.parse(progress.level_scores || '{}'); } catch (_) {}
      try { coinsMap = JSON.parse(progress.level_coins || '{}'); } catch (_) {}
    }

    // Formula: 1 Star = 1 Coin, 2 Stars = 3 Coins, 3 Stars = 5 Coins
    let baseCoins = 1;
    if (earnedStars === 2) baseCoins = 3;
    if (earnedStars === 3) baseCoins = 5;

    // Deduct 0.5 coin penalty per wrong tap
    const computedCoins = Math.max(0, baseCoins - (mistakes * 0.5));

    // Prevent duplicate reward abuse on level replay (only award net new coins)
    const previouslyClaimed = coinsMap[lvl] || 0;
    const netNewCoinsFloat = Math.max(0, computedCoins - previouslyClaimed);
    const coinsToAdd = Math.round(netNewCoinsFloat); // Rounded for integer balance wallet

    // Update level records
    if ((starsMap[lvl] || 0) < earnedStars) starsMap[lvl] = earnedStars;
    if ((scoresMap[lvl] || 0) < earnedScore) scoresMap[lvl] = earnedScore;
    if (computedCoins > previouslyClaimed) coinsMap[lvl] = computedCoins;

    let currentUnlocked = progress ? (progress.unlocked_level || 1) : 1;
    let newCooldownUntil = progress ? (progress.daily_cooldown_until || 0) : 0;

    // Milestone 1: 80-Level Daily Limit (80, 160, 240...)
    const is80LevelLimit = (lvl % 80 === 0);
    if (is80LevelLimit) {
      newCooldownUntil = getNextMidnightEpoch();
    }

    // Milestone 2: 5-Level Rewarded Ad Gate (5, 10, 15...)
    // If completing level 5, 10, etc., do not auto-increment until ad is watched
    const is5LevelAdGate = (lvl % 5 === 0);

    if (currentUnlocked === lvl && !is5LevelAdGate && !is80LevelLimit) {
      currentUnlocked = lvl + 1;
    }

    const starsJson = JSON.stringify(starsMap);
    const scoresJson = JSON.stringify(scoresMap);
    const coinsJson = JSON.stringify(coinsMap);

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      // 1. Credit wallet balance directly
      if (coinsToAdd > 0) {
        db.run(
          `UPDATE users SET 
             balance = balance + ?, 
             total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
           WHERE id = ?`,
          [coinsToAdd, coinsToAdd, userId]
        );

        // Record official wallet transaction
        const refId = `COLOR_TAP_LVL_${lvl}_${Date.now()}`;
        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) 
           VALUES (?, 'GAME_REWARD', ?, ?)`,
          [userId, coinsToAdd, refId]
        );
      }

      // 2. Persist progress into color_tap_user_progress
      db.run(
        `INSERT INTO color_tap_user_progress 
         (user_id, unlocked_level, level_stars, level_scores, level_coins, daily_cooldown_until, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET 
           unlocked_level = ?, 
           level_stars = ?, 
           level_scores = ?, 
           level_coins = ?, 
           daily_cooldown_until = ?, 
           updated_at = CURRENT_TIMESTAMP`,
        [
          userId, currentUnlocked, starsJson, scoresJson, coinsJson, newCooldownUntil,
          currentUnlocked, starsJson, scoresJson, coinsJson, newCooldownUntil
        ]
      );

      db.run('COMMIT', (commitErr) => {
        if (commitErr) {
          db.run('ROLLBACK');
          console.error('[ColorTap Commit Error]:', commitErr.message);
          return res.status(500).json({ error: 'Failed to commit level reward' });
        }

        // Fetch updated balance to return to Flutter
        db.get('SELECT balance FROM users WHERE id = ?', [userId], (uErr, userRow) => {
          res.json({
            success: true,
            coinsAwarded: coinsToAdd,
            newBalance: userRow ? userRow.balance : 0,
            unlockedLevel: currentUnlocked,
            dailyCooldownUntil: newCooldownUntil,
            isAdGateMilestone: is5LevelAdGate && (currentUnlocked <= lvl),
            isDailyLimitHit: is80LevelLimit,
          });
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. POST Unlock 5-Level Milestone (Called after user watches Rewarded Ad)
// ---------------------------------------------------------------------------
router.post('/unlock-milestone', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { nextLevel } = req.body;
  const targetLevel = parseInt(nextLevel, 10);

  if (isNaN(targetLevel) || targetLevel < 2) {
    return res.status(400).json({ error: 'Invalid target level' });
  }

  db.run(
    `UPDATE color_tap_user_progress 
     SET unlocked_level = ?, updated_at = CURRENT_TIMESTAMP 
     WHERE user_id = ? AND unlocked_level < ?`,
    [targetLevel, userId, targetLevel],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to unlock level' });
      }

      res.json({
        success: true,
        message: `Level ${targetLevel} unlocked successfully!`,
        unlockedLevel: targetLevel,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// 4. POST Save Power-up Inventory
// ---------------------------------------------------------------------------
router.post('/update-powerups', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { freezeCount, bombCount, lifeCount, hintCount } = req.body;

  db.run(
    `UPDATE color_tap_user_progress 
     SET freeze_count = ?, bomb_count = ?, life_count = ?, hint_count = ?, updated_at = CURRENT_TIMESTAMP 
     WHERE user_id = ?`,
    [freezeCount ?? 3, bombCount ?? 2, lifeCount ?? 3, hintCount ?? 3, userId],
    (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update power-ups' });
      res.json({ success: true });
    }
  );
});

module.exports = router;
