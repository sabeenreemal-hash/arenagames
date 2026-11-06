// backend/routes/referral.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

// ---------------------------------------------------------------------------
// 1. GET /api/referral - Fetch user stats, status, and referred list
// ---------------------------------------------------------------------------
router.get('/', authenticateToken, (req, res) => {
  const userId = req.user.id;

  // 1. Fetch user's own referral code AND check if they were referred by someone
  db.get('SELECT referral_code, referred_by_id FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User record not found' });
    }

    const hasReferrer = Boolean(user.referred_by_id);

    // 2. Fetch users who joined using this user's code
    const sql = `
      SELECT 
        u.id, 
        u.username, 
        u.full_name, 
        u.created_at,
        COALESCE(u.total_coins_earned, 0) AS total_coins_earned,
        COALESCE((
          SELECT SUM(amount) 
          FROM transactions 
          WHERE user_id = ? 
            AND type = 'REFERRAL_COMMISSION' 
            AND (reference_id LIKE 'USER_' || u.id || '%' OR reference_id = CAST(u.id AS TEXT))
        ), 0) AS commission_earned
      FROM users u 
      WHERE u.referred_by_id = ? 
      ORDER BY u.created_at DESC
    `;

    db.all(sql, [userId, userId], (listErr, rows) => {
      if (listErr) {
        return res.status(500).json({ error: 'Failed to retrieve referral records' });
      }

      // 3. Fetch total lifetime commission
      db.get(
        `SELECT COALESCE(SUM(amount), 0) as total_commission 
         FROM transactions 
         WHERE user_id = ? AND type = 'REFERRAL_COMMISSION'`,
        [userId],
        (commErr, commRow) => {
          const totalComm = commRow ? commRow.total_commission : 0;

          const referredUsers = (rows || []).map((r) => {
            const calculatedComm = r.commission_earned > 0 
              ? r.commission_earned 
              : Math.floor(r.total_coins_earned * 0.10);

            return {
              id: r.id,
              username: r.username,
              fullName: r.full_name,
              joinedAt: r.created_at,
              commissionEarned: calculatedComm,
            };
          });

          res.json({
            referralCode: user.referral_code,
            hasReferrer: hasReferrer, // <-- Tells Flutter whether to hide the input box
            totalReferred: referredUsers.length,
            totalCommission: totalComm,
            referredUsers: referredUsers,
          });
        }
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 2. POST /api/referral/apply - Apply a referral code after registration
// ---------------------------------------------------------------------------
router.post('/apply', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { referralCode } = req.body;

  if (!referralCode || !referralCode.trim()) {
    return res.status(400).json({ success: false, message: 'Please enter a referral code' });
  }

  const cleanCode = referralCode.trim().toUpperCase();

  // 1. Check if the user already has a referrer
  db.get('SELECT id, referral_code, referred_by_id FROM users WHERE id = ?', [userId], (err, currentUser) => {
    if (err || !currentUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (currentUser.referred_by_id) {
      return res.status(400).json({ success: false, message: 'You have already used a referral code!' });
    }

    if (currentUser.referral_code === cleanCode) {
      return res.status(400).json({ success: false, message: 'You cannot use your own referral code!' });
    }

    // 2. Find the owner of the referral code
    db.get('SELECT id, username FROM users WHERE referral_code = ?', [cleanCode], (refErr, referrer) => {
      if (refErr || !referrer) {
        return res.status(404).json({ success: false, message: 'Invalid referral code' });
      }

      const BONUS_COINS = 100; // Sign-up bonus

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Set referred_by_id and give 100 bonus coins to the new user
        db.run(
          `UPDATE users 
           SET referred_by_id = ?, 
               balance = balance + ?, 
               total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
           WHERE id = ?`,
          [referrer.id, BONUS_COINS, BONUS_COINS, userId],
          (uErr) => {
            if (uErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ success: false, message: 'Failed to bind referral' });
            }

            // Record transaction for current user
            db.run(
              `INSERT INTO transactions (user_id, type, amount, reference_id) 
               VALUES (?, 'REFERRAL_BONUS', ?, ?)`,
              [userId, BONUS_COINS, `REFERRED_BY_${referrer.id}`]
            );

            // Give 100 bonus coins to the referrer as well
            db.run(
              `UPDATE users 
               SET balance = balance + ?, 
                   total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
               WHERE id = ?`,
              [BONUS_COINS, BONUS_COINS, referrer.id]
            );

            // Record transaction for referrer
            db.run(
              `INSERT INTO transactions (user_id, type, amount, reference_id) 
               VALUES (?, 'REFERRAL_COMMISSION', ?, ?)`,
              [referrer.id, BONUS_COINS, `USER_${userId}_SIGNUP`]
            );

            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: 'Transaction error' });
              }

              res.json({
                success: true,
                message: `Referral applied! +${BONUS_COINS} coins added to your wallet!`,
              });
            });
          }
        );
      });
    });
  });
});

module.exports = router;
