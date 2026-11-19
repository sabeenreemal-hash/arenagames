// backend/services/referralService.js
const db = require('../database');

/**
 * Determines the referrer's commission rate based on their total lifetime commission pool.
 * - < 10,000 coins  => 10%
 * - >= 10,000 coins => 15%
 * - >= 25,000 coins => 20%
 *
 * @param {number} totalCommission
 */
function getCommissionTier(totalCommission) {
  const total = Number(totalCommission) || 0;

  if (total >= 25000) {
    return {
      rate: 0.20,
      ratePercent: 20,
      nextTierCoins: null,
      nextTierRate: null,
    };
  }

  if (total >= 10000) {
    return {
      rate: 0.15,
      ratePercent: 15,
      nextTierCoins: 25000,
      nextTierRate: 20,
    };
  }

  return {
    rate: 0.10,
    ratePercent: 10,
    nextTierCoins: 10000,
    nextTierRate: 15,
  };
}

/**
 * Gives tiered referral commission to the referrer whenever a referred user gets coins.
 *
 * @param {number|string} userId - The ID of the user who received coins
 * @param {number} earnedCoins - How many coins the user earned/received
 * @param {string} source - e.g. 'OFFERWALL', 'TASK', 'SPIN', 'GAME'
 * @param {string|number} referenceId - (Optional) tx_id or session_id
 */
function creditReferralCommission(userId, earnedCoins, source = 'REWARD', referenceId = null) {
  const coins = parseInt(earnedCoins, 10);
  if (isNaN(coins) || coins <= 0) return;

  // 1. Find the user's referrer
  db.get('SELECT referred_by_id FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user || !user.referred_by_id) {
      return; // No referrer found
    }

    const referrerId = user.referred_by_id;

    // 2. Check referrer's current total commission pool to determine tier rate
    db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total_commission
       FROM transactions
       WHERE user_id = ? AND type = 'REFERRAL_COMMISSION'`,
      [referrerId],
      (commErr, commRow) => {
        if (commErr) {
          console.error(`[Referral Error] Failed to fetch commission pool for referrer ${referrerId}:`, commErr.message);
          return;
        }

        const totalCommission = commRow ? commRow.total_commission : 0;
        const { rate, ratePercent } = getCommissionTier(totalCommission);
        const commission = Math.floor(coins * rate);

        if (commission <= 0) return;

        // Keep USER_<userId> prefix so GET /api/referral can accurately sum per-user commission
        const ref = referenceId
          ? (String(referenceId).startsWith(`USER_${userId}`)
              ? String(referenceId)
              : `USER_${userId}_${source}_${referenceId}`)
          : `USER_${userId}_${source}`;

        // 3. Add commission to referrer's balance and total_coins_earned
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

            // 4. Insert transaction log for referrer
            db.run(
              `INSERT INTO transactions (user_id, type, amount, reference_id, created_at) 
               VALUES (?, 'REFERRAL_COMMISSION', ?, ?, datetime('now'))`,
              [referrerId, commission, ref],
              (txErr) => {
                if (txErr) {
                  console.error(`[Referral Error] Failed to log transaction for referrer ${referrerId}:`, txErr.message);
                } else {
                  console.log(
                    `[Referral] Credited ${commission} coins (${ratePercent}%) to referrer ID ${referrerId} from user ${userId}`
                  );
                }
              }
            );
          }
        );
      }
    );
  });
}

module.exports = { creditReferralCommission, getCommissionTier };
