// backend/controllers/html5Controller.js

const crypto = require('crypto');
const db = require('../database');
const { getActiveGames, getActiveGameById } = require('../html5');

// ===========================================================================
// Constants (Server Authoritative)
// ===========================================================================
const NORMAL_RATE_PER_MIN = 3;
const BOOSTER_RATE_PER_MIN = 4;

const CLAIM_INTERVAL_SEC = 5 * 60;       // 5 minutes = 300s
const MAX_PLAY_SEC = 50 * 60;            // 50 minutes = 3000s
const REST_DURATION_MS = 60 * 60 * 1000; // 60 minutes rest

const BOOSTER_ADS_REQUIRED = 3;
const BOOSTER_DURATION_MS = 10 * 60 * 1000;      // 10 minutes
const BOOSTER_COOLDOWN_MS = 5 * 60 * 60 * 1000;  // 5 hours

const MAX_HEARTBEAT_CREDIT_SEC = 15; // Anti-cheat cap per 10s heartbeat
const MIN_HEARTBEAT_GAP_MS = 4000;   // Anti-spam throttle

// 7-Level Stone Badge Tier Definitions (matches routes/games.js)
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

// ===========================================================================
// Database Schema Initialization
// ===========================================================================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS html5_user_state (
      user_id INTEGER PRIMARY KEY,
      cycle_play_seconds INTEGER DEFAULT 0,
      claim_cycle_seconds INTEGER DEFAULT 0,
      unclaimed_units INTEGER DEFAULT 0,
      rest_until_ms INTEGER DEFAULT 0,
      booster_ads_watched INTEGER DEFAULT 0,
      booster_started_at_ms INTEGER DEFAULT 0,
      booster_active_until_ms INTEGER DEFAULT 0,
      booster_cooldown_until_ms INTEGER DEFAULT 0,
      updated_at_ms INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS html5_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      game_id TEXT NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      active_seconds INTEGER DEFAULT 0,
      earned_units INTEGER DEFAULT 0,
      started_at_ms INTEGER NOT NULL,
      last_heartbeat_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_html5_sessions_user ON html5_sessions(user_id, status);`);
});

// ===========================================================================
// Promise Wrappers & Per-User Mutex Lock (Prevents Race Conditions)
// ===========================================================================
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const userLocks = new Map();
function withUserLock(userId, fn) {
  const prev = userLocks.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (userLocks.get(userId) === next) {
      userLocks.delete(userId);
    }
  });
  userLocks.set(userId, next);
  return next;
}

// ===========================================================================
// State Helpers
// ===========================================================================
async function getOrCreateUserState(userId, nowMs) {
  let state = await dbGet('SELECT * FROM html5_user_state WHERE user_id = ?', [userId]);
  if (!state) {
    await dbRun(
      `INSERT OR IGNORE INTO html5_user_state (user_id, updated_at_ms) VALUES (?, ?)`,
      [userId, nowMs]
    );
    state = await dbGet('SELECT * FROM html5_user_state WHERE user_id = ?', [userId]);
  }

  // If mandatory 60-minute rest period has finished, reset the 50-min play cycle
  if (state.rest_until_ms > 0 && nowMs >= state.rest_until_ms) {
    await dbRun(
      `UPDATE html5_user_state
       SET cycle_play_seconds = 0, rest_until_ms = 0, updated_at_ms = ?
       WHERE user_id = ?`,
      [nowMs, userId]
    );
    state.cycle_play_seconds = 0;
    state.rest_until_ms = 0;
  } else if (state.cycle_play_seconds >= MAX_PLAY_SEC && state.rest_until_ms === 0) {
    const restUntil = nowMs + REST_DURATION_MS;
    await dbRun(
      `UPDATE html5_user_state
       SET rest_until_ms = ?, updated_at_ms = ?
       WHERE user_id = ?`,
      [restUntil, nowMs, userId]
    );
    state.rest_until_ms = restUntil;
  }

  return state;
}

function serializeState(state, nowMs, session = null) {
  const isResting = state.rest_until_ms > 0 && nowMs < state.rest_until_ms;
  const restRemainingSec = isResting
    ? Math.max(0, Math.ceil((state.rest_until_ms - nowMs) / 1000))
    : 0;

  const isBoosterActive = state.booster_active_until_ms > 0 && nowMs < state.booster_active_until_ms;
  const boosterRemainingSec = isBoosterActive
    ? Math.max(0, Math.ceil((state.booster_active_until_ms - nowMs) / 1000))
    : 0;

  const isBoosterOnCooldown =
    !isBoosterActive && state.booster_cooldown_until_ms > 0 && nowMs < state.booster_cooldown_until_ms;
  const boosterCooldownRemainingSec = isBoosterOnCooldown
    ? Math.max(0, Math.ceil((state.booster_cooldown_until_ms - nowMs) / 1000))
    : 0;

  const unclaimedCoins = Math.floor((state.unclaimed_units || 0) / 60);
  const remainingPlaySec = Math.max(0, MAX_PLAY_SEC - (state.cycle_play_seconds || 0));
  const claimCycleSec = Math.min(CLAIM_INTERVAL_SEC, state.claim_cycle_seconds || 0);
  const secondsUntilClaim = Math.max(0, CLAIM_INTERVAL_SEC - claimCycleSec);

  const claimRequired =
    claimCycleSec >= CLAIM_INTERVAL_SEC ||
    (state.cycle_play_seconds >= MAX_PLAY_SEC && unclaimedCoins > 0);

  return {
    serverTimeMs: nowMs,
    earningRatePerMin: isBoosterActive ? BOOSTER_RATE_PER_MIN : NORMAL_RATE_PER_MIN,
    maxPlaySeconds: MAX_PLAY_SEC,
    cyclePlaySeconds: state.cycle_play_seconds || 0,
    remainingPlaySeconds: remainingPlaySec,
    claimIntervalSeconds: CLAIM_INTERVAL_SEC,
    claimCycleSeconds: claimCycleSec,
    secondsUntilClaim,
    unclaimedCoins,
    claimRequired,
    isResting,
    restRemainingSeconds: restRemainingSec,
    booster: {
      adsWatched: state.booster_ads_watched || 0,
      adsRequired: BOOSTER_ADS_REQUIRED,
      isActive: isBoosterActive,
      activeRemainingSeconds: boosterRemainingSec,
      isOnCooldown: isBoosterOnCooldown,
      cooldownRemainingSeconds: boosterCooldownRemainingSec,
      ratePerMin: BOOSTER_RATE_PER_MIN,
    },
    session: session
      ? {
          sessionId: session.id,
          gameId: session.game_id,
          activeSeconds: session.active_seconds || 0,
          sessionCoins: Math.floor((session.earned_units || 0) / 60),
        }
      : null,
  };
}

// ===========================================================================
// Route Handlers
// ===========================================================================

// 1. GET /api/html5/games
exports.getGamesAndStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const nowMs = Date.now();
    const state = await withUserLock(userId, () => getOrCreateUserState(userId, nowMs));

    res.json({
      success: true,
      games: getActiveGames(),
      state: serializeState(state, nowMs),
    });
  } catch (err) {
    console.error('[HTML5 GET GAMES ERROR]', err);
    res.status(500).json({ success: false, error: 'Failed to load HTML5 games' });
  }
};

// 2. GET /api/html5/status
exports.getStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const nowMs = Date.now();
    const state = await withUserLock(userId, () => getOrCreateUserState(userId, nowMs));

    res.json({
      success: true,
      state: serializeState(state, nowMs),
    });
  } catch (err) {
    console.error('[HTML5 GET STATUS ERROR]', err);
    res.status(500).json({ success: false, error: 'Failed to load HTML5 status' });
  }
};

// 3. POST /api/html5/session/start
exports.startSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const { gameId } = req.body;

    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }

    const game = getActiveGameById(gameId);
    if (!game) {
      return res.status(404).json({ success: false, error: 'HTML5 game not found or inactive' });
    }

    const nowMs = Date.now();

    const result = await withUserLock(userId, async () => {
      const state = await getOrCreateUserState(userId, nowMs);

      // Block starting a new earning session while mandatory 60-minute rest is active
      if (state.rest_until_ms > 0 && nowMs < state.rest_until_ms) {
        return {
          blocked: true,
          status: 403,
          payload: {
            success: false,
            error: 'Mandatory 60-minute rest break in progress.',
            state: serializeState(state, nowMs),
          },
        };
      }

      // Close any existing active session for this user (prevents multi-session farming)
      await dbRun(
        `UPDATE html5_sessions
         SET status = 'ENDED', ended_at_ms = ?
         WHERE user_id = ? AND status = 'ACTIVE'`,
        [nowMs, userId]
      );

      const sessionId = crypto.randomUUID();
      await dbRun(
        `INSERT INTO html5_sessions
         (id, user_id, game_id, status, active_seconds, earned_units, started_at_ms, last_heartbeat_at_ms)
         VALUES (?, ?, ?, 'ACTIVE', 0, 0, ?, ?)`,
        [sessionId, userId, game.id, nowMs, nowMs]
      );

      const session = await dbGet('SELECT * FROM html5_sessions WHERE id = ?', [sessionId]);
      return {
        blocked: false,
        payload: {
          success: true,
          sessionId,
          game,
          state: serializeState(state, nowMs, session),
        },
      };
    });

    if (result.blocked) {
      return res.status(result.status).json(result.payload);
    }

    res.json(result.payload);
  } catch (err) {
    console.error('[HTML5 START SESSION ERROR]', err);
    res.status(500).json({ success: false, error: 'Failed to start HTML5 session' });
  }
};

// 4. POST /api/html5/session/heartbeat
exports.heartbeat = async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId, isActive = true, afkDurationSec = 0 } = req.body;

    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    const nowMs = Date.now();

    const result = await withUserLock(userId, async () => {
      const session = await dbGet(
        `SELECT * FROM html5_sessions WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`,
        [sessionId, userId]
      );

      if (!session) {
        return {
          status: 404,
          payload: { success: false, error: 'Active session not found or superseded' },
        };
      }

      const state = await getOrCreateUserState(userId, nowMs);

      const isResting = state.rest_until_ms > 0 && nowMs < state.rest_until_ms;
      const unclaimedCoins = Math.floor((state.unclaimed_units || 0) / 60);
      const claimPending =
        state.claim_cycle_seconds >= CLAIM_INTERVAL_SEC ||
        (state.cycle_play_seconds >= MAX_PLAY_SEC && unclaimedCoins > 0);

      // Pause accumulation if user is resting, waiting to claim, or AFK (>= 30s)
      const userIsActivelyPlaying = Boolean(isActive) && Number(afkDurationSec) < 30;
      const elapsedMs = nowMs - session.last_heartbeat_at_ms;

      // Throttle rapid spam without resetting last_heartbeat_at_ms
      if (elapsedMs < MIN_HEARTBEAT_GAP_MS) {
        return {
          status: 200,
          payload: { success: true, state: serializeState(state, nowMs, session) },
        };
      }

      if (isResting || claimPending || !userIsActivelyPlaying) {
        await dbRun(
          `UPDATE html5_sessions SET last_heartbeat_at_ms = ? WHERE id = ?`,
          [nowMs, sessionId]
        );
        return {
          status: 200,
          payload: { success: true, state: serializeState(state, nowMs, session) },
        };
      }

      // Server-side anti-cheat clamping
      const rawElapsedSec = Math.floor(elapsedMs / 1000);
      const maxSessionElapsed = Math.max(
        0,
        Math.floor((nowMs - session.started_at_ms) / 1000) + 2 - session.active_seconds
      );
      const remainingUntilClaim = Math.max(0, CLAIM_INTERVAL_SEC - state.claim_cycle_seconds);
      const remainingUntilRest = Math.max(0, MAX_PLAY_SEC - state.cycle_play_seconds);

      const creditSeconds = Math.min(
        rawElapsedSec,
        MAX_HEARTBEAT_CREDIT_SEC,
        maxSessionElapsed,
        remainingUntilClaim,
        remainingUntilRest
      );

      if (creditSeconds <= 0) {
        await dbRun(
          `UPDATE html5_sessions SET last_heartbeat_at_ms = ? WHERE id = ?`,
          [nowMs, sessionId]
        );
        return {
          status: 200,
          payload: { success: true, state: serializeState(state, nowMs, session) },
        };
      }

      // Compute exact units earned (handling mid-heartbeat booster expiration)
      const winEndMs = nowMs;
      const winStartMs = nowMs - creditSeconds * 1000;
      let boostSeconds = 0;

      if (
        state.booster_active_until_ms > winStartMs &&
        state.booster_started_at_ms < winEndMs
      ) {
        const overlapStart = Math.max(winStartMs, state.booster_started_at_ms);
        const overlapEnd = Math.min(winEndMs, state.booster_active_until_ms);
        boostSeconds = Math.max(0, (overlapEnd - overlapStart) / 1000);
      }

      const normalSeconds = Math.max(0, creditSeconds - boostSeconds);
      const addedUnits = Math.round(
        boostSeconds * BOOSTER_RATE_PER_MIN + normalSeconds * NORMAL_RATE_PER_MIN
      );

      const newCyclePlaySeconds = state.cycle_play_seconds + creditSeconds;
      const newClaimCycleSeconds = state.claim_cycle_seconds + creditSeconds;
      const newUnclaimedUnits = state.unclaimed_units + addedUnits;

      // Trigger mandatory 60-minute rest if 50-minute cap is reached
      let newRestUntilMs = state.rest_until_ms;
      if (newCyclePlaySeconds >= MAX_PLAY_SEC && newRestUntilMs === 0) {
        newRestUntilMs = nowMs + REST_DURATION_MS;
      }

      await dbRun(
        `UPDATE html5_user_state
         SET cycle_play_seconds = ?,
             claim_cycle_seconds = ?,
             unclaimed_units = ?,
             rest_until_ms = ?,
             updated_at_ms = ?
         WHERE user_id = ?`,
        [
          newCyclePlaySeconds,
          newClaimCycleSeconds,
          newUnclaimedUnits,
          newRestUntilMs,
          nowMs,
          userId,
        ]
      );

      const newSessionActive = session.active_seconds + creditSeconds;
      const newSessionUnits = session.earned_units + addedUnits;

      await dbRun(
        `UPDATE html5_sessions
         SET active_seconds = ?, earned_units = ?, last_heartbeat_at_ms = ?
         WHERE id = ?`,
        [newSessionActive, newSessionUnits, nowMs, sessionId]
      );

      state.cycle_play_seconds = newCyclePlaySeconds;
      state.claim_cycle_seconds = newClaimCycleSeconds;
      state.unclaimed_units = newUnclaimedUnits;
      state.rest_until_ms = newRestUntilMs;

      session.active_seconds = newSessionActive;
      session.earned_units = newSessionUnits;

      return {
        status: 200,
        payload: { success: true, state: serializeState(state, nowMs, session) },
      };
    });

    res.status(result.status).json(result.payload);
  } catch (err) {
    console.error('[HTML5 HEARTBEAT ERROR]', err);
    res.status(500).json({ success: false, error: 'Heartbeat processing failed' });
  }
};

// 5. POST /api/html5/session/claim
exports.claimCoins = async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId } = req.body || {};
    const nowMs = Date.now();

    const result = await withUserLock(userId, async () => {
      const state = await getOrCreateUserState(userId, nowMs);
      const unclaimedCoins = Math.floor((state.unclaimed_units || 0) / 60);

      const isEligibleToClaim =
        state.claim_cycle_seconds >= CLAIM_INTERVAL_SEC ||
        (state.cycle_play_seconds >= MAX_PLAY_SEC && unclaimedCoins > 0);

      if (!isEligibleToClaim || unclaimedCoins <= 0) {
        return {
          status: 400,
          payload: {
            success: false,
            error: 'Coins are only claimable after completing 5 minutes of active gameplay.',
            state: serializeState(state, nowMs),
          },
        };
      }

      const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
      if (!user) {
        return { status: 404, payload: { success: false, error: 'User not found' } };
      }

      const remainderUnits = (state.unclaimed_units || 0) % 60;
      const claimRef = `HTML5_${crypto.randomUUID()}`;

      // Streak & Stone Badge calculation (consistent with routes/games.js)
      const today = getTodayStr();
      const yesterday = getYesterdayStr();
      let currentStreak = user.current_streak || 0;
      let highestStreak = user.highest_streak || 0;
      let lastStreakDate = user.last_streak_date || '';
      let streakActivatedNow = false;

      const newEligible =
        user.last_eligible_date === today
          ? (user.eligible_daily_coins || 0) + unclaimedCoins
          : unclaimedCoins;

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
        if (currentStreak > highestStreak) highestStreak = currentStreak;
      }

      const currentStone = calculateStoneBadge(currentStreak);

      await dbRun('BEGIN TRANSACTION');
      try {
        await dbRun(
          `UPDATE html5_user_state
           SET claim_cycle_seconds = 0, unclaimed_units = ?, updated_at_ms = ?
           WHERE user_id = ?`,
          [remainderUnits, nowMs, userId]
        );

        await dbRun(
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
            unclaimedCoins,
            unclaimedCoins,
            newEligible,
            today,
            currentStreak,
            highestStreak,
            lastStreakDate,
            currentStone,
            userId,
          ]
        );

        await dbRun(
          `INSERT INTO transactions (user_id, type, amount, reference_id)
           VALUES (?, 'GAME_REWARD', ?, ?)`,
          [userId, unclaimedCoins, claimRef]
        );

        if (user.referred_by_id) {
          const commission = Math.floor(unclaimedCoins * 0.1);
          if (commission > 0) {
            await dbRun(
              `UPDATE users
               SET balance = balance + ?,
                   total_coins_earned = COALESCE(total_coins_earned, 0) + ?
               WHERE id = ?`,
              [commission, commission, user.referred_by_id]
            );

            await dbRun(
              `INSERT INTO transactions (user_id, type, amount, reference_id)
               VALUES (?, 'REFERRAL_COMMISSION', ?, ?)`,
              [user.referred_by_id, commission, `USER_${userId}_${claimRef}`]
            );
          }
        }

        await dbRun('COMMIT');
      } catch (txErr) {
        await dbRun('ROLLBACK').catch(() => {});
        throw txErr;
      }

      state.claim_cycle_seconds = 0;
      state.unclaimed_units = remainderUnits;

      let session = null;
      if (sessionId) {
        session = await dbGet(
          `SELECT * FROM html5_sessions WHERE id = ? AND user_id = ?`,
          [sessionId, userId]
        );
        if (session) {
          await dbRun(
            `UPDATE html5_sessions SET last_heartbeat_at_ms = ? WHERE id = ?`,
            [nowMs, sessionId]
          );
        }
      }

      const updatedUser = await dbGet('SELECT balance FROM users WHERE id = ?', [userId]);

      console.log(`🎮 [HTML5 CLAIM] User ${userId} claimed +${unclaimedCoins} coins`);

      return {
        status: 200,
        payload: {
          success: true,
          coinsClaimed: unclaimedCoins,
          newBalance: updatedUser ? updatedUser.balance : (user.balance || 0) + unclaimedCoins,
          streakActivatedNow,
          currentStreak,
          message: `+${unclaimedCoins} Coins added to your wallet!`,
          state: serializeState(state, nowMs, session),
        },
      };
    });

    res.status(result.status).json(result.payload);
  } catch (err) {
    console.error('[HTML5 CLAIM ERROR]', err);
    res.status(500).json({ success: false, error: 'Failed to claim coins' });
  }
};

// 6. POST /api/html5/session/end
exports.endSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId } = req.body || {};
    const nowMs = Date.now();

    if (sessionId) {
      await dbRun(
        `UPDATE html5_sessions
         SET status = 'ENDED', ended_at_ms = ?
         WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`,
        [nowMs, sessionId, userId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[HTML5 END SESSION ERROR]', err);
    res.status(500).json({ success: false, error: 'Failed to end session' });
  }
};

// 7. POST /api/html5/booster/watch-ad
exports.watchBoosterAd = async (req, res) => {
  try {
    const userId = req.user.id;
    const nowMs = Date.now();

    const result = await withUserLock(userId, async () => {
      const state = await getOrCreateUserState(userId, nowMs);

      if (state.booster_active_until_ms > nowMs) {
        return {
          status: 400,
          payload: {
            success: false,
            error: 'Booster is already active.',
            state: serializeState(state, nowMs),
          },
        };
      }

      if (state.booster_cooldown_until_ms > nowMs) {
        return {
          status: 400,
          payload: {
            success: false,
            error: 'Booster is on cooldown.',
            state: serializeState(state, nowMs),
          },
        };
      }

      const nextCount = (state.booster_ads_watched || 0) + 1;
      let activated = false;

      if (nextCount >= BOOSTER_ADS_REQUIRED) {
        const activeUntil = nowMs + BOOSTER_DURATION_MS;
        const cooldownUntil = nowMs + BOOSTER_COOLDOWN_MS;

        await dbRun(
          `UPDATE html5_user_state
           SET booster_ads_watched = 0,
               booster_started_at_ms = ?,
               booster_active_until_ms = ?,
               booster_cooldown_until_ms = ?,
               updated_at_ms = ?
           WHERE user_id = ?`,
          [nowMs, activeUntil, cooldownUntil, nowMs, userId]
        );

        state.booster_ads_watched = 0;
        state.booster_started_at_ms = nowMs;
        state.booster_active_until_ms = activeUntil;
        state.booster_cooldown_until_ms = cooldownUntil;
        activated = true;
      } else {
        await dbRun(
          `UPDATE html5_user_state
           SET booster_ads_watched = ?, updated_at_ms = ?
           WHERE user_id = ?`,
          [nextCount, nowMs, userId]
        );
        state.booster_ads_watched = nextCount;
      }

      return {
        status: 200,
        payload: {
          success: true,
          activated,
          message: activated
            ? '⚡ 4 Coins/Min Booster activated for 10 minutes!'
            : `Ad ${nextCount}/${BOOSTER_ADS_REQUIRED} recorded!`,
          state: serializeState(state, nowMs),
        },
      };
    });

    res.status(result.status).json(result.payload);
  } catch (err) {
    console.error('[HTML5 BOOSTER ERROR]', err);
    res.status(500).json({ success: false, error: 'Failed to process booster ad' });
  }
};
