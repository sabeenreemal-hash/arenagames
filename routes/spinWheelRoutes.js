// backend/routes/spinWheelRoutes.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const SPIN_COST = 500;

// Default initial prizes as specified in PRD
const DEFAULT_PRIZES = [
  { prize_key: 'try_again', label: 'Try Again', amount: 0, probability: 57.0, is_enabled: 1, color_hex: '#4A5568', icon: '❌', segment_index: 0 },
  { prize_key: 'coins_50', label: '50 Coins', amount: 50, probability: 29.0, is_enabled: 1, color_hex: '#3B82F6', icon: '🪙', segment_index: 1 },
  { prize_key: 'coins_100', label: '100 Coins', amount: 100, probability: 11.0, is_enabled: 1, color_hex: '#10B981', icon: '💰', segment_index: 2 },
  { prize_key: 'coins_500', label: '500 Coins', amount: 500, probability: 0.0, is_enabled: 0, color_hex: '#6366F1', icon: '💎', segment_index: 3 },
  { prize_key: 'coins_1000', label: '1,000 Coins', amount: 1000, probability: 1.0, is_enabled: 1, color_hex: '#F59E0B', icon: '⭐', segment_index: 4 },
  { prize_key: 'coins_5000', label: '5,000 Coins', amount: 5000, probability: 1.0, is_enabled: 1, color_hex: '#EC4899', icon: '👑', segment_index: 5 },
  { prize_key: 'coins_10000', label: '10,000 Coins', amount: 10000, probability: 1.0, is_enabled: 1, color_hex: '#8B5CF6', icon: '🏆', segment_index: 6 },
];

// Ensure tables exist & auto-seed prizes if missing
function ensurePrizesAndTargets(callback) {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS spin_prizes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prize_key TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        probability REAL NOT NULL DEFAULT 0.0,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        color_hex TEXT NOT NULL DEFAULT '#FF5722',
        icon TEXT DEFAULT '🎁',
        segment_index INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS spin_user_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        username TEXT NOT NULL,
        target_prize_key TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        spins_remaining INTEGER DEFAULT 1,
        admin_note TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.get('SELECT COUNT(*) as count FROM spin_prizes', (err, row) => {
      if (!err && row && row.count >= 7) {
        if (callback) callback();
        return;
      }

      // Seed default prizes if empty or missing
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO spin_prizes 
        (prize_key, label, amount, probability, is_enabled, color_hex, icon, segment_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const p of DEFAULT_PRIZES) {
        stmt.run([p.prize_key, p.label, p.amount, p.probability, p.is_enabled, p.color_hex, p.icon, p.segment_index]);
      }
      stmt.finalize(() => {
        console.log('✅ [SPIN WHEEL] Automatically seeded default spin_prizes.');
        if (callback) callback();
      });
    });
  });
}

// Run setup immediately on load
ensurePrizesAndTargets();

// Cryptographically secure PRNG weighted selection
function selectPrizeCryptographically(prizes) {
  const activePrizes = prizes.filter((p) => p.is_enabled === 1 && p.probability > 0);
  if (activePrizes.length === 0) return prizes[0];

  const totalWeight = activePrizes.reduce((sum, p) => sum + p.probability, 0);
  const randomUint32 = crypto.randomBytes(4).readUInt32BE(0);
  const randomRatio = randomUint32 / 0xffffffff;
  const target = randomRatio * totalWeight;

  let cumulative = 0;
  for (const prize of activePrizes) {
    cumulative += prize.probability;
    if (target <= cumulative) return prize;
  }
  return activePrizes[0];
}

