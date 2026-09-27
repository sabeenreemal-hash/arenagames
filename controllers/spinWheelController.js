const crypto = require('crypto');

// Configuration: Display items vs server probability weights
const CONFIG = {
  basic: {
    freeSpinsPerDay: 2,
    cooldownMinutes: 30,
    segments: [
      { label: "100 Coins",  type: "COINS",     coins: 100,   weight: 55 },
      { label: "200 Coins",  type: "COINS",     coins: 200,   weight: 25 },
      { label: "500 Coins",  type: "COINS",     coins: 500,   weight: 5 },
      { label: "1,000 Coins",type: "COINS",     coins: 1000,  weight: 0 }, // 0% DISPLAY ONLY
      { label: "10,000 Coins",type: "COINS",    coins: 10000, weight: 0 }, // 0% DISPLAY ONLY
      { label: "Try Again",  type: "TRY_AGAIN", coins: 0,     weight: 15 }
    ]
  },
  premium: {
    freeSpinsPerDay: 1,
    cooldownMinutes: 60,
    segments: [
      { label: "200 Coins",    type: "COINS", coins: 200,    weight: 60 },
      { label: "300 Coins",    type: "COINS", coins: 300,    weight: 30 },
      { label: "500 Coins",    type: "COINS", coins: 500,    weight: 10 },
      { label: "1,000 Coins",  type: "COINS", coins: 1000,   weight: 0 }, // 0% DISPLAY ONLY
      { label: "5,000 Coins",  type: "COINS", coins: 5000,   weight: 0 }, // 0% DISPLAY ONLY
      { label: "10,000 Coins", type: "COINS", coins: 10000,  weight: 0 }, // 0% DISPLAY ONLY
      { label: "100,000 Coins",type: "COINS", coins: 100000, weight: 0 }  // 0% DISPLAY ONLY
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

// 1. GET USER STATUS
exports.getSpinStatus = async (req, res) => {
  const { userId, spinType } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const config = CONFIG[spinType];

  if (!config) return res.status(400).json({ error: "Invalid spin type" });

  let state = await db.query(
    "SELECT * FROM user_spin_state WHERE user_id = $1 AND spin_type = $2",
    [userId, spinType]
  );

  let dailySpinsUsed = 0;
  let cooldownUntil = null;

  if (state.rows.length > 0) {
    const row = state.rows[0];
    if (row.daily_date === today) {
      dailySpinsUsed = row.daily_spins_used;
      cooldownUntil = row.cooldown_until ? new Date(row.cooldown_until) : null;
    }
  }

  const freeSpinsRemaining = Math.max(0, config.freeSpinsPerDay - dailySpinsUsed);
  const now = new Date();
  const isCooldownActive = cooldownUntil && cooldownUntil > now;
  const cooldownSecondsRemaining = isCooldownActive 
    ? Math.ceil((cooldownUntil - now) / 1000) 
    : 0;

  // Status can be: 'CAN_FREE_SPIN', 'NEED_AD', 'IN_COOLDOWN'
  let currentAction = 'CAN_FREE_SPIN';
  if (freeSpinsRemaining === 0) {
    currentAction = isCooldownActive ? 'IN_COOLDOWN' : 'NEED_AD';
  }

  return res.json({
    freeSpinsRemaining,
    currentAction,
    cooldownSecondsRemaining,
    nextSpinCooldownMinutes: config.cooldownMinutes
  });
};

// 2. EXECUTE SPIN
exports.executeSpin = async (req, res) => {
  const { userId, spinType, adWatched } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const config = CONFIG[spinType];

  let stateRes = await db.query(
    "SELECT * FROM user_spin_state WHERE user_id = $1 AND spin_type = $2",
    [userId, spinType]
  );

  let state = stateRes.rows[0];
  let dailySpinsUsed = (state && state.daily_date === today) ? state.daily_spins_used : 0;
  let cooldownUntil = (state && state.cooldown_until) ? new Date(state.cooldown_until) : null;
  const now = new Date();

  // Validate eligibility
  if (dailySpinsUsed >= config.freeSpinsPerDay) {
    if (cooldownUntil && cooldownUntil > now) {
      return res.status(403).json({ error: "Cooldown is still active." });
    }
    if (!adWatched) {
      return res.status(403).json({ error: "Rewarded ad completion required." });
    }
  }

  // Authoritative selection
  const { segment, index } = selectWeightedReward(config.segments);
  const spinId = "spin_" + crypto.randomUUID();

  // Calculate next cooldown
  const nextCooldown = new Date(now.getTime() + config.cooldownMinutes * 60000);

  // Update DB state
  await db.query(`
    INSERT INTO user_spin_state (user_id, spin_type, daily_date, daily_spins_used, cooldown_until, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (user_id, spin_type) DO UPDATE SET
      daily_date = EXCLUDED.daily_date,
      daily_spins_used = CASE WHEN user_spin_state.daily_date = EXCLUDED.daily_date THEN user_spin_state.daily_spins_used + 1 ELSE 1 END,
      cooldown_until = EXCLUDED.cooldown_until,
      updated_at = NOW()
  `, [userId, spinType, today, dailySpinsUsed + 1, nextCooldown]);

  // Insert Transaction
  await db.query(`
    INSERT INTO spin_transactions (id, user_id, spin_type, segment_index, reward_type, base_coins, multiplier, final_coins, status)
    VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
  `, [spinId, userId, spinType, index, segment.type, segment.coins, segment.coins, segment.type === 'COINS' ? 'COMPLETED' : 'PENDING']);

  // If coins won, credit directly to wallet
  if (segment.type === 'COINS' && segment.coins > 0) {
    await db.query(`
      UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2
    `, [segment.coins, userId]);
  }

  return res.json({
    spinId,
    targetIndex: index,
    rewardType: segment.type,
    coinsWon: segment.coins,
    label: segment.label,
    cooldownSeconds: config.cooldownMinutes * 60
  });
};

// 3. CLAIM 2X REWARD
exports.claim2xReward = async (req, res) => {
  const { userId, spinId } = req.body;

  const txRes = await db.query(
    "SELECT * FROM spin_transactions WHERE id = $1 AND user_id = $2",
    [spinId, userId]
  );
  if (txRes.rows.length === 0) return res.status(404).json({ error: "Spin record not found" });

  const tx = txRes.rows[0];
  if (tx.is_2x_claimed) return res.status(400).json({ error: "2X already claimed for this spin" });
  if (tx.reward_type !== 'COINS' || tx.base_coins <= 0) {
    return res.status(400).json({ error: "Reward cannot be doubled" });
  }

  const additionalCoins = tx.base_coins; // Adds 1X extra to make it 2X

  await db.query(`
    UPDATE spin_transactions 
    SET multiplier = 2, final_coins = final_coins + $1, is_2x_claimed = TRUE 
    WHERE id = $2
  `, [additionalCoins, spinId]);

  await db.query(`
    UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2
  `, [additionalCoins, userId]);

  return res.json({ success: true, addedCoins: additionalCoins, totalReward: tx.base_coins * 2 });
};

// 4. RETRY VIA AD AFTER 'TRY AGAIN'
exports.claimTryAgainSpin = async (req, res) => {
  const { userId, spinId } = req.body;

  const txRes = await db.query(
    "SELECT * FROM spin_transactions WHERE id = $1 AND user_id = $2 AND reward_type = 'TRY_AGAIN'",
    [spinId, userId]
  );
  if (txRes.rows.length === 0) return res.status(404).json({ error: "Invalid spin retry attempt" });
  if (txRes.rows[0].is_try_again_claimed) {
    return res.status(400).json({ error: "Extra spin already claimed" });
  }

  // Clear cooldown to grant immediate spin
  await db.query(
    "UPDATE user_spin_state SET cooldown_until = NOW() WHERE user_id = $1 AND spin_type = $2",
    [userId, txRes.rows[0].spin_type]
  );

  await db.query(
    "UPDATE spin_transactions SET is_try_again_claimed = TRUE, status = 'COMPLETED' WHERE id = $1",
    [spinId]
  );

  return res.json({ success: true, message: "Extra spin unlocked" });
};
