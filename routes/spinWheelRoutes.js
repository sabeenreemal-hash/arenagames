// backend/routes/spinWheelRoutes.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const SPIN_COST = 500;

// Secure Server-side PRNG Weighted Selection
function selectPrizeCryptographically(prizes) {
  // Only include active prizes with probability > 0
  const activePrizes = prizes.filter(p => p.is_enabled === 1 && p.probability > 0);
  const totalWeight = activePrizes.reduce((sum, p) => sum + p.probability, 0);

  // Generate random float between 0 and totalWeight using crypto
  const randomUint32 = crypto.randomBytes(4).readUInt32BE(0);
  const randomRatio = randomUint32 / 0xFFFFFFFF;
  const target = randomRatio * totalWeight;

  let cumulative = 0;
  for (const prize of activePrizes) {
    cumulative += prize.probability;
    if (target <= cumulative) {
      return prize;
    }
  }
  return activePrizes[0];
}

// ---------------------------------------------------------------------------
// 1. Player: Get Current Wheel Segments & Probabilities
// ---------------------------------------------------------------------------
router.get('/wheel-info', (req, res) => {
  db.all('SELECT * FROM spin_prizes ORDER BY segment_index ASC', [], (err, prizes) => {
    if (err) return res.status(500).json({ error: 'Failed to load wheel configuration' });

    res.json({
      success: true,
      spinCost: SPIN_COST,
      prizes: prizes.map(p => ({
        id: p.id,
        key: p.prize_key,
        label: p.label,
        amount: p.amount,
        probability: p.probability,
        isEnabled: p.is_enabled === 1,
        colorHex: p.color_hex,
        icon: p.icon,
        segmentIndex: p.segment_index,
      })),
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Player: Execute Spin (Atomic 500-Coin Deduction & Crediting)
// ---------------------------------------------------------------------------
router.post('/execute', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.all('SELECT * FROM spin_prizes WHERE is_enabled = 1 AND probability > 0', [], (err, prizes) => {
    if (err || !prizes || prizes.length === 0) {
      return res.status(500).json({ error: 'Wheel configuration unavailable' });
    }

    db.get('SELECT id, username, balance FROM users WHERE id = ?', [userId], (uErr, user) => {
      if (uErr || !user) return res.status(404).json({ error: 'User profile not found' });

      if (user.balance < SPIN_COST) {
        return res.status(400).json({
          error: `Insufficient coins. You have ${user.balance} coins, but ${SPIN_COST} coins are required.`,
          balance: user.balance,
        });
      }

      // Secure result pick
      const selectedPrize = selectPrizeCryptographically(prizes);
      const spinId = `SPIN_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const rewardAmount = selectedPrize.amount;
      const netChange = rewardAmount - SPIN_COST;
      const finalBalance = user.balance + netChange;

      // Atomic SQLite write transaction
      db.serialize(() => {
        db.run('BEGIN IMMEDIATE TRANSACTION');

        // 1. Deduct cost & credit reward to User balance
        db.run(
          `UPDATE users 
           SET balance = balance + ?, 
               total_coins_earned = total_coins_earned + ? 
           WHERE id = ?`,
          [netChange, rewardAmount > 0 ? rewardAmount : 0, userId]
        );

        // 2. Insert Entry Fee Transaction
        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) 
           VALUES (?, 'SPIN_ENTRY', ?, ?)`,
          [userId, -SPIN_COST, `${spinId}_COST`]
        );

        // 3. Insert Reward Transaction (if win > 0)
        if (rewardAmount > 0) {
          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) 
             VALUES (?, ?, ?, ?)`,
            [userId, `SPIN_REWARD_${rewardAmount}`, rewardAmount, `${spinId}_WIN`]
          );
        }

        // 4. Record Spin Audit in spin_history
        db.run(
          `INSERT INTO spin_history 
            (id, user_id, username, spin_cost, prize_id, prize_label, reward_amount, is_demo) 
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
          [spinId, userId, user.username, SPIN_COST, selectedPrize.id, selectedPrize.label, rewardAmount]
        );

        db.run('COMMIT', (commitErr) => {
          if (commitErr) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Failed to process spin transaction' });
          }

          console.log(`🎰 [SPIN COMPLETED] User: ${user.username} (${userId}) Result: ${selectedPrize.label} Net: ${netChange}`);

          res.json({
            success: true,
            spinId,
            selectedSegment: selectedPrize.segment_index,
            prize: {
              id: selectedPrize.id,
              key: selectedPrize.prize_key,
              label: selectedPrize.label,
              amount: rewardAmount,
              icon: selectedPrize.icon,
            },
            newBalance: finalBalance,
            isWin: rewardAmount > 0,
          });
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Player: Recent Winners
// ---------------------------------------------------------------------------
router.get('/recent-winners', (req, res) => {
  db.all(
    `SELECT sh.id as spin_id, sh.username, sh.reward_amount, sh.created_at, p.icon
     FROM spin_history sh
     JOIN spin_prizes p ON sh.prize_id = p.id
     WHERE sh.reward_amount > 0 AND sh.is_demo = 0
     ORDER BY sh.created_at DESC LIMIT 20`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch winners' });

      db.get(
        `SELECT COUNT(DISTINCT user_id) as total_winners, 
                SUM(reward_amount) as total_coins_distributed, 
                COUNT(*) as total_spins 
         FROM spin_history WHERE is_demo = 0`,
        [],
        (sErr, stats) => {
          res.json({
            success: true,
            winners: rows || [],
            stats: {
              totalWinners: (stats && stats.total_winners) || 0,
              totalDistributed: (stats && stats.total_coins_distributed) || 0,
              totalSpins: (stats && stats.total_spins) || 0,
            },
          });
        }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Player: My Spin History
// ---------------------------------------------------------------------------
router.get('/my-history', authenticateToken, (req, res) => {
  db.all(
    `SELECT id, spin_cost, prize_label, reward_amount, created_at 
     FROM spin_history 
     WHERE user_id = ? AND is_demo = 0 
     ORDER BY created_at DESC LIMIT 50`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to load history' });
      res.json({ success: true, history: rows || [] });
    }
  );
});

// ---------------------------------------------------------------------------
// 5. Player: Spin Leaderboard (Weekly, Monthly, All-time)
// ---------------------------------------------------------------------------
router.get('/leaderboard', (req, res) => {
  const timeframe = req.query.type || 'weekly';
  let dateFilter = "DATETIME('now', '-7 days')";
  if (timeframe === 'monthly') dateFilter = "DATETIME('now', '-30 days')";
  if (timeframe === 'all_time') dateFilter = "DATETIME('1970-01-01')";

  const query = `
    SELECT user_id, username, 
           COUNT(*) as total_spins, 
           SUM(reward_amount) as total_won, 
           MAX(reward_amount) as biggest_win
    FROM spin_history
    WHERE is_demo = 0 AND created_at >= ${dateFilter}
    GROUP BY user_id, username
    ORDER BY total_won DESC LIMIT 30
  `;

  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch leaderboard' });
    res.json({ success: true, leaderboard: rows || [] });
  });
});

// ---------------------------------------------------------------------------
// 6. Demo Sandbox Execution (100,000 Starting Virtual Coins)
// ---------------------------------------------------------------------------
router.post('/demo/execute', (req, res) => {
  const demoBalance = parseInt(req.body.demoBalance, 10) || 100000;

  if (demoBalance < SPIN_COST) {
    return res.status(400).json({ error: 'Insufficient demo coins. Please reset demo wallet.' });
  }

  db.all('SELECT * FROM spin_prizes WHERE is_enabled = 1 AND probability > 0', [], (err, prizes) => {
    if (err || !prizes) return res.status(500).json({ error: 'Prizes unavailable' });

    const selectedPrize = selectPrizeCryptographically(prizes);
    const rewardAmount = selectedPrize.amount;
    const newDemoBalance = demoBalance - SPIN_COST + rewardAmount;
    const spinId = `DEMO_${Date.now()}`;

    res.json({
      success: true,
      spinId,
      selectedSegment: selectedPrize.segment_index,
      prize: selectedPrize,
      newBalance: newDemoBalance,
      isWin: rewardAmount > 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Admin: Statistics & Dashboard
// ---------------------------------------------------------------------------
router.get('/admin/dashboard', (req, res) => {
  const query = `
    SELECT 
      COUNT(*) as total_spins,
      COUNT(DISTINCT user_id) as total_users,
      SUM(spin_cost) as total_coins_spent,
      SUM(reward_amount) as total_coins_rewarded,
      SUM(CASE WHEN reward_amount > 0 THEN 1 ELSE 0 END) as total_wins,
      SUM(CASE WHEN reward_amount = 0 THEN 1 ELSE 0 END) as total_try_again
    FROM spin_history WHERE is_demo = 0
  `;

  db.get(query, [], (err, stats) => {
    if (err) return res.status(500).json({ error: err.message });
    const spent = (stats && stats.total_coins_spent) || 0;
    const rewarded = (stats && stats.total_coins_rewarded) || 0;

    res.json({
      success: true,
      stats: {
        totalSpins: (stats && stats.total_spins) || 0,
        totalUsers: (stats && stats.total_users) || 0,
        totalCoinsSpent: spent,
        totalCoinsRewarded: rewarded,
        netMargin: spent - rewarded,
        totalWins: (stats && stats.total_wins) || 0,
        totalTryAgain: (stats && stats.total_try_again) || 0,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Admin: Prize & Probability Management (Strict 100% Validation)
// ---------------------------------------------------------------------------
router.put('/admin/prizes', (req, res) => {
  const { prizes, adminUsername = 'admin', reason = 'Admin updated odds' } = req.body;

  if (!Array.isArray(prizes)) {
    return res.status(400).json({ error: 'Prizes must be provided as an array' });
  }

  // 1. Calculate sum of enabled probabilities
  let enabledSum = 0;
  for (const p of prizes) {
    if (p.isEnabled) {
      const prob = parseFloat(p.probability);
      if (isNaN(prob) || prob < 0) {
        return res.status(400).json({ error: `Invalid probability value for ${p.label}` });
      }
      enabledSum += prob;
    }
  }

  // 2. Strict 100% validation check
  if (Math.abs(enabledSum - 100.0) > 0.001) {
    return res.status(400).json({
      error: `Total probability of enabled outcomes must equal exactly 100%. Current sum: ${enabledSum.toFixed(2)}%`,
    });
  }

  // 3. Atomically update prize table & write version log
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    const updateStmt = db.prepare(`
      UPDATE spin_prizes 
      SET probability = ?, is_enabled = ?, label = ?, color_hex = ?
      WHERE id = ?
    `);

    for (const p of prizes) {
      updateStmt.run([
        p.probability,
        p.isEnabled ? 1 : 0,
        p.label,
        p.colorHex,
        p.id,
      ]);
    }
    updateStmt.finalize();

    // Log admin audit
    db.run(
      `INSERT INTO spin_admin_logs (admin_username, action_type, details) VALUES (?, 'UPDATE_PROBABILITIES', ?)`,
      [adminUsername, `Reason: ${reason}; Snapshot: ${JSON.stringify(prizes)}`]
    );

    db.run('COMMIT', (commitErr) => {
      if (commitErr) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'Failed to update probabilities' });
      }
      res.json({ success: true, message: 'Prize configuration saved successfully!' });
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Admin: Complete Spin Audit Records
// ---------------------------------------------------------------------------
router.get('/admin/records', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const search = req.query.search ? `%${req.query.search.trim()}%` : null;

  let query = 'SELECT * FROM spin_history WHERE 1=1';
  const params = [];

  if (search) {
    query += ' AND (username LIKE ? OR id LIKE ?)';
    params.push(search, search);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, records: rows || [] });
  });
});

module.exports = router;
