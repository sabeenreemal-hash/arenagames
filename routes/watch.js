// backend/routes/watch.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');
const { creditReferralCommission } = require('../services/referralService');

// Watch & Earn Constants
const REQUIRED_ADS = 3;
const STAGE1_REWARD_COINS = 100;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// Stage 2: Spin Wheel Options (5 options)
const SPIN_OPTIONS = [5, 10, 40, 70, 100];
const SPIN_WEIGHTS = [30, 30, 22, 12, 6]; // Adjustable weights (%)

// Stage 3: Scratch Card Options (5 options)
const SCRATCH_OPTIONS = [5, 10, 30, 70, 100];
const SCRATCH_WEIGHTS = [30, 30, 22, 12, 6]; // Adjustable weights (%)

// Auto-ensure user_watch_earn table & migrate older columns safely
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS user_watch_earn (
      user_id INTEGER PRIMARY KEY,
      stage INTEGER DEFAULT 1,
      ads_watched INTEGER DEFAULT 0,
      stage1_reward INTEGER DEFAULT 0,
      spin_reward INTEGER DEFAULT NULL,
      scratch_reward INTEGER DEFAULT NULL,
      pending_scratch_reward INTEGER DEFAULT NULL,
      claimed_at TEXT DEFAULT NULL,
      reset_at TEXT DEFAULT NULL,
      last_ad_at TEXT DEFAULT NULL,
      total_claims INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {
    const migrations = [
      ['stage', 'INTEGER DEFAULT 1'],
      ['stage1_reward', 'INTEGER DEFAULT 0'],
      ['spin_reward', 'INTEGER DEFAULT NULL'],
      ['scratch_reward', 'INTEGER DEFAULT NULL'],
      ['pending_scratch_reward', 'INTEGER DEFAULT NULL'],
    ];
    migrations.forEach(([col, def]) => {
      db.run(`ALTER TABLE user_watch_earn ADD COLUMN ${col} ${def}`, () => {});
    });
    db.run(`CREATE INDEX IF NOT EXISTS idx_watch_earn_reset ON user_watch_earn(reset_at);`, () => {});
  });
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

function pickWeightedOption(options, weights) {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < options.length; i++) {
    rand -= weights[i];
    if (rand <= 0) {
      return { index: i, coins: options[i] };
    }
  }
  return { index: 0, coins: options[0] };
}

// Helper: Credit coins + update daily streak + stone badge + 10% referral commission
function creditUserWatchCoins(userId, coins, txType, refId, callback) {
  db.get('SELECT * FROM users WHERE id = ?', [userId], (userErr, user) => {
    if (userErr || !user) {
      return callback(new Error('User not found'));
    }

    const today = getTodayStr();
    const yesterday = getYesterdayStr();

    let currentStreak = user.current_streak || 0;
    let highestStreak = user.highest_streak || 0;
    let lastStreakDate = user.last_streak_date || '';
    let streakActivatedNow = false;

    const newEligible =
      user.last_eligible_date === today
        ? (user.eligible_daily_coins || 0) + coins
        : coins;

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
          coins,
          coins,
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
        `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, ?, ?, ?)`,
        [userId, txType, coins, refId]
      );

      db.run('COMMIT', (commitErr) => {
        if (commitErr) {
          db.run('ROLLBACK');
          return callback(commitErr);
        }

        creditReferralCommission(userId, coins, txType, refId, 0.10);

        callback(null, {
          newBalance: (user.balance || 0) + coins,
          currentStreak,
          currentStone,
          streakActivatedNow,
        });
      });
    });
  });
}

