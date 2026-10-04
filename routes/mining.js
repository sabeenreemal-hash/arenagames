// backend/routes/mining.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');

const DURATION_MS = 10 * 60 * 1000;       // 10 minutes = 600,000 ms
const BASE_MAX_REWARD = 50.0;
const MAX_TOTAL_REWARD = 100.0;
const BOOST_DURATION_MS = 2 * 60 * 1000;  // 2 minutes
const BOOST_COOLDOWN_MS = 60 * 1000;      // 60 seconds
const BASE_RATE_PER_MS = BASE_MAX_REWARD / DURATION_MS; // 0.08333 coins/sec

// Helper: Calculate session rewards based on server timestamps
function calculateEarnings(session, currentEpochMs) {
  const effectiveEnd = Math.min(currentEpochMs, session.ends_at);
  const elapsedMs = Math.max(0, effectiveEnd - session.started_at);

  let normalReward = elapsedMs * BASE_RATE_PER_MS;
  if (normalReward > BASE_MAX_REWARD) normalReward = BASE_MAX_REWARD;

  // Each boost gives bonus speed (up to 50 additional coins total)
  const boostReward = (session.boost_count || 0) * 12.5;

  let totalReward = normalReward + boostReward;
  if (totalReward > MAX_TOTAL_REWARD) {
    totalReward = MAX_TOTAL_REWARD;
  }

  const isCompleted = currentEpochMs >= session.ends_at;
  const isBoostActive = currentEpochMs < (session.boost_active_until || 0);

  let nextBoostAvailableAt = 0;
  if (!session.boost_count || session.boost_count === 0) {
    nextBoostAvailableAt = session.started_at + BOOST_COOLDOWN_MS;
  } else {
    nextBoostAvailableAt = Math.max(session.boost_active_until || 0, session.last_boost_ended_at || 0) + BOOST_COOLDOWN_MS;
  }

  return {
    normalReward: Number(normalReward.toFixed(2)),
    totalReward: Number(totalReward.toFixed(2)),
    isCompleted,
    isBoostActive,
    canBoost: !isCompleted && !isBoostActive && (currentEpochMs >= nextBoostAvailableAt) && (totalReward < MAX_TOTAL_REWARD),
    nextBoostAvailableAt
  };
}

// Helper: Extract User ID safely from req.user or headers
function getUserId(req) {
  return req.user?.id || req.headers['x-user-id'] || req.query.user_id;
}

// 1. GET /api/mining/status
router.get('/status', (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'User ID required' });

  const now = Date.now();

  db.get(
    `SELECT * FROM mining_sessions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
    [userId],
    (err, session) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (!session) return res.json({ active: false });

      const calc = calculateEarnings(session, now);
      res.json({
        active: true,
        sessionId: session.id,
        startedAt: session.started_at,
        endsAt: session.ends_at,
        boostActiveUntil: session.boost_active_until,
        nextBoostAvailableAt: calc.nextBoostAvailableAt,
        isBoostActive: calc.isBoostActive,
        canBoost: calc.canBoost,
        isCompleted: calc.isCompleted,
        currentReward: calc.totalReward
      });
    }
  );
});

// 2. POST /api/mining/start
router.post('/start', (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'User ID required' });

  const now = Date.now();

  db.get(
    `SELECT id FROM mining_sessions WHERE user_id = ? AND status = 'active'`,
    [userId],
    (err, existing) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (existing) {
        return res.status(400).json({ error: 'Active mining session already running.' });
      }

      const sessionId = `MINING_${crypto.randomBytes(6).toString('hex')}`;
      const endsAt = now + DURATION_MS;

      db.run(
        `INSERT INTO mining_sessions (id, user_id, started_at, ends_at, status) VALUES (?, ?, ?, ?, 'active')`,
        [sessionId, userId, now, endsAt],
        (insertErr) => {
          if (insertErr) return res.status(500).json({ error: 'Failed to start mining session.' });
          console.log(`[MINING START] Started session ${sessionId} for User #${userId}`);
          res.json({ success: true, sessionId, startedAt: now, endsAt });
        }
      );
    }
  );
});

