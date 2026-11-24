// backend/routes/spinWheelRoutes.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const SPIN_COST = 500;

// Official PRD Initial Prize Distribution
const DEFAULT_PRIZES = [
  { prize_key: 'try_again', label: 'Try Again', amount: 0, probability: 57.0, is_enabled: 1, color_hex: '#4A5568', icon: '❌', segment_index: 0 },
  { prize_key: 'coins_50', label: '50 Coins', amount: 50, probability: 29.0, is_enabled: 1, color_hex: '#3B82F6', icon: '🪙', segment_index: 1 },
  { prize_key: 'coins_100', label: '100 Coins', amount: 100, probability: 11.0, is_enabled: 1, color_hex: '#10B981', icon: '💰', segment_index: 2 },
  { prize_key: 'coins_500', label: '500 Coins', amount: 500, probability: 0.0, is_enabled: 0, color_hex: '#6366F1', icon: '💎', segment_index: 3 }, // 0% Disabled as per PRD
  { prize_key: 'coins_1000', label: '1,000 Coins', amount: 1000, probability: 1.0, is_enabled: 1, color_hex: '#F59E0B', icon: '⭐', segment_index: 4 },
  { prize_key: 'coins_5000', label: '5,000 Coins', amount: 5000, probability: 1.0, is_enabled: 1, color_hex: '#EC4899', icon: '👑', segment_index: 5 },
  { prize_key: 'coins_10000', label: '10,000 Coins', amount: 10000, probability: 1.0, is_enabled: 1, color_hex: '#8B5CF6', icon: '🏆', segment_index: 6 },
];

