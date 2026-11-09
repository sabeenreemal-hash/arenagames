// backend/routes/wallet.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');
const { creditReferralCommission } = require('../services/referralService');

// 7-day cooldown in milliseconds
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Fixed redemption tiers (Coins -> NPR)
const REDEMPTION_TIERS = [
  { coins: 5000, npr: 50 },
  { coins: 10000, npr: 100 },
  { coins: 20000, npr: 200 }
];

// Supported payment methods
const SUPPORTED_PAYMENT_METHODS = [
  {
    id: "eSewa",
    name: "eSewa",
    icon: "🟢",
    label: "eSewa Mobile Number",
    hint: "98XXXXXXXX"
  },
  {
    id: "Khalti",
    name: "Khalti",
    icon: "🟣",
    label: "Khalti Mobile Number",
    hint: "98XXXXXXXX"
  }
];

// ---------------------------------------------------------------------------
// 0. Auto-Migrate Database Schema Safely
// ---------------------------------------------------------------------------
db.serialize(() => {
  // Ensure withdrawals table exists with all required columns
  db.run(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      account_info TEXT NOT NULL,
      coin_amount INTEGER NOT NULL,
      npr_amount REAL,
      usd_amount REAL,
      status TEXT DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME
    )
  `);

  // Auto-add columns if migrating from an older database schema
  db.run("ALTER TABLE withdrawals ADD COLUMN npr_amount REAL", () => {});
  db.run("ALTER TABLE withdrawals ADD COLUMN usd_amount REAL", () => {});
  db.run("ALTER TABLE withdrawals ADD COLUMN processed_at DATETIME", () => {});
  db.run("ALTER TABLE users ADD COLUMN last_withdrawal_at TEXT", () => {});
});

// Helper: Safely insert withdrawal record regardless of older SQLite schema constraints
function insertWithdrawalRecord(userId, paymentMethod, accountInfo, coinAmount, nprAmount, usdAmount, callback) {
  db.all("PRAGMA table_info(withdrawals)", (err, columns) => {
    const colNames = (columns || []).map(c => c.name);
    const hasNpr = colNames.includes('npr_amount');
    const hasUsd = colNames.includes('usd_amount');

    // Build query matching existing database columns to avoid SQLITE_ERROR
    if (hasNpr && hasUsd) {
      db.run(
        `INSERT INTO withdrawals (user_id, payment_method, account_info, coin_amount, npr_amount, usd_amount, status) 
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
        [userId, paymentMethod, accountInfo, coinAmount, nprAmount, usdAmount],
        callback
      );
    } else if (hasNpr) {
      db.run(
        `INSERT INTO withdrawals (user_id, payment_method, account_info, coin_amount, npr_amount, status) 
         VALUES (?, ?, ?, ?, ?, 'PENDING')`,
        [userId, paymentMethod, accountInfo, coinAmount, nprAmount],
        callback
      );
    } else if (hasUsd) {
      db.run(
        `INSERT INTO withdrawals (user_id, payment_method, account_info, coin_amount, usd_amount, status) 
         VALUES (?, ?, ?, ?, ?, 'PENDING')`,
        [userId, paymentMethod, accountInfo, coinAmount, usdAmount],
        callback
      );
    } else {
      db.run(
        `INSERT INTO withdrawals (user_id, payment_method, account_info, coin_amount, status) 
         VALUES (?, ?, ?, ?, 'PENDING')`,
        [userId, paymentMethod, accountInfo, coinAmount],
        callback
      );
    }
  });
}

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

// ---------------------------------------------------------------------------
// 1. Get Payment Methods & Redemption Tiers
// ---------------------------------------------------------------------------
router.get('/payment-methods', (req, res) => {
  res.json({
    methods: SUPPORTED_PAYMENT_METHODS,
    tiers: REDEMPTION_TIERS
  });
});

