// backend/routes/wallet.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

// 7-day cooldown in milliseconds
const WITHDRAWAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Conversion base: 5,000 coins
const CONVERSION_RATES = {
  COIN_BASE: 5000,
  USD: 1.0,     // 5000 coins = $1.00 USD
  NPR: 150.0,   // 5000 coins = रू 150 NPR
  INR: 90.0,    // 5000 coins = ₹ 90 INR
};

// Ensure last_withdrawal_at column exists in users table
db.run("ALTER TABLE users ADD COLUMN last_withdrawal_at TEXT", (err) => {
  // Ignore error if column already exists
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

// Default fallback payment methods (configured with min 5000 coins base)
const DEFAULT_METHODS = [
  { id: "eSewa", name: "eSewa (NPR)", icon: "🟢", min: 5000, currency: "NPR", label: "eSewa Mobile Number", hint: "98XXXXXXXX" },
  { id: "Khalti", name: "Khalti (NPR)", icon: "🟣", min: 5000, currency: "NPR", label: "Khalti Mobile Number", hint: "98XXXXXXXX" },
  { id: "UPI", name: "UPI / Paytm (INR)", icon: "🇮🇳", min: 5000, currency: "INR", label: "UPI ID / Number", hint: "user@upi" },
  { id: "PayPal", name: "PayPal (USD)", icon: "🅿️", min: 5000, currency: "USD", label: "PayPal Email Address", hint: "user@example.com" },
  { id: "USDT", name: "USDT (TRC20)", icon: "💲", min: 10000, currency: "USD", label: "TRC20 Wallet Address", hint: "T..." }
];

// Helper to calculate conversion
function convertCoins(coins) {
  return {
    usd: parseFloat(((coins / CONVERSION_RATES.COIN_BASE) * CONVERSION_RATES.USD).toFixed(2)),
    npr: parseFloat(((coins / CONVERSION_RATES.COIN_BASE) * CONVERSION_RATES.NPR).toFixed(2)),
    inr: parseFloat(((coins / CONVERSION_RATES.COIN_BASE) * CONVERSION_RATES.INR).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// 1. Payment Methods List
// ---------------------------------------------------------------------------
router.get('/payment-methods', (req, res) => {
  db.get("SELECT value FROM app_config WHERE key = 'payment_methods'", (err, config) => {
    if (err || !config || !config.value) {
      return res.json(DEFAULT_METHODS);
    }
    try {
      const methods = JSON.parse(config.value);
      res.json(methods);
    } catch {
      res.json(DEFAULT_METHODS);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Fetch User Wallet Balance & Withdrawal Cooldown Status
// ---------------------------------------------------------------------------
router.get('/', authenticateToken, (req, res) => {
  db.get('SELECT balance, last_withdrawal_at FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Profile not found' });

    let canWithdraw = true;
    let nextAvailableWithdrawal = null;
    let remainingMs = 0;

    if (user.last_withdrawal_at) {
      const lastTxTime = new Date(user.last_withdrawal_at).getTime();
      const nextTime = lastTxTime + WITHDRAWAL_COOLDOWN_MS;
      const now = Date.now();

      if (now < nextTime) {
        canWithdraw = false;
        remainingMs = nextTime - now;
        nextAvailableWithdrawal = new Date(nextTime).toISOString();
      }
    }

    const conversions = convertCoins(user.balance || 0);

    res.json({
      balance: user.balance || 0,
      converted: conversions,
      can_withdraw: canWithdraw,
      last_withdrawal_at: user.last_withdrawal_at,
      next_withdrawal_date: nextAvailableWithdrawal,
      cooldown_remaining_ms: remainingMs,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Fetch Transaction History
// ---------------------------------------------------------------------------
router.get('/transactions', authenticateToken, (req, res) => {
  db.all(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Query execution failed' });
      res.json(rows || []);
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Offerwall Credit & Streak Counter
// ---------------------------------------------------------------------------
function handleOfferwallCredit(req, res) {
  const userId = (req.user && req.user.id) ? req.user.id : (req.body.userId || req.query.userId || req.query.user_id);
  const coinAmount = parseInt(req.body.coinAmount || req.body.coins || req.query.coins || req.query.amount, 10);
  const offerId = req.body.offerId || req.query.offerId || req.query.tx_id || req.query.trans_id || `OFFER_${Date.now()}`;

  if (!userId || isNaN(coinAmount) || coinAmount <= 0) {
    return res.status(400).json({ error: 'Invalid user ID or coin amount' });
  }

  db.get(
    "SELECT id FROM transactions WHERE user_id = ? AND type = 'OFFERWALL_REWARD' AND reference_id = ?",
    [userId, offerId],
    (txErr, existingTx) => {
      if (existingTx) {
        return res.json({ success: true, message: 'Offer already credited' });
      }

      db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
          return res.status(404).json({ error: 'User not found' });
        }

        const today = getTodayStr();
        const yesterday = getYesterdayStr();

        let currentStreak = user.current_streak || 0;
        let highestStreak = user.highest_streak || 0;
        let lastStreakDate = user.last_streak_date || '';
        let streakActivatedNow = false;

        let newEligible = (user.last_eligible_date === today)
          ? ((user.eligible_daily_coins || 0) + coinAmount)
          : coinAmount;

        if (user.last_eligible_date !== today && lastStreakDate !== yesterday && lastStreakDate !== today && currentStreak > 0) {
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
              coinAmount,
              coinAmount,
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
            `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'OFFERWALL_REWARD', ?, ?)`,
            [userId, coinAmount, offerId]
          );

          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to record offerwall credit' });
            }

            res.json({
              success: true,
              creditedCoins: coinAmount,
              dailyEligibleCoins: newEligible,
              currentStreak,
              currentStone,
              streakActivatedNow,
              message: streakActivatedNow 
                ? `🔥 Streak Protected! Current Streak: ${currentStreak} Days` 
                : `+${coinAmount} Offerwall coins added to wallet!`,
            });
          });
        });
      });
    }
  );
}

router.post('/offerwall-credit', (req, res, next) => {
  if (req.headers.authorization) {
    return authenticateToken(req, res, () => handleOfferwallCredit(req, res));
  }
  handleOfferwallCredit(req, res);
});

router.all('/offerwall-postback', (req, res) => {
  handleOfferwallCredit(req, res);
});

// ---------------------------------------------------------------------------
// 5. Submit Withdrawal Request (with 7-Day Cooldown Validation)
// ---------------------------------------------------------------------------
router.post('/redeem', authenticateToken, (req, res) => {
  const { paymentMethod, accountInfo, coinAmount } = req.body;
  const userId = req.user.id;

  if (!paymentMethod || !accountInfo || !coinAmount || coinAmount <= 0) {
    return res.status(400).json({ error: 'Invalid parameters provided' });
  }

  db.get('SELECT balance, last_withdrawal_at FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User record missing' });

    // --- 1-Week Cooldown Check ---
    if (user.last_withdrawal_at) {
      const lastTxTime = new Date(user.last_withdrawal_at).getTime();
      const nextTime = lastTxTime + WITHDRAWAL_COOLDOWN_MS;
      const now = Date.now();

      if (now < nextTime) {
        const remainingHours = Math.ceil((nextTime - now) / (1000 * 60 * 60));
        const remainingDays = Math.floor(remainingHours / 24);
        return res.status(429).json({
          error: `Withdrawal cooldown active. You can withdraw once every 7 days. Next available in ${remainingDays}d ${remainingHours % 24}h.`,
          next_available: new Date(nextTime).toISOString()
        });
      }
    }

    if (user.balance < coinAmount) {
      return res.status(400).json({ error: 'Insufficient balance to complete request' });
    }

    db.get("SELECT value FROM app_config WHERE key = 'payment_methods'", (err, config) => {
      let methods = DEFAULT_METHODS;
      if (config && config.value) {
        try { methods = JSON.parse(config.value); } catch (_) {}
      }

      const methodRule = methods.find(
        m => m.id.toLowerCase() === paymentMethod.toLowerCase() || m.name.toLowerCase() === paymentMethod.toLowerCase()
      );

      if (!methodRule) {
        return res.status(400).json({ error: 'Unsupported payment gateway' });
      }

      const minCoins = methodRule.min || 5000;
      if (coinAmount < minCoins) {
        return res.status(400).json({ error: `Minimum redeem limit for ${methodRule.name} is ${minCoins.toLocaleString()} coins` });
      }

      // Compute Conversions: 5000 coins = $1 USD = 150 NPR = 90 INR
      const usdVal = parseFloat(((coinAmount / 5000) * 1.0).toFixed(2));
      const nprVal = parseFloat(((coinAmount / 5000) * 150.0).toFixed(2));
      const inrVal = parseFloat(((coinAmount / 5000) * 90.0).toFixed(2));

      const nowIso = new Date().toISOString();

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Deduct balance and update last_withdrawal_at
        db.run(
          'UPDATE users SET balance = balance - ?, last_withdrawal_at = ? WHERE id = ?',
          [coinAmount, nowIso, userId]
        );

        db.run(
          `INSERT INTO withdrawals (user_id, payment_method, account_info, coin_amount, usd_amount, status) 
           VALUES (?, ?, ?, ?, ?, 'PENDING')`,
          [userId, methodRule.name || methodRule.id, accountInfo, coinAmount, usdVal],
          function (err) {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to record withdrawal' });
            }

            const withdrawalId = this.lastID;

            db.run(
              `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'REDEEM_REQUEST', ?, ?)`,
              [userId, -coinAmount, withdrawalId.toString()],
              (txErr) => {
                if (txErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to balance account' });
                }
                db.run('COMMIT');
                res.json({
                  success: true,
                  message: `Withdrawal request submitted! (${coinAmount} coins = $${usdVal} USD / रू${nprVal} NPR / ₹${inrVal} INR). Next withdrawal unlocks in 7 days.`,
                  next_withdrawal_date: new Date(Date.now() + WITHDRAWAL_COOLDOWN_MS).toISOString()
                });
              }
            );
          }
        );
      });
    });
  });
});

module.exports = router;
