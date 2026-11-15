// backend/routes/leaderboard.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const WEEKLY_REWARDS = [500, 200, 100]; // 1st, 2nd, 3rd
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let isResetting = false;

// ---------------------------------------------------------------------------
// 1. Auto-Migrate Weekly Leaderboard Schema
// ---------------------------------------------------------------------------
db.serialize(() => {
  // Add weekly_coins to users (kept separate from wallet `balance`)
  db.all('PRAGMA table_info(users)', (err, columns) => {
    if (!err && columns) {
      const hasWeeklyCoins = columns.some((c) => c.name === 'weekly_coins');
      if (!hasWeeklyCoins) {
        db.run(
          'ALTER TABLE users ADD COLUMN weekly_coins INTEGER DEFAULT 0',
          (alterErr) => {
            if (alterErr) {
              console.error('[Leaderboard Migration Error]:', alterErr.message);
            }
          }
        );
      }
    }
  });

  // Audit table for past weekly winners
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

  // Initialize next Monday 00:00:00 UTC if not already set in app_config
  const initialResetIso = getNextMondayUtc(new Date()).toISOString();
  db.run(
    `INSERT OR IGNORE INTO app_config (key, value) VALUES ('leaderboard_next_reset_at', ?)`,
    [initialResetIso]
  );
});