// ---------------------------------------------------------------------------
// 2. Fetch User Wallet Balance, Cooldown, and Pending Status
// ---------------------------------------------------------------------------
router.get('/', authenticateToken, (req, res) => {
  db.get(
    'SELECT id, balance, created_at, last_withdrawal_at FROM users WHERE id = ?',
    [req.user.id],
    (err, user) => {
      if (err || !user) return res.status(404).json({ error: 'Profile not found' });

      // Check if user has an ongoing pending withdrawal
      db.get(
        "SELECT * FROM withdrawals WHERE user_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
        [req.user.id],
        (wErr, pendingWithdrawal) => {
          const now = Date.now();
          let canWithdraw = true;
          let lockReason = null;
          let nextAvailableWithdrawal = null;
          let remainingMs = 0;

          // Rule 1: Account age must be at least 7 days
          if (user.created_at) {
            const joinTime = new Date(user.created_at).getTime();
            const minAllowedTime = joinTime + SEVEN_DAYS_MS;
            if (now < minAllowedTime) {
              canWithdraw = false;
              remainingMs = minAllowedTime - now;
              nextAvailableWithdrawal = new Date(minAllowedTime).toISOString();
              lockReason = 'ACCOUNT_AGE_RESTRICTION';
            }
          }

          // Rule 2: 7-day cooldown from previous successful redemption
          if (canWithdraw && user.last_withdrawal_at) {
            const lastTime = new Date(user.last_withdrawal_at).getTime();
            const nextUnlockTime = lastTime + SEVEN_DAYS_MS;
            if (now < nextUnlockTime) {
              canWithdraw = false;
              remainingMs = nextUnlockTime - now;
              nextAvailableWithdrawal = new Date(nextUnlockTime).toISOString();
              lockReason = 'WEEKLY_COOLDOWN_ACTIVE';
            }
          }

          // Rule 3: Cannot request if already has a pending withdrawal
          const hasPending = !!pendingWithdrawal;
          if (hasPending) {
            canWithdraw = false;
            if (!lockReason) lockReason = 'PENDING_REQUEST_EXISTS';
          }

          res.json({
            balance: user.balance || 0,
            can_withdraw: canWithdraw,
            has_pending: hasPending,
            pending_withdrawal: pendingWithdrawal || null,
            lock_reason: lockReason,
            next_withdrawal_date: nextAvailableWithdrawal,
            cooldown_remaining_ms: remainingMs,
            tiers: REDEMPTION_TIERS
          });
        }
      );
    }
  );
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

            creditReferralCommission(userId, coinAmount, 'OFFERWALL', offerId, 0.10);

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
// 5. Submit Fixed Redemption Request (eSewa / Khalti)
// ---------------------------------------------------------------------------
router.post('/redeem', authenticateToken, (req, res) => {
  const { paymentMethod, accountInfo, coinAmount } = req.body;
  const userId = req.user.id;
  const parsedCoins = parseInt(coinAmount, 10);

  // 1. Validate fixed tier
  const matchedTier = REDEMPTION_TIERS.find(t => t.coins === parsedCoins);
  if (!matchedTier) {
    return res.status(400).json({ 
      error: 'Invalid redemption tier. You can only redeem 5,000, 10,000, or 20,000 coins.' 
    });
  }

  // 2. Validate Payment Method (eSewa or Khalti only)
  const normalizedMethod = (paymentMethod || '').trim().toLowerCase();
  let selectedMethod = null;
  if (normalizedMethod === 'esewa') {
    selectedMethod = 'eSewa';
  } else if (normalizedMethod === 'khalti') {
    selectedMethod = 'Khalti';
  } else {
    return res.status(400).json({ error: 'Invalid payment method. Only eSewa and Khalti are supported.' });
  }

  // 3. Validate Nepali 10-Digit Mobile Number (starts with 98 or 97)
  const cleanMobile = (accountInfo || '').toString().trim();
  const nepalPhoneRegex = /^(98|97)\d{8}$/;
  if (!nepalPhoneRegex.test(cleanMobile)) {
    return res.status(400).json({ 
      error: 'Invalid mobile number. Please enter a valid 10-digit Nepali number starting with 98 or 97.' 
    });
  }

  // 4. Retrieve User and Check Rules
  db.get('SELECT balance, created_at, last_withdrawal_at FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User record not found.' });

    const now = Date.now();

    // Account age check: at least 7 days
    if (user.created_at) {
      const joinTime = new Date(user.created_at).getTime();
      if (now - joinTime < SEVEN_DAYS_MS) {
        const remainingDays = Math.ceil((joinTime + SEVEN_DAYS_MS - now) / (1000 * 60 * 60 * 24));
        return res.status(403).json({
          error: `New accounts must wait 7 days before making their first redemption. Available in ${remainingDays} day(s).`
        });
      }
    }

    // Weekly cooldown check: at least 7 days from last successful withdrawal
    if (user.last_withdrawal_at) {
      const lastTime = new Date(user.last_withdrawal_at).getTime();
      if (now - lastTime < SEVEN_DAYS_MS) {
        const remainingHours = Math.ceil((lastTime + SEVEN_DAYS_MS - now) / (1000 * 60 * 60));
        const remainingDays = Math.floor(remainingHours / 24);
        return res.status(429).json({
          error: `Weekly cooldown active. You can redeem once every 7 days. Next available in ${remainingDays}d ${remainingHours % 24}h.`
        });
      }
    }

    // Check available balance
    if ((user.balance || 0) < parsedCoins) {
      return res.status(400).json({
        error: `Insufficient coins. You have ${user.balance || 0} coins, but ${parsedCoins} coins are required.`
      });
    }

    // Check for duplicate pending requests
    db.get(
      "SELECT id FROM withdrawals WHERE user_id = ? AND status = 'PENDING'",
      [userId],
      (wErr, pendingWithdrawal) => {
        if (pendingWithdrawal) {
          return res.status(400).json({
            error: 'You already have a pending redemption request. Please wait until it is processed by the admin.'
          });
        }

        // Backward compatibility: calculate approximate USD equivalent so legacy NOT NULL columns are satisfied
        const usdVal = parseFloat((parsedCoins / 5000.0).toFixed(2));

        // Insert using safe multi-column adapter
        insertWithdrawalRecord(
          userId,
          selectedMethod,
          cleanMobile,
          parsedCoins,
          matchedTier.npr,
          usdVal,
          function (insertErr) {
            if (insertErr) {
              console.error('[Withdrawal DB Insert Error]:', insertErr);
              return res.status(500).json({ error: 'Failed to record redemption request: ' + insertErr.message });
            }

            const withdrawalId = this.lastID;

            // Audit transaction record (amount = 0 while pending to preserve balance)
            db.run(
              `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'REDEEM_REQUEST', 0, ?)`,
              [userId, withdrawalId.toString()],
              (tErr) => {
                if (tErr) {
                  console.error('[Transaction Audit Error]:', tErr);
                }
                res.json({
                  success: true,
                  message: `Redemption request of ${parsedCoins.toLocaleString()} coins for NPR ${matchedTier.npr} submitted successfully! Your coins will be deducted once verified and approved.`,
                  pending_id: withdrawalId,
                  coin_amount: parsedCoins,
                  npr_amount: matchedTier.npr,
                  payment_method: selectedMethod
                });
              }
            );
          }
        );
      }
    );
  });
});

module.exports = router;
