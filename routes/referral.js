// backend/routes/referral.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');

// Fetch user referral statistics and referred user details
router.get('/', authenticateToken, (req, res) => {
  const userId = req.user.id;

  // 1. Fetch the user's personal referral code
  db.get('SELECT referral_code FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User record not found' });

    // 2. Fetch all users who registered with this user's referral code
    const sql = `
      SELECT 
        u.id, 
        u.username, 
        u.full_name, 
        u.created_at,
        COALESCE((
          SELECT SUM(amount) FROM transactions 
          WHERE user_id = u.id AND type = 'GAME_REWARD'
        ), 0) AS total_game_earnings,
        COALESCE((
          SELECT SUM(amount) FROM transactions 
          WHERE user_id = ? AND type = 'REFERRAL_COMMISSION' AND reference_id IN (
            SELECT id FROM game_sessions WHERE user_id = u.id
          )
        ), 0) AS commission_from_sessions
      FROM users u 
      WHERE u.referred_by_id = ? 
      ORDER BY u.created_at DESC
    `;

    db.all(sql, [userId, userId], (listErr, rows) => {
      if (listErr) {
        return res.status(500).json({ error: 'Failed to retrieve referral records' });
      }

      // 3. Fetch total lifetime commission earned
      db.get(
        `SELECT COALESCE(SUM(amount), 0) as total_commission 
         FROM transactions 
         WHERE user_id = ? AND type = 'REFERRAL_COMMISSION'`,
        [userId],
        (commErr, commRow) => {
          const totalComm = commRow ? commRow.total_commission : 0;

          // Format output list
          const referredUsers = rows.map((r) => {
            const calculatedComm = r.commission_from_sessions > 0
                ? r.commission_from_sessions
                : Math.floor(r.total_game_earnings * 0.10);

            return {
              id: r.id,
              username: r.username,
              fullName: r.full_name,
              joinedAt: r.created_at,
              totalGameEarnings: r.total_game_earnings,
              commissionEarned: calculatedComm,
            };
          });

          res.json({
            referralCode: user.referral_code,
            totalReferred: referredUsers.length,
            totalCommission: totalComm,
            referredUsers: referredUsers,
          });
        }
      );
    });
  });
});

module.exports = router;