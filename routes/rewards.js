// backend/routes/rewards.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const STONE_TIERS = [
  { rank: 7, name: 'RUBY', days: 100, bonus: 500 },
  { rank: 6, name: 'DIAMOND', days: 75, bonus: 400 },
  { rank: 5, name: 'AMETHYST', days: 50, bonus: 300 },
  { rank: 4, name: 'SAPPHIRE', days: 35, bonus: 200 },
  { rank: 3, name: 'JADE', days: 20, bonus: 100 },
  { rank: 2, name: 'QUARTZ', days: 10, bonus: 50 },
  { rank: 1, name: 'AGATE', days: 5, bonus: 20 },
];

function getStoneBadge(streakDays) {
  const days = streakDays || 0;
  for (const stone of STONE_TIERS) {
    if (days >= stone.days) return stone;
  }
  return { rank: 0, name: 'NONE', days: 0, bonus: 0 };
}

function getNextStoneBadge(streakDays) {
  const days = streakDays || 0;
  const reversed = [...STONE_TIERS].reverse();
  for (const stone of reversed) {
    if (days < stone.days) {
      return { ...stone, daysLeft: stone.days - days };
    }
  }
  return null;
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// Evaluate streak resets safely on day changes
function evaluateAndSyncUserStreak(user, callback) {
  const today = getTodayStr();
  const yesterday = getYesterdayStr();

  let current_streak = user.current_streak || 0;
  let highest_streak = user.highest_streak || 0;
  let eligible_daily_coins = user.eligible_daily_coins || 0;
  let last_eligible_date = user.last_eligible_date || '';
  let last_streak_date = user.last_streak_date || '';
  let current_stone = user.current_stone || 'NONE';

  let needsDbUpdate = false;

  // If a new day has arrived, reset today's offerwall counter
  if (last_eligible_date !== today) {
    // If user missed completing 100 coins yesterday, streak resets to 0
    if (last_streak_date !== yesterday && last_streak_date !== today && current_streak > 0) {
      current_streak = 0;
      current_stone = 'NONE';
      needsDbUpdate = true;
    }
    eligible_daily_coins = 0;
    last_eligible_date = today;
    needsDbUpdate = true;
  }

  const activeStone = getStoneBadge(current_streak).name;
  if (current_stone !== activeStone) {
    current_stone = activeStone;
    needsDbUpdate = true;
  }

  if (needsDbUpdate) {
    db.run(
      `UPDATE users SET 
        current_streak = ?, 
        highest_streak = ?, 
        eligible_daily_coins = ?, 
        last_eligible_date = ?, 
        current_stone = ? 
       WHERE id = ?`,
      [current_streak, highest_streak, eligible_daily_coins, last_eligible_date, current_stone, user.id],
      (err) => {
        if (err) {
          console.error('[REWARDS DB ERROR] evaluateAndSyncUserStreak update failed:', err.message);
          return callback(err);
        }
        user.current_streak = current_streak;
        user.eligible_daily_coins = eligible_daily_coins;
        user.last_eligible_date = last_eligible_date;
        user.current_stone = current_stone;
        callback(null, user);
      }
    );
  } else {
    callback(null, user);
  }
}

// ---------------------------------------------------------------------------
// 0. Public Health Test Endpoint
// ---------------------------------------------------------------------------
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Rewards router is working!' });
});

// ---------------------------------------------------------------------------
// 1. GET /api/rewards/status
// Fetches the user's active streak, Stone Badge, and today's Offerwall progress
// ---------------------------------------------------------------------------
router.get('/status', authenticateToken, (req, res) => {
  const userId = req.user && req.user.id ? req.user.id : null;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized: User identity missing' });
  }

  db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
    if (err) {
      console.error('[REWARDS DB ERROR] Failed to query user:', err.message);
      return res.status(500).json({ error: 'Database query failed' });
    }
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    evaluateAndSyncUserStreak(user, (evalErr, updatedUser) => {
      if (evalErr) {
        console.error('[REWARDS ERROR] Streak calculation failed:', evalErr.message);
        return res.status(500).json({ error: 'Streak calculation failed' });
      }

      const currentStreak = updatedUser.current_streak || 0;
      const isStreakProtectedToday = (updatedUser.eligible_daily_coins || 0) >= 100;
      const activeStone = getStoneBadge(currentStreak);
      const nextStone = getNextStoneBadge(currentStreak);

      res.json({
        currentStreak,
        highestStreak: updatedUser.highest_streak || 0,
        currentStone: activeStone.name,
        currentStoneBonus: activeStone.bonus,
        nextStone,
        dailyEligibleCoins: updatedUser.eligible_daily_coins || 0,
        isStreakProtectedToday,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/rewards/leaderboard
// Ranked strictly by lifetime total_coins_earned (no profile pictures)
// ---------------------------------------------------------------------------
router.get('/leaderboard', authenticateToken, (req, res) => {
  const userId = req.user.id;

  const topUsersQuery = `
    SELECT 
      id, 
      username, 
      COALESCE(current_stone, 'NONE') as current_stone, 
      COALESCE(total_coins_earned, 0) as total_coins_earned 
    FROM users 
    WHERE is_banned = 0 
    ORDER BY total_coins_earned DESC, id ASC 
    LIMIT 50
  `;

  const userRankQuery = `
    SELECT 
      (SELECT COUNT(*) FROM users WHERE total_coins_earned > u.total_coins_earned AND is_banned = 0) + 1 AS rank,
      u.username,
      COALESCE(u.current_stone, 'NONE') as current_stone,
      COALESCE(u.total_coins_earned, 0) as total_coins_earned
    FROM users u
    WHERE u.id = ?
  `;

  db.all(topUsersQuery, [], (err, topPlayers) => {
    if (err) {
      console.error('[LEADERBOARD DB ERROR] topUsersQuery failed:', err.message);
      return res.status(500).json({ error: 'Leaderboard lookup failed' });
    }

    db.get(userRankQuery, [userId], (rankErr, userRankData) => {
      if (rankErr || !userRankData) {
        return res.json({
          topPlayers: topPlayers || [],
          userRank: { rank: 1, username: 'Player', stoneBadge: 'NONE', totalCoins: 0 },
        });
      }

      res.json({
        topPlayers: (topPlayers || []).map((p, idx) => ({
          rank: idx + 1,
          userId: p.id,
          username: p.username,
          stoneBadge: p.current_stone || 'NONE',
          totalCoins: p.total_coins_earned || 0,
        })),
        userRank: {
          rank: userRankData.rank || 1,
          username: userRankData.username || 'You',
          stoneBadge: userRankData.current_stone || 'NONE',
          totalCoins: userRankData.total_coins_earned || 0,
        },
      });
    });
  });
});

module.exports = router;