function getNextMondayUtc(fromDate) {
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
// 2. Helper: Call whenever a user earns coins for the leaderboard
// ---------------------------------------------------------------------------
function addLeaderboardCoins(userId, coins) {
  const amount = parseInt(coins, 10);
  if (!userId || isNaN(amount) || amount <= 0) return;

  db.run(
    'UPDATE users SET weekly_coins = COALESCE(weekly_coins, 0) + ? WHERE id = ?',
    [amount, userId],
    (err) => {
      if (err) {
        console.error('[Leaderboard Add Coins Error]:', err.message);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// 3. Weekly Reset & Top 3 Reward Distribution
// ---------------------------------------------------------------------------
function checkAndProcessWeeklyReset(callback = () => {}) {
  if (isResetting) return callback(null, false);

  db.get(
    "SELECT value FROM app_config WHERE key = 'leaderboard_next_reset_at'",
    (err, row) => {
      if (err || !row || !row.value) return callback(err || null, false);

      const resetTime = new Date(row.value).getTime();
      const now = Date.now();

      if (isNaN(resetTime) || now < resetTime) {
        return callback(null, false);
      }

      isResetting = true;

      // Calculate the next future Monday UTC so we never trigger multiple resets if server was down
      let nextResetDate = new Date(resetTime + ONE_WEEK_MS);
      while (nextResetDate.getTime() <= now) {
        nextResetDate = new Date(nextResetDate.getTime() + ONE_WEEK_MS);
      }
      const nextResetIso = nextResetDate.toISOString();
      const weekEndingStr = new Date(resetTime).toISOString();

      db.serialize(() => {
        db.run('BEGIN IMMEDIATE TRANSACTION', (txErr) => {
          if (txErr) {
            isResetting = false;
            return callback(txErr, false);
          }

          // Get Top 3 active players with weekly_coins > 0
          db.all(
            `SELECT id, username, COALESCE(weekly_coins, 0) AS weekly_coins
             FROM users
             WHERE COALESCE(is_banned, 0) = 0
               AND COALESCE(weekly_coins, 0) > 0
             ORDER BY weekly_coins DESC, id ASC
             LIMIT 3`,
            (topErr, winners) => {
              if (topErr) {
                db.run('ROLLBACK', () => {
                  isResetting = false;
                  callback(topErr, false);
                });
                return;
              }

              // Pay Top 3 into their real wallet (`balance`)
              (winners || []).forEach((winner, index) => {
                const reward = WEEKLY_REWARDS[index];
                const rank = index + 1;
                const refId = `WEEKLY_RANK_${rank}_${weekEndingStr.slice(0, 10)}`;

                db.run(
                  `UPDATE users
                   SET balance = COALESCE(balance, 0) + ?,
                       total_coins_earned = COALESCE(total_coins_earned, 0) + ?
                   WHERE id = ?`,
                  [reward, reward, winner.id]
                );

                db.run(
                  `INSERT INTO transactions (user_id, type, amount, reference_id)
                   VALUES (?, 'WEEKLY_LEADERBOARD_REWARD', ?, ?)`,
                  [winner.id, reward, refId]
                );

                db.run(
                  `INSERT INTO leaderboard_winners (week_ending, rank, user_id, username, weekly_coins, reward_coins)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                  [weekEndingStr, rank, winner.id, winner.username, winner.weekly_coins, reward]
                );
              });

              // Reset ONLY weekly_coins (never touch user wallet `balance`)
              db.run('UPDATE users SET weekly_coins = 0', (resetErr) => {
                if (resetErr) {
                  db.run('ROLLBACK', () => {
                    isResetting = false;
                    callback(resetErr, false);
                  });
                  return;
                }

                db.run(
                  `UPDATE app_config SET value = ? WHERE key = 'leaderboard_next_reset_at'`,
                  [nextResetIso],
                  (cfgErr) => {
                    if (cfgErr) {
                      db.run('ROLLBACK', () => {
                        isResetting = false;
                        callback(cfgErr, false);
                      });
                      return;
                    }

                    db.run('COMMIT', (commitErr) => {
                      isResetting = false;
                      if (commitErr) {
                        db.run('ROLLBACK');
                        return callback(commitErr, false);
                      }
                      console.log(
                        `[Weekly Leaderboard Reset] Paid ${(winners || []).length} winners. Next reset: ${nextResetIso}`
                      );
                      callback(null, true);
                    });
                  }
                );
              });
            }
          );
        });
      });
    }
  );
}

// Run automatic check every 60 seconds (also runs right before serving GET /)
function startWeeklyLeaderboardScheduler() {
  checkAndProcessWeeklyReset();
  setInterval(() => {
    checkAndProcessWeeklyReset();
  }, 60 * 1000);
}

// ---------------------------------------------------------------------------
// 4. GET Leaderboard Endpoint
// ---------------------------------------------------------------------------
router.get('/', authenticateToken, (req, res) => {
  // Ensure reset is processed if timer just expired
  checkAndProcessWeeklyReset(() => {
    db.get(
      "SELECT value FROM app_config WHERE key = 'leaderboard_next_reset_at'",
      (cfgErr, cfgRow) => {
        const nextResetAt = cfgRow ? cfgRow.value : getNextMondayUtc(new Date()).toISOString();

        // Top 50 Weekly Players
        db.all(
          `SELECT id, username,
                  COALESCE(current_stone, 'NONE') AS stoneBadge,
                  COALESCE(weekly_coins, 0) AS weeklyCoins
           FROM users
           WHERE COALESCE(is_banned, 0) = 0
             AND COALESCE(weekly_coins, 0) > 0
           ORDER BY weeklyCoins DESC, id ASC
           LIMIT 50`,
          (topErr, rows) => {
            if (topErr) {
              return res.status(500).json({ error: 'Failed to fetch leaderboard' });
            }

            const topPlayers = (rows || []).map((row, idx) => ({
              rank: idx + 1,
              id: row.id,
              username: row.username,
              stoneBadge: row.stoneBadge,
              weeklyCoins: row.weeklyCoins,
              totalCoins: row.weeklyCoins, // backwards-compatible key
            }));

            // Current User's Standing
            db.get(
              `SELECT id, username,
                      COALESCE(current_stone, 'NONE') AS stoneBadge,
                      COALESCE(weekly_coins, 0) AS weeklyCoins
               FROM users
               WHERE id = ?`,
              [req.user.id],
              (userErr, currentUser) => {
                if (userErr || !currentUser) {
                  return res.json({
                    topPlayers,
                    userRank: null,
                    nextResetAt,
                    rewards: { 1: 500, 2: 200, 3: 100 },
                  });
                }

                db.get(
                  `SELECT COUNT(*) AS ahead
                   FROM users
                   WHERE COALESCE(is_banned, 0) = 0
                     AND (
                       COALESCE(weekly_coins, 0) > ?
                       OR (COALESCE(weekly_coins, 0) = ? AND id < ?)
                     )`,
                  [currentUser.weeklyCoins, currentUser.weeklyCoins, currentUser.id],
                  (rankErr, rankRow) => {
                    const rank = rankErr || !rankRow ? 0 : rankRow.ahead + 1;

                    res.json({
                      topPlayers,
                      userRank: {
                        rank,
                        username: currentUser.username,
                        stoneBadge: currentUser.stoneBadge,
                        weeklyCoins: currentUser.weeklyCoins,
                        totalCoins: currentUser.weeklyCoins,
                      },
                      nextResetAt,
                      rewards: { 1: 500, 2: 200, 3: 100 },
                    });
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

// Optional: Past Weekly Winners History
router.get('/winners', authenticateToken, (req, res) => {
  db.all(
    'SELECT * FROM leaderboard_winners ORDER BY id DESC LIMIT 30',
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch past winners' });
      res.json(rows || []);
    }
  );
});

module.exports = {
  router,
  addLeaderboardCoins,
  startWeeklyLeaderboardScheduler,
  checkAndProcessWeeklyReset,
};
