// backend/controllers/spinWheelController.js

const crypto = require('crypto');
const db = require('../database');

// Promisified SQLite helpers
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      err ? reject(err) : resolve(this);
    });
  });

// Server-authoritative reward configuration (0% actual chance for display-only tiers)
const CONFIG = {
  basic: {
    freeSpinsPerDay: 2,
    cooldownMinutes: 30,
    segments: [
      { label: "100",        type: "COINS",     coins: 100,   weight: 55 },
      { label: "200",        type: "COINS",     coins: 200,   weight: 25 },
      { label: "500",        type: "COINS",     coins: 500,   weight: 5 },
      { label: "1,000",      type: "COINS",     coins: 1000,  weight: 0 }, // 0% DISPLAY ONLY
      { label: "10,000",     type: "COINS",     coins: 10000, weight: 0 }, // 0% DISPLAY ONLY
      { label: "Try Again",  type: "TRY_AGAIN", coins: 0,     weight: 15 }
    ]
  },
  premium: {
    freeSpinsPerDay: 1,
    cooldownMinutes: 60,
    segments: [
      { label: "200",     type: "COINS", coins: 200,    weight: 60 },
      { label: "300",     type: "COINS", coins: 300,    weight: 30 },
      { label: "500",     type: "COINS", coins: 500,    weight: 10 },
      { label: "1,000",   type: "COINS", coins: 1000,   weight: 0 }, // 0% DISPLAY ONLY
      { label: "5,000",   type: "COINS", coins: 5000,   weight: 0 }, // 0% DISPLAY ONLY
      { label: "10,000",  type: "COINS", coins: 10000,  weight: 0 }, // 0% DISPLAY ONLY
      { label: "100,000", type: "COINS", coins: 100000, weight: 0 }  // 0% DISPLAY ONLY
    ]
  }
};

function selectWeightedReward(segments) {
  const totalWeight = segments.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;

  for (let i = 0; i < segments.length; i++) {
    if (random < segments[i].weight) {
      return { segment: segments[i], index: i };
    }
    random -= segments[i].weight;
  }
  return { segment: segments[0], index: 0 };
}

// 1. GET USER SPIN STATUS
exports.getSpinStatus = async (req, res) => {
  try {
    const { userId, spinType } = req.query;
    console.log(`[SPIN STATUS] User: ${userId} | Mode: ${spinType}`);

    const config = CONFIG[spinType];
    if (!config) {
      return res.status(400).json({ error: "Invalid spin type. Use 'basic' or 'premium'." });
    }

    const today = new Date().toISOString().split('T')[0];
    const row = await dbGet(
      "SELECT * FROM user_spin_state WHERE user_id = ? AND spin_type = ?",
      [userId, spinType]
    );

    let dailySpinsUsed = 0;
    let cooldownUntil = null;

    if (row && row.daily_date === today) {
      dailySpinsUsed = row.daily_spins_used || 0;
      cooldownUntil = row.cooldown_until ? new Date(row.cooldown_until) : null;
    }

    const freeSpinsRemaining = Math.max(0, config.freeSpinsPerDay - dailySpinsUsed);
    const now = new Date();
    const isCooldownActive = cooldownUntil && cooldownUntil > now;
    const cooldownSecondsRemaining = isCooldownActive
      ? Math.ceil((cooldownUntil - now) / 1000)
      : 0;

    let currentAction = 'CAN_FREE_SPIN';
    if (freeSpinsRemaining === 0) {
      currentAction = isCooldownActive ? 'IN_COOLDOWN' : 'NEED_AD';
    }

    return res.json({
      freeSpinsRemaining,
      currentAction,
      cooldownSecondsRemaining,
      nextSpinCooldownMinutes: config.cooldownMinutes,
    });
  } catch (err) {
    console.error("[SPIN STATUS ERROR]:", err);
    return res.status(500).json({ error: "Failed to fetch spin status" });
  }
};

