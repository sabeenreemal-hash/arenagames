// backend/routes/wallet.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

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

// Default fallback payment methods
const DEFAULT_METHODS = [
  { id: "eSewa", name: "eSewa", icon: "🟢", min: 10000, rate: 1000, label: "eSewa Mobile Number", hint: "98XXXXXXXX" },
  { id: "Khalti", name: "Khalti", icon: "🟣", min: 10000, rate: 1000, label: "Khalti Mobile Number", hint: "98XXXXXXXX" },
  { id: "PayPal", name: "PayPal", icon: "🅿️", min: 10000, rate: 1000, label: "PayPal Email Address", hint: "user@example.com" },
  { id: "USDT", name: "USDT (TRC20)", icon: "💲", min: 20000, rate: 1000, label: "TRC20 Wallet Address", hint: "T..." }
];

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
// 2. Fetch User Wallet Balance
// ---------------------------------------------------------------------------
router.get('/', authenticateToken, (req, res) => {
  db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Profile not found' });
    res.json({ balance: user.balance });
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
// 4. Offerwall Credit & Streak Counter (NEW)
// Only offerwall completions count toward eligible daily streak coins.
// ---------------------------------------------------------------------------
function handleOfferwallCredit(req, res) {
  // Supports token auth (req.user.id) or direct postback params (userId)
  const userId = (req.user && req.user.id) ? req.user.id : (req.body.userId || req.query.userId || req.query.user_id);
  const coinAmount = parseInt(req.body.coinAmount || req.body.coins || req.query.coins || req.query.amount, 10);
  const offerId = req.body.offerId || req.query.offerId || req.query.tx_id || req.query.trans_id || `OFFER_${Date.now()}`;

  if (!userId || isNaN(coinAmount) || coinAmount <= 0) {
    return res.status(400).json({ error: 'Invalid user ID or coin amount' });
  }

  // Prevent duplicate credit for the same offer transaction ID
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

        // 1. Calculate today's eligible coins (Exclusively from Offerwall credits)
        let newEligible = (user.last_eligible_date === today)
          ? ((user.eligible_daily_coins || 0) + coinAmount)
          : coinAmount;

        // 2. Check if streak broke yesterday (missed the 100-coin requirement yesterday)
        if (user.last_eligible_date !== today && lastStreakDate !== yesterday && lastStreakDate !== today && currentStreak > 0) {
          currentStreak = 0; // Streak broken
        }

        // 3. Milestone check: crossing >= 100 Offerwall coins activates today's streak
        if (newEligible >= 100 && lastStreakDate !== today) {
          currentStreak += 1;
          lastStreakDate = today;
          streakActivatedNow = true;

          if (currentStreak > highestStreak) {
            highestStreak = currentStreak;
          }
        }

        // 4. Recalculate Active Stone Badge
        const currentStone = calculateStoneBadge(currentStreak);

        // 5. Database write
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

            console.log(`[OFFERWALL] Credited +${coinAmount} to User ${userId}. Streak: ${currentStreak}d. Progress: ${newEligible}/100`);

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

// App endpoint (can accept JWT auth header if provided, or body userId)
router.post('/offerwall-credit', (req, res, next) => {
  if (req.headers.authorization) {
    return authenticateToken(req, res, () => handleOfferwallCredit(req, res));
  }
  handleOfferwallCredit(req, res);
});

// Network postback endpoint (accepts GET/POST webhooks from offerwall networks)
router.all('/offerwall-postback', (req, res) => {
  handleOfferwallCredit(req, res);
});

// ---------------------------------------------------------------------------
// 5. Submit Withdrawal Request
// ---------------------------------------------------------------------------
router.post('/redeem', authenticateToken, (req, res) => {
  const { paymentMethod, accountInfo, coinAmount } = req.body;
  const userId = req.user.id;

  if (!paymentMethod || !accountInfo || !coinAmount || coinAmount <= 0) {
    return res.status(400).json({ error: 'Invalid parameters provided' });
  }

  db.get('SELECT balance FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User record missing' });

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

      const minCoins = methodRule.min || 10000;
      const rate = methodRule.rate || 1000; // 1000 coins = $1.00 USD

      if (coinAmount < minCoins) {
        return res.status(400).json({ error: `Minimum redeem limit for ${methodRule.name} is ${minCoins.toLocaleString()} coins` });
      }

      const usdVal = coinAmount / rate;

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [coinAmount, userId]);

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
                  message: `Withdrawal of ${coinAmount} coins ($${usdVal.toFixed(2)} USD) requested!`,
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