// ---------------------------------------------------------------------------
// 1. Get Wheel Config
// ---------------------------------------------------------------------------
router.get('/wheel-info', (req, res) => {
  ensurePrizesAndTargets(() => {
    db.all('SELECT * FROM spin_prizes ORDER BY segment_index ASC', [], (err, prizes) => {
      if (err || !prizes || prizes.length === 0) {
        return res.json({
          success: true,
          spinCost: SPIN_COST,
          prizes: DEFAULT_PRIZES,
        });
      }

      res.json({
        success: true,
        spinCost: SPIN_COST,
        prizes: prizes.map((p) => ({
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
});

// ---------------------------------------------------------------------------
// 2. Execute Spin (with Target User Check & 500 Coin Deduction)
// ---------------------------------------------------------------------------
router.post('/execute', authenticateToken, (req, res) => {
  const userId = req.user.id;

  ensurePrizesAndTargets(() => {
    db.all('SELECT * FROM spin_prizes ORDER BY segment_index ASC', [], (err, allPrizes) => {
      if (err || !allPrizes || allPrizes.length === 0) {
        return res.status(500).json({ error: 'Wheel configuration unavailable. Please try again in a moment.' });
      }

      db.get('SELECT id, username, balance FROM users WHERE id = ?', [userId], (uErr, user) => {
        if (uErr || !user) return res.status(404).json({ error: 'User profile not found' });

        if (user.balance < SPIN_COST) {
          return res.status(400).json({
            error: `Insufficient coins. You have ${user.balance} coins, but ${SPIN_COST} coins are required.`,
            balance: user.balance,
          });
        }

        // Check if there is an active admin target set for this user
        db.get(
          'SELECT * FROM spin_user_targets WHERE user_id = ? AND is_active = 1 AND spins_remaining > 0',
          [userId],
          (targetErr, activeTarget) => {
            let selectedPrize = null;
            let consumedTargetId = null;

            if (activeTarget) {
              selectedPrize = allPrizes.find((p) => p.prize_key === activeTarget.target_prize_key);
              if (selectedPrize) {
                consumedTargetId = activeTarget.id;
                console.log(`🎯 [TARGET EXECUTION] User: ${user.username} received forced target: ${selectedPrize.label}`);
              }
            }

            // Normal PRNG fallback if no active target
            if (!selectedPrize) {
              selectedPrize = selectPrizeCryptographically(allPrizes);
            }

            const spinId = `SPIN_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
            const rewardAmount = selectedPrize.amount;
            const netChange = rewardAmount - SPIN_COST;
            const finalBalance = user.balance + netChange;

            db.serialize(() => {
              db.run('BEGIN IMMEDIATE TRANSACTION');

              // Deduct cost and credit win
              db.run(
                `UPDATE users 
                 SET balance = balance + ?, 
                     total_coins_earned = total_coins_earned + ? 
                 WHERE id = ?`,
                [netChange, rewardAmount > 0 ? rewardAmount : 0, userId]
              );

              // Deduct 500 Entry
              db.run(
                `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'SPIN_ENTRY', ?, ?)`,
                [userId, -SPIN_COST, `${spinId}_COST`]
              );

              // Credit Reward if > 0
              if (rewardAmount > 0) {
                db.run(
                  `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, ?, ?, ?)`,
                  [userId, `SPIN_REWARD_${rewardAmount}`, rewardAmount, `${spinId}_WIN`]
                );
              }

              // Audit in spin_history
              db.run(
                `INSERT INTO spin_history 
                  (id, user_id, username, spin_cost, prize_id, prize_label, reward_amount, is_demo) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
                [spinId, userId, user.username, SPIN_COST, selectedPrize.id, selectedPrize.label, rewardAmount]
              );

              // Update target quota if consumed
              if (consumedTargetId) {
                db.run(
                  `UPDATE spin_user_targets 
                   SET spins_remaining = spins_remaining - 1, 
                       is_active = CASE WHEN spins_remaining - 1 <= 0 THEN 0 ELSE 1 END 
                   WHERE id = ?`,
                  [consumedTargetId]
                );
              }

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Failed to complete spin transaction' });
                }

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
          }
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. User History, Recent Winners, Leaderboard
// ---------------------------------------------------------------------------
router.get('/recent-winners', (req, res) => {
  db.all(
    `SELECT sh.id as spin_id, sh.username, sh.reward_amount, sh.created_at, p.icon
     FROM spin_history sh
     LEFT JOIN spin_prizes p ON sh.prize_id = p.id
     WHERE sh.reward_amount > 0 AND sh.is_demo = 0
     ORDER BY sh.created_at DESC LIMIT 20`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch winners' });
      res.json({ success: true, winners: rows || [] });
    }
  );
});

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
// 4. Admin Target Users API
// ---------------------------------------------------------------------------
router.get('/admin/targets', (req, res) => {
  db.all('SELECT * FROM spin_user_targets ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, targets: rows || [] });
  });
});

router.post('/admin/targets', (req, res) => {
  const { username, targetPrizeKey, spinsCount = 1, adminNote = '' } = req.body;

  if (!username || !targetPrizeKey) {
    return res.status(400).json({ error: 'Username and Target Prize Key are required' });
  }

  db.get('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE', [username.trim()], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: `User '${username}' not found in Arena Games database.` });
    }

    db.run(
      `INSERT INTO spin_user_targets (user_id, username, target_prize_key, is_active, spins_remaining, admin_note)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET 
         target_prize_key = excluded.target_prize_key,
         is_active = 1,
         spins_remaining = excluded.spins_remaining,
         admin_note = excluded.admin_note`,
      [user.id, user.username, targetPrizeKey, parseInt(spinsCount, 10) || 1, adminNote],
      (insErr) => {
        if (insErr) return res.status(500).json({ error: insErr.message });
        console.log(`🎯 [TARGET SET] Admin set target for ${user.username} -> ${targetPrizeKey} (${spinsCount} spins)`);
        res.json({ success: true, message: `Target set successfully for user ${user.username}!` });
      }
    );
  });
});

router.delete('/admin/targets/:id', (req, res) => {
  db.run('DELETE FROM spin_user_targets WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Target removed successfully' });
  });
});

router.get('/admin/search-users', (req, res) => {
  const q = req.query.q ? `%${req.query.q.trim()}%` : '%';
  db.all('SELECT id, username, balance FROM users WHERE username LIKE ? LIMIT 10', [q], (err, users) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, users: users || [] });
  });
});

// ---------------------------------------------------------------------------
// 5. Admin Dashboard & Odds Settings
// ---------------------------------------------------------------------------
router.get('/admin/dashboard', (req, res) => {
  db.get(
    `SELECT 
      COUNT(*) as total_spins,
      COUNT(DISTINCT user_id) as total_users,
      COALESCE(SUM(spin_cost), 0) as total_coins_spent,
      COALESCE(SUM(reward_amount), 0) as total_coins_rewarded,
      SUM(CASE WHEN reward_amount > 0 THEN 1 ELSE 0 END) as total_wins,
      SUM(CASE WHEN reward_amount = 0 THEN 1 ELSE 0 END) as total_try_again
    FROM spin_history WHERE is_demo = 0`,
    [],
    (err, stats) => {
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
    }
  );
});

router.put('/admin/prizes', (req, res) => {
  const { prizes } = req.body;
  if (!Array.isArray(prizes)) return res.status(400).json({ error: 'Prizes array is required' });

  let enabledSum = 0;
  for (const p of prizes) {
    if (p.isEnabled) enabledSum += parseFloat(p.probability) || 0;
  }

  if (Math.abs(enabledSum - 100.0) > 0.1) {
    return res.status(400).json({ error: `Enabled probabilities must equal 100%. Current sum: ${enabledSum.toFixed(1)}%` });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('UPDATE spin_prizes SET probability = ?, is_enabled = ? WHERE id = ?');
    for (const p of prizes) {
      stmt.run([p.probability, p.isEnabled ? 1 : 0, p.id]);
    }
    stmt.finalize();
    db.run('COMMIT', (commitErr) => {
      if (commitErr) return res.status(500).json({ error: 'Failed to update odds' });
      res.json({ success: true, message: 'Odds updated successfully!' });
    });
  });
});

module.exports = router;