// 2. AUTHORITATIVE SPIN EXECUTION
exports.executeSpin = async (req, res) => {
  try {
    const { userId, spinType, adWatched } = req.body;
    console.log(`[SPIN EXECUTE] User: ${userId} | Mode: ${spinType} | Ad Watched: ${adWatched}`);

    const config = CONFIG[spinType];
    if (!config) {
      return res.status(400).json({ error: "Invalid spin type. Use 'basic' or 'premium'." });
    }

    const today = new Date().toISOString().split('T')[0];
    const state = await dbGet(
      "SELECT * FROM user_spin_state WHERE user_id = ? AND spin_type = ?",
      [userId, spinType]
    );

    let dailySpinsUsed = (state && state.daily_date === today) ? (state.daily_spins_used || 0) : 0;
    let cooldownUntil = (state && state.cooldown_until) ? new Date(state.cooldown_until) : null;
    const now = new Date();

    // Verification check for limits and cooldown
    if (dailySpinsUsed >= config.freeSpinsPerDay) {
      if (cooldownUntil && cooldownUntil > now) {
        return res.status(403).json({ error: "Cooldown is still active. Please wait." });
      }
      if (!adWatched) {
        return res.status(403).json({ error: "Rewarded ad completion required to spin." });
      }
    }

    // Select reward on server side
    const { segment, index } = selectWeightedReward(config.segments);
    const spinId = "spin_" + crypto.randomUUID();
    const nextCooldown = new Date(now.getTime() + config.cooldownMinutes * 60000).toISOString();

    // Update or insert spin state for user
    await dbRun(`
      INSERT INTO user_spin_state (user_id, spin_type, daily_date, daily_spins_used, cooldown_until, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, spin_type) DO UPDATE SET
        daily_date = excluded.daily_date,
        daily_spins_used = CASE WHEN user_spin_state.daily_date = excluded.daily_date THEN user_spin_state.daily_spins_used + 1 ELSE 1 END,
        cooldown_until = excluded.cooldown_until,
        updated_at = datetime('now')
    `, [userId, spinType, today, dailySpinsUsed + 1, nextCooldown]);

    // Record audit transaction
    await dbRun(`
      INSERT INTO spin_transactions (id, user_id, spin_type, segment_index, reward_type, base_coins, multiplier, final_coins, status)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `, [spinId, userId, spinType, index, segment.type, segment.coins, segment.coins, segment.type === 'COINS' ? 'COMPLETED' : 'PENDING']);

    // Direct wallet update if coins won
    if (segment.type === 'COINS' && segment.coins > 0) {
      await dbRun(
        "UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?",
        [segment.coins, segment.coins, userId]
      );
      await dbRun(
        "INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'SPIN_REWARD', ?, ?)",
        [userId, segment.coins, spinId]
      );
    }

    console.log(`[SPIN WON] User: ${userId} | Target Index: ${index} (${segment.label}) | Coins: ${segment.coins}`);

    return res.json({
      spinId,
      targetIndex: index,
      rewardType: segment.type,
      coinsWon: segment.coins,
      label: segment.label,
      cooldownSeconds: config.cooldownMinutes * 60,
    });
  } catch (err) {
    console.error("[SPIN EXECUTE ERROR]:", err);
    return res.status(500).json({ error: "Failed to execute spin: " + err.message });
  }
};

// 3. CLAIM 2X BONUS VIA REWARDED AD
exports.claim2xReward = async (req, res) => {
  try {
    const { userId, spinId } = req.body;
    console.log(`[SPIN 2X CLAIM] User: ${userId} | Spin ID: ${spinId}`);

    const tx = await dbGet(
      "SELECT * FROM spin_transactions WHERE id = ? AND user_id = ?",
      [spinId, userId]
    );

    if (!tx) return res.status(404).json({ error: "Spin record not found" });
    if (tx.is_2x_claimed === 1) return res.status(400).json({ error: "2X already claimed for this spin" });
    if (tx.reward_type !== 'COINS' || tx.base_coins <= 0) {
      return res.status(400).json({ error: "Reward cannot be doubled" });
    }

    const additionalCoins = tx.base_coins;

    await dbRun(
      "UPDATE spin_transactions SET multiplier = 2, final_coins = final_coins + ?, is_2x_claimed = 1 WHERE id = ?",
      [additionalCoins, spinId]
    );
    await dbRun(
      "UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?",
      [additionalCoins, additionalCoins, userId]
    );
    await dbRun(
      "INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'SPIN_2X_BONUS', ?, ?)",
      [userId, additionalCoins, spinId]
    );

    return res.json({ success: true, addedCoins: additionalCoins, totalReward: tx.base_coins * 2 });
  } catch (err) {
    console.error("[SPIN 2X ERROR]:", err);
    return res.status(500).json({ error: "Failed to process 2X reward" });
  }
};

// 4. RETRY ON 'TRY AGAIN' VIA REWARDED AD
exports.claimTryAgainSpin = async (req, res) => {
  try {
    const { userId, spinId } = req.body;
    console.log(`[SPIN RETRY] User: ${userId} | Spin ID: ${spinId}`);

    const tx = await dbGet(
      "SELECT * FROM spin_transactions WHERE id = ? AND user_id = ? AND reward_type = 'TRY_AGAIN'",
      [spinId, userId]
    );

    if (!tx) return res.status(404).json({ error: "Invalid spin retry attempt" });
    if (tx.is_try_again_claimed === 1) return res.status(400).json({ error: "Extra spin already claimed" });

    // Reset cooldown to grant immediate spin
    await dbRun(
      "UPDATE user_spin_state SET cooldown_until = datetime('now') WHERE user_id = ? AND spin_type = ?",
      [userId, tx.spin_type]
    );
    await dbRun(
      "UPDATE spin_transactions SET is_try_again_claimed = 1, status = 'COMPLETED' WHERE id = ?",
      [spinId]
    );

    return res.json({ success: true, message: "Extra spin unlocked successfully" });
  } catch (err) {
    console.error("[SPIN RETRY ERROR]:", err);
    return res.status(500).json({ error: "Failed to grant extra spin" });
  }
};