// Helper: Fetch or initialize user watch state and auto-reset if 24h elapsed
function getNormalizedWatchState(userId, callback) {
  db.get('SELECT * FROM user_watch_earn WHERE user_id = ?', [userId], (err, row) => {
    if (err) return callback(err);

    if (!row) {
      return db.run(
        `INSERT OR IGNORE INTO user_watch_earn (user_id, stage, ads_watched) VALUES (?, 1, 0)`,
        [userId],
        (insertErr) => {
          if (insertErr) return callback(insertErr);
          callback(null, {
            user_id: userId,
            stage: 1,
            ads_watched: 0,
            stage1_reward: 0,
            spin_reward: null,
            scratch_reward: null,
            pending_scratch_reward: null,
            claimed_at: null,
            reset_at: null,
            last_ad_at: null,
            total_claims: 0,
          });
        }
      );
    }

    // Auto-reset entire 3-stage cycle when 24 hours have passed
    if (row.reset_at) {
      const resetTime = new Date(row.reset_at).getTime();
      if (!isNaN(resetTime) && Date.now() >= resetTime) {
        return db.run(
          `UPDATE user_watch_earn 
           SET stage = 1,
               ads_watched = 0,
               stage1_reward = 0,
               spin_reward = NULL,
               scratch_reward = NULL,
               pending_scratch_reward = NULL,
               claimed_at = NULL,
               reset_at = NULL,
               updated_at = CURRENT_TIMESTAMP 
           WHERE user_id = ?`,
          [userId],
          (resetErr) => {
            if (resetErr) return callback(resetErr);
            callback(null, {
              ...row,
              stage: 1,
              ads_watched: 0,
              stage1_reward: 0,
              spin_reward: null,
              scratch_reward: null,
              pending_scratch_reward: null,
              claimed_at: null,
              reset_at: null,
            });
          }
        );
      }

      // Legacy row safety: if user already claimed old Stage 1 today, unlock Stage 2
      if ((row.stage || 1) === 1 && row.claimed_at) {
        return db.run(
          `UPDATE user_watch_earn SET stage = 2, ads_watched = 0, stage1_reward = 100 WHERE user_id = ?`,
          [userId],
          () => {
            callback(null, {
              ...row,
              stage: 2,
              ads_watched: 0,
              stage1_reward: 100,
            });
          }
        );
      }
    }

    callback(null, {
      ...row,
      stage: row.stage || 1,
      ads_watched: row.ads_watched || 0,
    });
  });
}

