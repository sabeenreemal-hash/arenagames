// backend/routes/wallet.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

// Default fallback payment methods
const DEFAULT_METHODS = [
  { id: "eSewa", name: "eSewa", icon: "🟢", min: 10000, rate: 1000, label: "eSewa Mobile Number", hint: "98XXXXXXXX" },
  { id: "Khalti", name: "Khalti", icon: "🟣", min: 10000, rate: 1000, label: "Khalti Mobile Number", hint: "98XXXXXXXX" },
  { id: "PayPal", name: "PayPal", icon: "🅿️", min: 10000, rate: 1000, label: "PayPal Email Address", hint: "user@example.com" },
  { id: "USDT", name: "USDT (TRC20)", icon: "💲", min: 20000, rate: 1000, label: "TRC20 Wallet Address", hint: "T..." }
];

// Public route to fetch available active payment gateways
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

// Fetch user wallet balance
router.get('/', authenticateToken, (req, res) => {
  db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Profile not found' });
    res.json({ balance: user.balance });
  });
});

// Fetch user transaction history
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

// Submit a withdrawal request validated dynamically against database rules
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