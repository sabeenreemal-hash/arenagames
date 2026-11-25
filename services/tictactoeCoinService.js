// backend/services/tictactoeCoinService.js

const db = require('../database');

function deductEntryFee(userId, entryFee, matchId) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
        if (beginErr) return reject(beginErr);

        db.get('SELECT balance FROM users WHERE id = ?', [userId], (err, user) => {
          if (err || !user) {
            db.run('ROLLBACK');
            return reject(new Error('User not found'));
          }

          if (user.balance < entryFee) {
            db.run('ROLLBACK');
            return reject(new Error('INSUFFICIENT_BALANCE'));
          }

          db.run(
            'UPDATE users SET balance = balance - ? WHERE id = ?',
            [entryFee, userId],
            (updateErr) => {
              if (updateErr) {
                db.run('ROLLBACK');
                return reject(updateErr);
              }

              const refId = `TTT_ENTRY_${matchId}`;
              db.run(
                `INSERT INTO transactions (user_id, type, amount, reference_id) 
                 VALUES (?, 'TICTACTOE_ENTRY', ?, ?)`,
                [userId, -entryFee, refId],
                (txErr) => {
                  if (txErr) {
                    db.run('ROLLBACK');
                    return reject(txErr);
                  }

                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      db.run('ROLLBACK');
                      return reject(commitErr);
                    }
                    resolve({ success: true, remainingBalance: user.balance - entryFee });
                  });
                }
              );
            }
          );
        });
      });
    });
  });
}

function refundEntryFee(userId, entryFee, matchId, reason = 'CANCELLED') {
  return new Promise((resolve, reject) => {
    if (entryFee <= 0) return resolve(true);

    db.serialize(() => {
      db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
        if (beginErr) return reject(beginErr);

        db.run(
          'UPDATE users SET balance = balance + ? WHERE id = ?',
          [entryFee, userId],
          (updateErr) => {
            if (updateErr) {
              db.run('ROLLBACK');
              return reject(updateErr);
            }

            const refId = `TTT_REFUND_${matchId}_${Date.now()}`;
            db.run(
              `INSERT INTO transactions (user_id, type, amount, reference_id) 
               VALUES (?, 'TICTACTOE_REFUND', ?, ?)`,
              [userId, entryFee, refId],
              (txErr) => {
                if (txErr) {
                  db.run('ROLLBACK');
                  return reject(txErr);
                }

                db.run('COMMIT', (commitErr) => {
                  if (commitErr) {
                    db.run('ROLLBACK');
                    return reject(commitErr);
                  }
                  resolve(true);
                });
              }
            );
          }
        );
      });
    });
  });
}

function payoutWinnerReward(winnerId, rewardAmount, matchId) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
        if (beginErr) return reject(beginErr);

        // Prevent double reward payout on the same match
        const checkRef = `TTT_WIN_${matchId}`;
        db.get(
          'SELECT id FROM transactions WHERE reference_id = ?',
          [checkRef],
          (cErr, existingTx) => {
            if (existingTx) {
              db.run('ROLLBACK');
              return resolve({ alreadyClaimed: true });
            }

            db.run(
              `UPDATE users 
               SET balance = balance + ?, 
                   total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
               WHERE id = ?`,
              [rewardAmount, rewardAmount, winnerId],
              (updateErr) => {
                if (updateErr) {
                  db.run('ROLLBACK');
                  return reject(updateErr);
                }

                db.run(
                  `INSERT INTO transactions (user_id, type, amount, reference_id) 
                   VALUES (?, 'TICTACTOE_WIN', ?, ?)`,
                  [winnerId, rewardAmount, checkRef],
                  (txErr) => {
                    if (txErr) {
                      db.run('ROLLBACK');
                      return reject(txErr);
                    }

                    db.run('COMMIT', (commitErr) => {
                      if (commitErr) {
                        db.run('ROLLBACK');
                        return reject(commitErr);
                      }
                      resolve({ success: true, rewardAmount });
                    });
                  }
                );
              }
            );
          }
        );
      });
    });
  });
}

module.exports = {
  deductEntryFee,
  refundEntryFee,
  payoutWinnerReward
};