function formatStatusResponse(row) {
  const now = Date.now();
  let isTimerRunning = false;
  let remainingMs = 0;

  if (row.reset_at) {
    const resetTime = new Date(row.reset_at).getTime();
    if (!isNaN(resetTime) && resetTime > now) {
      isTimerRunning = true;
      remainingMs = resetTime - now;
    }
  }

  const stage = Math.min(4, Math.max(1, row.stage || 1));
  const adsWatched = Math.min(REQUIRED_ADS, Math.max(0, row.ads_watched || 0));

  return {
    stage, // 1 = 100 Coins, 2 = Spin Wheel, 3 = Scratch Card, 4 = Completed (Wait 24h)
    adsWatched,
    maxAds: REQUIRED_ADS,
    stage1Reward: STAGE1_REWARD_COINS,
    stage1ClaimedCoins: row.stage1_reward || 0,
    spinOptions: SPIN_OPTIONS,
    scratchOptions: SCRATCH_OPTIONS,
    spinWon: row.spin_reward ?? null,
    scratchWon: row.scratch_reward ?? null,
    pendingScratchReward: row.pending_scratch_reward ?? null,
    canWatchAd: stage <= 3 && adsWatched < REQUIRED_ADS,
    canClaimStage1: stage === 1 && adsWatched >= REQUIRED_ADS,
    canSpin: stage === 2 && adsWatched >= REQUIRED_ADS,
    canScratch: stage === 3 && adsWatched >= REQUIRED_ADS,
    isCompletedCycle: stage === 4,
    isTimerRunning,
    claimedAt: row.claimed_at || null,
    resetAt: row.reset_at || null,
    remainingMs,
    serverTime: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. GET /api/watch/status
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
// 2. POST /api/watch/record-ad — Watch 1 ad for the active stage (1, 2, or 3)
// ---------------------------------------------------------------------------
router.post('/record-ad', authenticateToken, (req, res) => {
  const userId = req.user.id;

  getNormalizedWatchState(userId, (err, state) => {
    if (err) {
      console.error('[WATCH RECORD ERROR]:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    const status = formatStatusResponse(state);

    if (status.isCompletedCycle) {
      return res.status(429).json({
        error: 'All 3 rewards claimed! Wait for the 24-hour timer to reset.',
        ...status,
      });
    }

    if (status.adsWatched >= REQUIRED_ADS) {
      const actionMsg =
        status.stage === 1
          ? 'All 3 ads watched! Tap Claim to collect 100 Coins.'
          : status.stage === 2
          ? 'All 3 ads watched! Spin the wheel now.'
          : 'All 3 ads watched! Scratch your card now.';
      return res.status(400).json({ error: actionMsg, ...status });
    }

    // 2-second duplicate tap guard
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

    // If Stage 3 reaches 3/3 ads, pre-roll the scratch reward so the card reveals it cleanly
    let pendingScratch = state.pending_scratch_reward ?? null;
    if (status.stage === 3 && nextAdsWatched === REQUIRED_ADS && pendingScratch == null) {
      pendingScratch = pickWeightedOption(SCRATCH_OPTIONS, SCRATCH_WEIGHTS).coins;
    }

    db.run(
      `UPDATE user_watch_earn 
       SET ads_watched = ?, pending_scratch_reward = ?, last_ad_at = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND stage = ? AND ads_watched < ?`,
      [nextAdsWatched, pendingScratch, nowIso, userId, status.stage, REQUIRED_ADS],
      function (updateErr) {
        if (updateErr) {
          console.error('[WATCH UPDATE ERROR]:', updateErr.message);
          return res.status(500).json({ error: 'Failed to record watched ad' });
        }

        const updatedState = {
          ...state,
          ads_watched: nextAdsWatched,
          pending_scratch_reward: pendingScratch,
          last_ad_at: nowIso,
        };
        const nextStatus = formatStatusResponse(updatedState);

        let message = `Stage ${status.stage}: ${nextAdsWatched}/${REQUIRED_ADS} Ads watched!`;
        if (nextAdsWatched >= REQUIRED_ADS) {
          if (status.stage === 1) message = '3/3 Ads watched! Claim your 100 Coins!';
          if (status.stage === 2) message = '3/3 Ads watched! Spin Wheel unlocked!';
          if (status.stage === 3) message = '3/3 Ads watched! Scratch Card unlocked!';
        }

        console.log(`📺 [WATCH & EARN] User ${userId} Stage ${status.stage} Ad ${nextAdsWatched}/${REQUIRED_ADS}`);

        res.json({
          success: true,
          message,
          ...nextStatus,
        });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 3. POST /api/watch/claim — Stage 1 Claim (100 Coins + Start 24h Timer + Unlock Stage 2)
// ---------------------------------------------------------------------------
router.post('/claim', authenticateToken, (req, res) => {
  const userId = req.user.id;

  getNormalizedWatchState(userId, (err, state) => {
    if (err) return res.status(500).json({ error: 'Database error' });

    const status = formatStatusResponse(state);

    if (status.stage !== 1) {
      return res.status(400).json({ error: 'Stage 1 (100 Coins) is already claimed for this cycle.', ...status });
    }

    if (status.adsWatched < REQUIRED_ADS) {
      return res.status(400).json({
        error: `Please watch all ${REQUIRED_ADS} ads before claiming (${status.adsWatched}/${REQUIRED_ADS}).`,
        ...status,
      });
    }

    const nowMs = Date.now();
    const claimedAtIso = new Date(nowMs).toISOString();
    const resetAtIso = new Date(nowMs + COOLDOWN_MS).toISOString();

    // Atomic advance Stage 1 -> Stage 2 & start 24h cycle timer
    db.run(
      `UPDATE user_watch_earn 
       SET stage = 2,
           ads_watched = 0,
           stage1_reward = ?,
           claimed_at = ?,
           reset_at = ?,
           total_claims = COALESCE(total_claims, 0) + 1,
           updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND stage = 1 AND ads_watched >= ?`,
      [STAGE1_REWARD_COINS, claimedAtIso, resetAtIso, userId, REQUIRED_ADS],
      function (lockErr) {
        if (lockErr) return res.status(500).json({ error: 'Failed to process claim' });
        if (this.changes === 0) {
          return res.status(429).json({ error: 'Stage 1 already claimed or ads incomplete.' });
        }

        const refId = `WATCH_STAGE1_${nowMs}`;
        creditUserWatchCoins(userId, STAGE1_REWARD_COINS, 'WATCH_EARN_REWARD', refId, (creditErr, result) => {
          if (creditErr) {
            db.run(
              `UPDATE user_watch_earn SET stage = 1, ads_watched = ?, stage1_reward = 0, claimed_at = NULL, reset_at = NULL WHERE user_id = ?`,
              [REQUIRED_ADS, userId]
            );
            return res.status(500).json({ error: 'Failed to credit 100 coins' });
          }

          const nextStatus = formatStatusResponse({
            ...state,
            stage: 2,
            ads_watched: 0,
            stage1_reward: STAGE1_REWARD_COINS,
            claimed_at: claimedAtIso,
            reset_at: resetAtIso,
          });

          console.log(`🎉 [WATCH STAGE 1] User ${userId} claimed +100 coins. 24h timer started, Stage 2 Spin Wheel unlocked!`);

          res.json({
            success: true,
            earned: STAGE1_REWARD_COINS,
            ...result,
            message: '+100 Coins added! 24h timer started & Spin Wheel unlocked!',
            ...nextStatus,
          });
        });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 4. POST /api/watch/spin — Stage 2 Spin Wheel (5, 10, 40, 70, 100 Coins -> Unlock Stage 3)
// ---------------------------------------------------------------------------
router.post('/spin', authenticateToken, (req, res) => {
  const userId = req.user.id;

  getNormalizedWatchState(userId, (err, state) => {
    if (err) return res.status(500).json({ error: 'Database error' });

    const status = formatStatusResponse(state);

    if (status.stage !== 2) {
      return res.status(400).json({ error: 'Spin Wheel is not currently active.', ...status });
    }

    if (status.adsWatched < REQUIRED_ADS) {
      return res.status(400).json({
        error: `Watch ${REQUIRED_ADS} ads to unlock Spin Wheel (${status.adsWatched}/${REQUIRED_ADS}).`,
        ...status,
      });
    }

    const picked = pickWeightedOption(SPIN_OPTIONS, SPIN_WEIGHTS);
    const wonIndex = picked.index;
    const wonCoins = picked.coins;

    // Atomic advance Stage 2 -> Stage 3
    db.run(
      `UPDATE user_watch_earn 
       SET stage = 3,
           ads_watched = 0,
           spin_reward = ?,
           updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND stage = 2 AND ads_watched >= ?`,
      [wonCoins, userId, REQUIRED_ADS],
      function (lockErr) {
        if (lockErr) return res.status(500).json({ error: 'Failed to spin wheel' });
        if (this.changes === 0) {
          return res.status(429).json({ error: 'Spin already used or requirements not met.' });
        }

        const refId = `WATCH_SPIN_${Date.now()}`;
        creditUserWatchCoins(userId, wonCoins, 'WATCH_SPIN_REWARD', refId, (creditErr, result) => {
          if (creditErr) {
            db.run(
              `UPDATE user_watch_earn SET stage = 2, ads_watched = ?, spin_reward = NULL WHERE user_id = ?`,
              [REQUIRED_ADS, userId]
            );
            return res.status(500).json({ error: 'Failed to credit spin reward' });
          }

          const nextStatus = formatStatusResponse({
            ...state,
            stage: 3,
            ads_watched: 0,
            spin_reward: wonCoins,
          });

          console.log(`🎡 [WATCH SPIN] User ${userId} spun and won +${wonCoins} coins! Stage 3 Scratch Card unlocked.`);

          res.json({
            success: true,
            wonIndex,
            wonCoins,
            ...result,
            message: `🎡 You won +${wonCoins} Coins! Scratch Card unlocked!`,
            ...nextStatus,
          });
        });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 5. POST /api/watch/scratch — Stage 3 Scratch Card (5, 10, 30, 70, 100 Coins -> Stage 4 Cooldown)
// ---------------------------------------------------------------------------
router.post('/scratch', authenticateToken, (req, res) => {
  const userId = req.user.id;

  getNormalizedWatchState(userId, (err, state) => {
    if (err) return res.status(500).json({ error: 'Database error' });

    const status = formatStatusResponse(state);

    if (status.stage !== 3) {
      return res.status(400).json({ error: 'Scratch Card is not currently active.', ...status });
    }

    if (status.adsWatched < REQUIRED_ADS) {
      return res.status(400).json({
        error: `Watch ${REQUIRED_ADS} ads to unlock Scratch Card (${status.adsWatched}/${REQUIRED_ADS}).`,
        ...status,
      });
    }

    const wonCoins =
      state.pending_scratch_reward != null && SCRATCH_OPTIONS.includes(state.pending_scratch_reward)
        ? state.pending_scratch_reward
        : pickWeightedOption(SCRATCH_OPTIONS, SCRATCH_WEIGHTS).coins;

    // Atomic advance Stage 3 -> Stage 4 (wait for 24h reset timer)
    db.run(
      `UPDATE user_watch_earn 
       SET stage = 4,
           ads_watched = 0,
           scratch_reward = ?,
           pending_scratch_reward = NULL,
           updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND stage = 3 AND ads_watched >= ?`,
      [wonCoins, userId, REQUIRED_ADS],
      function (lockErr) {
        if (lockErr) return res.status(500).json({ error: 'Failed to claim scratch card' });
        if (this.changes === 0) {
          return res.status(429).json({ error: 'Scratch Card already claimed.' });
        }

        const refId = `WATCH_SCRATCH_${Date.now()}`;
        creditUserWatchCoins(userId, wonCoins, 'WATCH_SCRATCH_REWARD', refId, (creditErr, result) => {
          if (creditErr) {
            db.run(
              `UPDATE user_watch_earn SET stage = 3, ads_watched = ?, scratch_reward = NULL, pending_scratch_reward = ? WHERE user_id = ?`,
              [REQUIRED_ADS, wonCoins, userId]
            );
            return res.status(500).json({ error: 'Failed to credit scratch reward' });
          }

          const nextStatus = formatStatusResponse({
            ...state,
            stage: 4,
            ads_watched: 0,
            scratch_reward: wonCoins,
            pending_scratch_reward: null,
          });

          console.log(`🪙 [WATCH SCRATCH] User ${userId} scratched and won +${wonCoins} coins! Waiting for 24h timer.`);

          res.json({
            success: true,
            wonCoins,
            ...result,
            message: `🪙 Scratch Card won +${wonCoins} Coins! Come back when the 24h timer resets.`,
            ...nextStatus,
          });
        });
      }
    );
  });
});

module.exports = router;