// ==========================================
// 0. Auto-Migration & Table Verifier
// ==========================================
function ensureSpinSchema(callback) {
  db.serialize(() => {
    // 1. Prizes table
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

    // 2. User Target Overrides
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

    // 3. Spin History Ledger
    db.run(`
      CREATE TABLE IF NOT EXISTS spin_history (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        spin_cost INTEGER NOT NULL DEFAULT 500,
        prize_id INTEGER NOT NULL,
        prize_label TEXT NOT NULL,
        reward_amount INTEGER NOT NULL DEFAULT 0,
        config_version INTEGER DEFAULT 1,
        is_demo INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Check seed status
    db.get('SELECT COUNT(*) as count FROM spin_prizes', (err, row) => {
      if (!err && row && row.count >= 7) {
        if (callback) callback();
        return;
      }

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO spin_prizes 
        (prize_key, label, amount, probability, is_enabled, color_hex, icon, segment_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const p of DEFAULT_PRIZES) {
        stmt.run([p.prize_key, p.label, p.amount, p.probability, p.is_enabled, p.color_hex, p.icon, p.segment_index]);
      }

      stmt.finalize(() => {
        console.log('✅ [SPIN WHEEL] Seeded 7 standard prize tiers into spin_prizes.');
        if (callback) callback();
      });
    });
  });
}

// Initialize tables on startup
ensureSpinSchema();

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
// 1. Get Wheel Config & Segments
// ---------------------------------------------------------------------------
router.get('/wheel-info', (req, res) => {
  ensureSpinSchema(() => {
    db.all('SELECT * FROM spin_prizes ORDER BY segment_index ASC', [], (err, prizes) => {
      if (err || !prizes || prizes.length === 0) {
        return res.json({
          success: true,
          spinCost: SPIN_COST,
          prizes: DEFAULT_PRIZES.map((p, idx) => ({
            id: idx + 1,
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
// 2. Execute Spin (500-Coin Deduction + Target Outcome Handling)
// ---------------------------------------------------------------------------
router.post('/execute', authenticateToken, (req, res) => {
  const userId = req.user ? (req.user.id || req.user.userId) : null;

  if (!userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
  }

  ensureSpinSchema(() => {
    db.all('SELECT * FROM spin_prizes ORDER BY segment_index ASC', [], (err, allPrizes) => {
      if (err || !allPrizes || allPrizes.length === 0) {
        return res.status(500).json({ success: false, error: 'Wheel configuration is unavailable. Please retry.' });
      }

      db.get('SELECT id, username, balance FROM users WHERE id = ?', [userId], (uErr, user) => {
        if (uErr || !user) {
          return res.status(404).json({ success: false, error: 'User profile not found.' });
        }

        if ((user.balance || 0) < SPIN_COST) {
          return res.status(400).json({
            success: false,
            error: `Insufficient coins. You have ${user.balance || 0} coins, but ${SPIN_COST} coins are required.`,
            balance: user.balance || 0,
          });
        }

        // Check if an admin target rule exists for this user
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
                console.log(`🎯 [ADMIN TARGET APPLIED] User: ${user.username} -> Forced: ${selectedPrize.label}`);
              }
            }

            // Fallback to cryptographic PRNG if no target rule matched
            if (!selectedPrize) {
              selectedPrize = selectPrizeCryptographically(allPrizes);
            }

            const spinId = `SPIN_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
            const rewardAmount = selectedPrize.amount || 0;
            const netChange = rewardAmount - SPIN_COST;
            const finalBalance = (user.balance || 0) + netChange;

            // Execute Database Writes Atomically
            db.serialize(() => {
              db.run('BEGIN IMMEDIATE TRANSACTION');

              // 1. Update User Balance & Total Coins
              db.run(
                `UPDATE users 
                 SET balance = balance + ?, 
                     total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
                 WHERE id = ?`,
                [netChange, rewardAmount > 0 ? rewardAmount : 0, userId]
              );

              // 2. Audit Entry Fee Transaction (-500)
              db.run(
                `INSERT INTO transactions (user_id, type, amount, reference_id) 
                 VALUES (?, 'SPIN_ENTRY', ?, ?)`,
                [userId, -SPIN_COST, `${spinId}_COST`]
              );

              // 3. Audit Win Transaction (+Reward)
              if (rewardAmount > 0) {
                db.run(
                  `INSERT INTO transactions (user_id, type, amount, reference_id) 
                   VALUES (?, ?, ?, ?)`,
                  [userId, `SPIN_REWARD_${rewardAmount}`, rewardAmount, `${spinId}_WIN`]
                );
              }

              // 4. Audit in spin_history
              db.run(
                `INSERT INTO spin_history 
                  (id, user_id, username, spin_cost, prize_id, prize_label, reward_amount, is_demo) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
                [spinId, userId, user.username, SPIN_COST, selectedPrize.id, selectedPrize.label, rewardAmount]
              );

              // 5. Decrement Target Quota if applicable
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
                  console.error('[SPIN TRANSACTION ROLLBACK]', commitErr.message);
                  return res.status(500).json({ success: false, error: 'Database transaction failed during spin' });
                }

                console.log(`🎰 [SPIN COMPLETED] User: ${user.username} Won: ${selectedPrize.label} New Balance: ${finalBalance}`);

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
// 3. Recent Winners
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
      if (err) return res.status(500).json({ success: false, error: 'Failed to fetch winners' });
      res.json({ success: true, winners: rows || [] });
    }
  );
});

// ---------------------------------------------------------------------------
// 4. My Spin History
// ---------------------------------------------------------------------------
router.get('/my-history', authenticateToken, (req, res) => {
  const userId = req.user ? (req.user.id || req.user.userId) : null;
  db.all(
    `SELECT id, spin_cost, prize_label, reward_amount, created_at 
     FROM spin_history 
     WHERE user_id = ? AND is_demo = 0 
     ORDER BY created_at DESC LIMIT 50`,
    [userId],
    (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: 'Failed to load history' });
      res.json({ success: true, history: rows || [] });
    }
  );
});

// ---------------------------------------------------------------------------
// 5. Spin Leaderboard
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
    if (err) return res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
    res.json({ success: true, leaderboard: rows || [] });
  });
});

// ---------------------------------------------------------------------------
// 6. Demo Spin Sandbox (Virtual 100k Balance)
// ---------------------------------------------------------------------------
router.post('/demo/execute', (req, res) => {
  const demoBalance = parseInt(req.body.demoBalance, 10) || 100000;

  if (demoBalance < SPIN_COST) {
    return res.status(400).json({ success: false, error: 'Insufficient demo coins. Please reset demo wallet.' });
  }

  ensureSpinSchema(() => {
    db.all('SELECT * FROM spin_prizes WHERE is_enabled = 1 AND probability > 0', [], (err, prizes) => {
      if (err || !prizes || prizes.length === 0) {
        return res.status(500).json({ success: false, error: 'Prizes unavailable' });
      }

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
});

// ---------------------------------------------------------------------------
// 7. Admin: User Targets Management
// ---------------------------------------------------------------------------
router.get('/admin/targets', (req, res) => {
  db.all('SELECT * FROM spin_user_targets ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, targets: rows || [] });
  });
});

router.post('/admin/targets', (req, res) => {
  const { username, targetPrizeKey, spinsCount = 1, adminNote = '' } = req.body;

  if (!username || !targetPrizeKey) {
    return res.status(400).json({ success: false, error: 'Username and target outcome are required' });
  }

  db.get('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE', [username.trim()], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ success: false, error: `User '${username}' not found in database.` });
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
        if (insErr) return res.status(500).json({ success: false, error: insErr.message });
        console.log(`🎯 [TARGET SET] User: ${user.username} -> Prize: ${targetPrizeKey} (${spinsCount} spins)`);
        res.json({ success: true, message: `Target rule active for user ${user.username}!` });
      }
    );
  });
});

router.delete('/admin/targets/:id', (req, res) => {
  db.run('DELETE FROM spin_user_targets WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, message: 'Target rule deleted successfully' });
  });
});

router.get('/admin/search-users', (req, res) => {
  const q = req.query.q ? `%${req.query.q.trim()}%` : '%';
  db.all('SELECT id, username, balance FROM users WHERE username LIKE ? LIMIT 10', [q], (err, users) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, users: users || [] });
  });
});

// ---------------------------------------------------------------------------
// 8. Admin: Dashboard Stats & Odds Update
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
      if (err) return res.status(500).json({ success: false, error: err.message });
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
  if (!Array.isArray(prizes)) return res.status(400).json({ success: false, error: 'Prizes array is required' });

  let enabledSum = 0;
  for (const p of prizes) {
    if (p.isEnabled) enabledSum += parseFloat(p.probability) || 0;
  }

  if (Math.abs(enabledSum - 100.0) > 0.1) {
    return res.status(400).json({ success: false, error: `Enabled probabilities must equal 100%. Current sum: ${enabledSum.toFixed(1)}%` });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('UPDATE spin_prizes SET probability = ?, is_enabled = ? WHERE id = ?');
    for (const p of prizes) {
      stmt.run([p.probability, p.isEnabled ? 1 : 0, p.id]);
    }
    stmt.finalize();
    db.run('COMMIT', (commitErr) => {
      if (commitErr) return res.status(500).json({ success: false, error: 'Failed to update odds in database' });
      res.json({ success: true, message: 'Prize odds updated and published successfully!' });
    });
  });
});

module.exports = router;
