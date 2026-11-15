// backend/routes/watch.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');
const { creditReferralCommission } = require('../services/referralService');

// Watch & Earn Constants
const REQUIRED_ADS = 3;
const COINS_PER_AD = 50;
const TOTAL_REWARD_COINS = 150;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// Auto-ensure user_watch_earn table exists
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS user_watch_earn (
      user_id INTEGER PRIMARY KEY,
      ads_watched INTEGER DEFAULT 0,
      claimed_at TEXT DEFAULT NULL,
      reset_at TEXT DEFAULT NULL,
      last_ad_at TEXT DEFAULT NULL,
      total_claims INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {
    db.run(`CREATE INDEX IF NOT EXISTS idx_watch_earn_reset ON user_watch_earn(reset_at);`, () => {});
  });
});

// 7-Level Stone Badge Tier Definitions (same as games.js / wallet.js)
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
  const days = streakDays || 0;
  for (const stone of STONE_TIERS) {
    if (days >= stone.days) return stone.name;
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

// Helper: Fetch or initialize user watch state and auto-reset if 24h elapsed
function getNormalizedWatchState(userId, callback) {
  db.get('SELECT * FROM user_watch_earn WHERE user_id = ?', [userId], (err, row) => {
    if (err) return callback(err);

    if (!row) {
      return db.run(
        `INSERT OR IGNORE INTO user_watch_earn (user_id, ads_watched) VALUES (?, 0)`,
        [userId],
        (insertErr) => {
          if (insertErr) return callback(insertErr);
          callback(null, {
            user_id: userId,
            ads_watched: 0,
            claimed_at: null,
            reset_at: null,
            total_claims: 0,
          });
        }
      );
    }

    // Check if 24-hour cooldown has expired -> reset progress automatically
    if (row.reset_at) {
      const resetTime = new Date(row.reset_at).getTime();
      if (!isNaN(resetTime) && Date.now() >= resetTime) {
        return db.run(
          `UPDATE user_watch_earn 
           SET ads_watched = 0, claimed_at = NULL, reset_at = NULL, updated_at = CURRENT_TIMESTAMP 
           WHERE user_id = ?`,
          [userId],
          (resetErr) => {
            if (resetErr) return callback(resetErr);
            callback(null, {
              ...row,
              ads_watched: 0,
              claimed_at: null,
              reset_at: null,
            });
          }
        );
      }
    }

    callback(null, row);
  });
}

function formatStatusResponse(row) {
  const now = Date.now();
  let isCooldown = false;
  let remainingMs = 0;

  if (row.reset_at) {
    const resetTime = new Date(row.reset_at).getTime();
    if (!isNaN(resetTime) && resetTime > now) {
      isCooldown = true;
      remainingMs = resetTime - now;
    }
  }

  const adsWatched = Math.min(REQUIRED_ADS, Math.max(0, row.ads_watched || 0));
  const collectedCoins = adsWatched * COINS_PER_AD;

  return {
    adsWatched,
    maxAds: REQUIRED_ADS,
    coinsPerAd: COINS_PER_AD,
    collectedCoins,
    totalReward: TOTAL_REWARD_COINS,
    canWatch: !isCooldown && adsWatched < REQUIRED_ADS,
    canClaim: !isCooldown && adsWatched >= REQUIRED_ADS,
    isCooldown,
    claimedAt: row.claimed_at || null,
    resetAt: row.reset_at || null,
    remainingMs,
    serverTime: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. GET /api/watch/status — Fetch current ads watched, claim state & 24h timer
// ---------------------------------------------------------------------------
router.get('/status', authenticateToken, (req, res) => {
  getNormalizedWatchState(req.user.id, (err, state) => {
    if (err) {
      console.error('[WATCH STATUS ERROR]:', err.message);
      return res.status(500).json({ error: 'Failed to load Watch & Earn status' });
    }
    res.json({
      success: true,
      ...formatStatusResponse(state),
    });
  });
});

// ---------------------------------------------------------------------------
// 2. POST /api/watch/record-ad — Record 1 completed Rewarded Ad (+50 progress)
// ---------------------------------------------------------------------------
router.post('/record-ad', authenticateToken, (req, res) => {
  const userId = req.user.id;

  getNormalizedWatchState(userId, (err, state) => {
    if (err) {
      console.error('[WATCH RECORD ERROR]:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    const status = formatStatusResponse(state);

    if (status.isCooldown) {
      return res.status(429).json({
        error: '24-hour reset timer is active. Please wait until the timer finishes.',
        ...status,
      });
    }

    if (status.adsWatched >= REQUIRED_ADS) {
      return res.status(400).json({
        error: 'You have already watched all 3 ads! Tap Claim to collect 150 coins.',
        ...status,
      });
    }

    // Prevent accidental rapid duplicate calls within 2 seconds
    if (state.last_ad_at) {
      const lastAdTime = new Date(state.last_ad_at).getTime();
      if (!isNaN(lastAdTime) && Date.now() - lastAdTime < 2000) {
        return res.status(429).json({
          error: 'Please wait a moment before recording the next ad.',
          ...status,
        });
      }
    }

    const nextAdsWatched = status.adsWatched + 1;
    const nowIso = new Date().toISOString();

    db.run(
      `UPDATE user_watch_earn 
       SET ads_watched = ?, last_ad_at = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND ads_watched < ? AND reset_at IS NULL`,
      [nextAdsWatched, nowIso, userId, REQUIRED_ADS],
      function (updateErr) {
        if (updateErr) {
          console.error('[WATCH UPDATE ERROR]:', updateErr.message);
          return res.status(500).json({ error: 'Failed to record watched ad' });
        }

        const updatedState = {
          ...state,
          ads_watched: nextAdsWatched,
          last_ad_at: nowIso,
        };
        const nextStatus = formatStatusResponse(updatedState);

        console.log(`📺 [WATCH & EARN] User ${userId} watched ad ${nextAdsWatched}/${REQUIRED_ADS} (${nextStatus.collectedCoins} coins collected)`);

        res.json({
          success: true,
          message:
            nextAdsWatched >= REQUIRED_ADS
              ? '3/3 Ads watched! 150 Coins ready to claim!'
              : `${nextAdsWatched} Ad watched! ${nextStatus.collectedCoins} Coins collected.`,
          ...nextStatus,
        });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 3. POST /api/watch/claim — Claim 150 Coins to Wallet & Start 24-Hour Timer
// ---------------------------------------------------------------------------
router.post('/claim', authenticateToken, (req, res) => {
  const userId = req.user.id;

  getNormalizedWatchState(userId, (err, state) => {
    if (err) {
      console.error('[WATCH CLAIM STATE ERROR]:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    const status = formatStatusResponse(state);

    if (status.isCooldown) {
      return res.status(429).json({
        error: 'Reward already claimed. Wait for the 24-hour timer to reset.',
        ...status,
      });
    }

    if (status.adsWatched < REQUIRED_ADS) {
      return res.status(400).json({
        error: `Please watch all ${REQUIRED_ADS} ads before claiming (${status.adsWatched}/${REQUIRED_ADS} watched).`,
        ...status,
      });
    }

    const nowMs = Date.now();
    const claimedAtIso = new Date(nowMs).toISOString();
    const resetAtIso = new Date(nowMs + COOLDOWN_MS).toISOString();

    // Atomic lock: only succeeds once when ads_watched >= 3 and reset_at IS NULL
    db.run(
      `UPDATE user_watch_earn 
       SET claimed_at = ?, reset_at = ?, total_claims = COALESCE(total_claims, 0) + 1, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND ads_watched >= ? AND reset_at IS NULL`,
      [claimedAtIso, resetAtIso, userId, REQUIRED_ADS],
      function (lockErr) {
        if (lockErr) {
          console.error('[WATCH CLAIM LOCK ERROR]:', lockErr.message);
          return res.status(500).json({ error: 'Failed to process claim' });
        }

        if (this.changes === 0) {
          return res.status(429).json({
            error: 'Reward already claimed or requirements not met.',
          });
        }

        // Fetch user for streak & balance update
        db.get('SELECT * FROM users WHERE id = ?', [userId], (userErr, user) => {
          if (userErr || !user) {
            // Rollback lock if user lookup fails
            db.run(
              `UPDATE user_watch_earn SET claimed_at = NULL, reset_at = NULL WHERE user_id = ?`,
              [userId]
            );
            return res.status(404).json({ error: 'User not found' });
          }

          const today = getTodayStr();
          const yesterday = getYesterdayStr();

          let currentStreak = user.current_streak || 0;
          let highestStreak = user.highest_streak || 0;
          let lastStreakDate = user.last_streak_date || '';
          let streakActivatedNow = false;

          let newEligible =
            user.last_eligible_date === today
              ? (user.eligible_daily_coins || 0) + TOTAL_REWARD_COINS
              : TOTAL_REWARD_COINS;

          if (
            user.last_eligible_date !== today &&
            lastStreakDate !== yesterday &&
            lastStreakDate !== today &&
            currentStreak > 0
          ) {
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
          const refId = `WATCH_EARN_${nowMs}`;

          db.serialize(() => {
            db.run('BEGIN TRANSACTION');

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
                TOTAL_REWARD_COINS,
                TOTAL_REWARD_COINS,
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
              `INSERT INTO transactions (user_id, type, amount, reference_id) 
               VALUES (?, 'WATCH_EARN_REWARD', ?, ?)`,
              [userId, TOTAL_REWARD_COINS, refId]
            );

            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                db.run('ROLLBACK');
                // Revert watch lock on DB error
                db.run(
                  `UPDATE user_watch_earn SET claimed_at = NULL, reset_at = NULL WHERE user_id = ?`,
                  [userId]
                );
                return res.status(500).json({ error: 'Failed to credit Watch & Earn reward' });
              }

              // Credit 10% referral commission
              creditReferralCommission(userId, TOTAL_REWARD_COINS, 'WATCH_EARN', refId, 0.10);

              const newBalance = (user.balance || 0) + TOTAL_REWARD_COINS;
              const nextStatus = formatStatusResponse({
                ads_watched: REQUIRED_ADS,
                claimed_at: claimedAtIso,
                reset_at: resetAtIso,
              });

              console.log(`🎉 [WATCH & EARN CLAIMED] User ${userId} claimed +${TOTAL_REWARD_COINS} coins. Resets at: ${resetAtIso}`);

              res.json({
                success: true,
                earned: TOTAL_REWARD_COINS,
                newBalance,
                currentStreak,
                currentStone,
                streakActivatedNow,
                message: `+${TOTAL_REWARD_COINS} Coins added to your wallet! Next reset in 24 hours.`,
                ...nextStatus,
              });
            });
          });
        });
      }
    );
  });
});

module.exports = router;