// 3. POST /api/mining/boost
router.post('/boost', (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'User ID required' });

  const now = Date.now();

  db.get(
    `SELECT * FROM mining_sessions WHERE user_id = ? AND status = 'active'`,
    [userId],
    (err, session) => {
      if (err || !session) return res.status(404).json({ error: 'No active mining session.' });

      const calc = calculateEarnings(session, now);
      if (!calc.canBoost) {
        return res.status(400).json({ error: 'Booster is locked or on cooldown.' });
      }

      const boostUntil = now + BOOST_DURATION_MS;
      db.run(
        `UPDATE mining_sessions 
         SET boost_active_until = ?, last_boost_ended_at = ?, boost_count = boost_count + 1 
         WHERE id = ?`,
        [boostUntil, boostUntil, session.id],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: 'Failed to activate boost.' });
          console.log(`[MINING BOOST] User #${userId} activated 2-min boost.`);
          res.json({ success: true, boostActiveUntil: boostUntil });
        }
      );
    }
  );
});

// 4. POST /api/mining/claim
router.post('/claim', (req, res) => {
  const userId = getUserId(req);
  const { sessionId } = req.body;
  if (!userId || !sessionId) return res.status(400).json({ error: 'Missing parameters' });

  const now = Date.now();

  db.get(
    `SELECT * FROM mining_sessions WHERE id = ? AND user_id = ? AND status = 'active'`,
    [sessionId, userId],
    (err, session) => {
      if (err || !session) return res.status(400).json({ error: 'Session not found or already claimed.' });
      if (now < session.ends_at) return res.status(400).json({ error: 'Mining session still in progress.' });

      const calc = calculateEarnings(session, session.ends_at);
      const finalCoins = Math.round(calc.totalReward);

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run(
          `UPDATE mining_sessions SET status = 'claimed', claimed_reward = ?, is_doubled = 0 WHERE id = ?`,
          [finalCoins, session.id]
        );

        db.run(
          `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
          [finalCoins, finalCoins, userId]
        );

        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MINING_REWARD', ?, ?)`,
          [userId, finalCoins, session.id],
          (txErr) => {
            if (txErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Transaction failed' });
            }
            db.run('COMMIT');
            console.log(`[MINING CLAIM] User #${userId} claimed ${finalCoins} coins.`);
            res.json({ success: true, coinsEarned: finalCoins, doubled: false });
          }
        );
      });
    }
  );
});

// 5. POST /api/mining/claim-double
router.post('/claim-double', (req, res) => {
  const userId = getUserId(req);
  const { sessionId } = req.body;
  if (!userId || !sessionId) return res.status(400).json({ error: 'Missing parameters' });

  const now = Date.now();

  db.get(
    `SELECT * FROM mining_sessions WHERE id = ? AND user_id = ? AND status = 'active'`,
    [sessionId, userId],
    (err, session) => {
      if (err || !session) return res.status(400).json({ error: 'Session not found or already claimed.' });
      if (now < session.ends_at) return res.status(400).json({ error: 'Mining session still in progress.' });

      const calc = calculateEarnings(session, session.ends_at);
      const finalCoins = Math.round(calc.totalReward * 2); // 2X final reward

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run(
          `UPDATE mining_sessions SET status = 'claimed', claimed_reward = ?, is_doubled = 1 WHERE id = ?`,
          [finalCoins, session.id]
        );

        db.run(
          `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
          [finalCoins, finalCoins, userId]
        );

        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MINING_REWARD_2X', ?, ?)`,
          [userId, finalCoins, session.id],
          (txErr) => {
            if (txErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Transaction failed' });
            }
            db.run('COMMIT');
            console.log(`[MINING 2X CLAIM] User #${userId} claimed ${finalCoins} coins (2X reward).`);
            res.json({ success: true, coinsEarned: finalCoins, doubled: true });
          }
        );
      });
    }
  );
});

module.exports = router;
