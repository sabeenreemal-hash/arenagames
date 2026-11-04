// backend/services/referralService.js
const db = require('../database');

/**
 * Gives referral commission to the referrer whenever a user gets coins.
 * 
 * @param {number|string} userId - The ID of the user who received coins
 * @param {number} earnedCoins - How many coins the user earned/received
 * @param {string} source - e.g. 'OFFERWALL', 'TASK', 'SPIN', 'GAME'
 * @param {string|number} referenceId - (Optional) tx_id or session_id
 * @param {number} rate - Commission rate (0.10 = 10%)
 */
function creditReferralCommission(userId, earnedCoins, source = 'REWARD', referenceId = null, rate = 0.10) {
  const coins = parseInt(earnedCoins, 10);
  if (isNaN(coins) || coins <= 0) return;

  // 1. Find the user's referrer
  db.get('SELECT referred_by_id FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user || !user.referred_by_id) {
      return; // No referrer found
    }

    const referrerId = user.referred_by_id;
    const commission = Math.floor(coins * rate);

    if (commission <= 0) return;

    // Use user ID or custom ref ID as reference
    const ref = referenceId ? String(referenceId) : `USER_${userId}_${source}`;

    // 2. Add commission to referrer's balance and total_coins_earned
    db.run(
      `UPDATE users 
       SET balance = balance + ?, 
           total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
       WHERE id = ?`,
      [commission, commission, referrerId],
      (updateErr) => {
        if (updateErr) {
          console.error(`[Referral Error] Failed to update balance for referrer ${referrerId}:`, updateErr.message);
          return;
        }

        // 3. Insert transaction log for referrer
        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id, created_at) 
           VALUES (?, 'REFERRAL_COMMISSION', ?, ?, datetime('now'))`,
          [referrerId, commission, ref],
          (txErr) => {
            if (txErr) {
              console.error(`[Referral Error] Failed to log transaction for referrer ${referrerId}:`, txErr.message);
            } else {
              console.log(`[Referral] Credited ${commission} coins (10%) to referrer ID ${referrerId} from user ${userId}`);
            }
          }
        );
      }
    );
  });
}

module.exports = { creditReferralCommission };