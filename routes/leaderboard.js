// backend/routes/leaderboard.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const WEEKLY_REWARDS = [500, 200, 100]; // 1st, 2nd, 3rd
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let isResetting = false;
let schemaReady = false;

// Promise helpers for clean atomic transactions
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getNextMondayUtc(fromDate = new Date()) {
  const d = new Date(fromDate);
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ...
  const daysUntilMonday = (8 - day) % 7 || 7;
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + daysUntilMonday,
      0,
      0,
      0,
      0
    )
  );
}

// ---------------------------------------------------------------------------
// 1. Auto-Migrate Weekly Leaderboard Schema & Sync Trigger
// ---------------------------------------------------------------------------
function initLeaderboardSchema() {
  db.all('PRAGMA table_info(users)', (err, columns) => {
    if (err || !columns) return;

    const hasWeeklyCoins = columns.some((c) => c.name === 'weekly_coins');

    const setupObjects = () => {
      db.serialize(() => {
        // Auto-sync weekly_coins whenever total_coins_earned increases
        db.run(`
          CREATE TRIGGER IF NOT EXISTS trg_sync_weekly_coins
          AFTER UPDATE OF total_coins_earned ON users
          WHEN NEW.total_coins_earned > COALESCE(OLD.total_coins_earned, 0)
          BEGIN
            UPDATE users
            SET weekly_coins = COALESCE(weekly_coins, 0) + (NEW.total_coins_earned - COALESCE(OLD.total_coins_earned, 0))
            WHERE id = NEW.id;
          END;
        `);

        // Audit log of past weekly winners
        db.run(`
          CREATE TABLE IF NOT EXISTS leaderboard_winners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            week_ending TEXT NOT NULL,
            rank INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            weekly_coins INTEGER NOT NULL,
            reward_coins INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);

        // Initialize next reset timestamp if not already stored
        const initialResetIso = getNextMondayUtc(new Date()).toISOString();
        db.run(
          `INSERT OR IGNORE INTO app_config (key, value) VALUES ('leaderboard_next_reset_at', ?)`,
          [initialResetIso],
          () => {
            schemaReady = true;
          }
        );
      });
    };

    if (!hasWeeklyCoins) {
      db.run(
        'ALTER TABLE users ADD COLUMN weekly_coins INTEGER DEFAULT 0',
        (alterErr) => {
          if (alterErr) {
            console.error('[Leaderboard Migration Error]:', alterErr.message);
            return;
          }
          setupObjects();
        }
      );
    } else {
      setupObjects();
    }
  });
}

initLeaderboardSchema();

// ---------------------------------------------------------------------------
// 2. Weekly Reset & Top 3 Reward Payout (Atomic SQLite Transaction)
// ---------------------------------------------------------------------------
async function checkAndProcessWeeklyReset() {
  if (!schemaReady || isResetting) return false;

  try {
    const cfg = await dbGet(
      "SELECT value FROM app_config WHERE key = 'leaderboard_next_reset_at'"
    );
    if (!cfg || !cfg.value) return false;

    const resetTime = new Date(cfg.value).getTime();
    const now = Date.now();
    if (isNaN(resetTime) || now < resetTime) return false;

    isResetting = true;

    let nextResetDate = new Date(resetTime + ONE_WEEK_MS);
    while (nextResetDate.getTime() <= now) {
      nextResetDate = new Date(nextResetDate.getTime() + ONE_WEEK_MS);
    }
    const nextResetIso = nextResetDate.toISOString();
    const weekEndingStr = new Date(resetTime).toISOString();

    await dbRun('BEGIN IMMEDIATE TRANSACTION');

    try {
      // Find Top 3 active non-banned users with weekly_coins > 0
      const winners = await dbAll(
        `SELECT id, username, COALESCE(weekly_coins, 0) AS weekly_coins
         FROM users
         WHERE COALESCE(is_banned, 0) = 0
           AND COALESCE(weekly_coins, 0) > 0
         ORDER BY weekly_coins DESC, id ASC
         LIMIT 3`
      );

      // Pay rewards into real wallet (`balance` & `total_coins_earned`)
      for (let i = 0; i < winners.length; i++) {
        const winner = winners[i];
        const rank = i + 1;
        const reward = WEEKLY_REWARDS[i];
        const refId = `WEEKLY_RANK_${rank}_${weekEndingStr.slice(0, 10)}`;

        await dbRun(
          `UPDATE users
           SET balance = COALESCE(balance, 0) + ?,
               total_coins_earned = COALESCE(total_coins_earned, 0) + ?
           WHERE id = ?`,
          [reward, reward, winner.id]
        );

        await dbRun(
          `INSERT INTO transactions (user_id, type, amount, reference_id)
           VALUES (?, 'WEEKLY_LEADERBOARD_REWARD', ?, ?)`,
          [winner.id, reward, refId]
        );

        await dbRun(
          `INSERT INTO leaderboard_winners (week_ending, rank, user_id, username, weekly_coins, reward_coins)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [weekEndingStr, rank, winner.id, winner.username, winner.weekly_coins, reward]
        );
      }

      // Reset ONLY leaderboard weekly_coins (real wallet `balance` stays untouched)
      await dbRun('UPDATE users SET weekly_coins = 0');

      // Save next week's reset timestamp
      await dbRun(
        `UPDATE app_config SET value = ? WHERE key = 'leaderboard_next_reset_at'`,
        [nextResetIso]
      );

      await dbRun('COMMIT');
      console.log(
        `🏆 [Weekly Leaderboard Reset] Paid ${winners.length} winners. Next reset: ${nextResetIso}`
      );
      return true;
    } catch (txErr) {
      await dbRun('ROLLBACK').catch(() => {});
      console.error('[Weekly Leaderboard Reset Error]:', txErr.message);
      return false;
    } finally {
      isResetting = false;
    }
  } catch (err) {
    console.error('[Weekly Leaderboard Check Error]:', err.message);
    isResetting = false;
    return false;
  }
}

// Start background check every 60 seconds
function startWeeklyLeaderboardScheduler() {
  setTimeout(() => checkAndProcessWeeklyReset(), 3000);
  setInterval(() => checkAndProcessWeeklyReset(), 60 * 1000);
}

// ---------------------------------------------------------------------------
// 3. Leaderboard Endpoint Handler
// ---------------------------------------------------------------------------
async function getLeaderboardHandler(req, res) {
  try {
    // Process reset immediately if timer just expired
    await checkAndProcessWeeklyReset();

    const cfgRow = await dbGet(
      "SELECT value FROM app_config WHERE key = 'leaderboard_next_reset_at'"
    );
    const nextResetAt = cfgRow
      ? cfgRow.value
      : getNextMondayUtc(new Date()).toISOString();

    const topRows = await dbAll(
      `SELECT id, username,
              COALESCE(current_stone, 'NONE') AS stoneBadge,
              COALESCE(weekly_coins, 0) AS weeklyCoins
       FROM users
       WHERE COALESCE(is_banned, 0) = 0
         AND COALESCE(weekly_coins, 0) > 0
       ORDER BY weeklyCoins DESC, id ASC
       LIMIT 50`
    );

    const topPlayers = (topRows || []).map((p, idx) => ({
      rank: idx + 1,
      userId: p.id,
      username: p.username,
      stoneBadge: p.stoneBadge || 'NONE',
      weeklyCoins: p.weeklyCoins || 0,
      totalCoins: p.weeklyCoins || 0, // Backwards-compatible field
    }));

    const currentUser = await dbGet(
      `SELECT id, username,
              COALESCE(current_stone, 'NONE') AS stoneBadge,
              COALESCE(weekly_coins, 0) AS weeklyCoins
       FROM users
       WHERE id = ?`,
      [req.user.id]
    );

    let userRank = {
      rank: 1,
      username: 'Player',
      stoneBadge: 'NONE',
      weeklyCoins: 0,
      totalCoins: 0,
    };

    if (currentUser) {
      const aheadRow = await dbGet(
        `SELECT COUNT(*) AS ahead
         FROM users
         WHERE COALESCE(is_banned, 0) = 0
           AND (
             COALESCE(weekly_coins, 0) > ?
             OR (COALESCE(weekly_coins, 0) = ? AND id < ?)
           )`,
        [currentUser.weeklyCoins, currentUser.weeklyCoins, currentUser.id]
      );

      userRank = {
        rank: aheadRow ? aheadRow.ahead + 1 : 1,
        username: currentUser.username || 'You',
        stoneBadge: currentUser.stoneBadge || 'NONE',
        weeklyCoins: currentUser.weeklyCoins || 0,
        totalCoins: currentUser.weeklyCoins || 0,
      };
    }

    res.json({
      topPlayers,
      userRank,
      nextResetAt,
      rewards: { 1: 500, 2: 200, 3: 100 },
    });
  } catch (err) {
    console.error('[LEADERBOARD ERROR]:', err.message);
    res.status(500).json({ error: 'Leaderboard lookup failed' });
  }
}

router.get('/', authenticateToken, getLeaderboardHandler);

router.get('/winners', authenticateToken, async (req, res) => {
  try {
    const winners = await dbAll(
      'SELECT * FROM leaderboard_winners ORDER BY id DESC LIMIT 30'
    );
    res.json(winners || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch past winners' });
  }
});

module.exports = {
  router,
  getLeaderboardHandler,
  startWeeklyLeaderboardScheduler,
  checkAndProcessWeeklyReset,
};
