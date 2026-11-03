// backend/routes/rps.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const ENTRY_FEE = 100;
const WINNER_PRIZE = 200;
const ROUND_TIME_LIMIT_SEC = 15;
const WINS_TO_MATCH = 2; // First to win 2 rounds wins

function getAuthUserId(req) {
  if (!req.user) return null;
  return req.user.id || req.user.userId || req.user.sub || null;
}

let rpsQueue = [];

function evaluateRound(choiceA, choiceB) {
  if (!choiceA && !choiceB) return { winner: 'DRAW', reason: 'BOTH_TIMEOUT' };
  if (!choiceA) return { winner: 'B', reason: 'A_TIMEOUT' };
  if (!choiceB) return { winner: 'A', reason: 'B_TIMEOUT' };
  if (choiceA === choiceB) return { winner: 'DRAW', reason: 'SAME_CHOICE' };

  if (
    (choiceA === 'ROCK' && choiceB === 'SCISSORS') ||
    (choiceA === 'SCISSORS' && choiceB === 'PAPER') ||
    (choiceA === 'PAPER' && choiceB === 'ROCK')
  ) {
    return { winner: 'A', reason: 'WIN' };
  }
  return { winner: 'B', reason: 'WIN' };
}

router.get('/waiting-players', authenticateToken, (req, res) => {
  const now = Date.now();
  rpsQueue = rpsQueue.filter(p => (now - p.joinedAt) < 90000);

  res.json({
    success: true,
    count: rpsQueue.length,
    players: rpsQueue.map(p => ({
      userId: p.userId,
      username: p.username,
      waitingSeconds: Math.floor((now - p.joinedAt) / 1000)
    }))
  });
});

router.post('/join-queue', authenticateToken, (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  db.get(
    `SELECT id FROM rps_matches 
     WHERE (player_a_id = ? OR player_b_id = ?) 
       AND status IN ('IN_PROGRESS', 'ROUND_REVEAL')`,
    [userId, userId],
    (matchErr, activeMatch) => {
      if (matchErr) return res.status(500).json({ error: 'Database error' });
      if (activeMatch) {
        return res.json({
          success: true,
          matched: true,
          matchId: activeMatch.id,
          message: 'Active match resumed.'
        });
      }

      if (rpsQueue.some(p => String(p.userId) === String(userId))) {
        return res.json({
          success: true,
          matched: false,
          inQueue: true,
          message: 'Already in matchmaking queue.'
        });
      }

      db.get('SELECT id, balance, username FROM users WHERE id = ?', [userId], (userErr, user) => {
        if (userErr || !user) return res.status(404).json({ error: 'User not found' });
        
        const currentBalance = parseInt(user.balance, 10) || 0;
        if (currentBalance < ENTRY_FEE) {
          return res.status(400).json({ 
            error: `Insufficient coins. You have ${currentBalance} coins, but ${ENTRY_FEE} coins are required.` 
          });
        }

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

          db.run(
            `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
            [ENTRY_FEE, user.id, ENTRY_FEE],
            function (deductErr) {
              if (deductErr || this.changes === 0) {
                db.run('ROLLBACK');
                return res.status(400).json({ error: 'Failed to reserve entry fee' });
              }

              db.run(
                `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_ENTRY', ?, ?)`,
                [user.id, -ENTRY_FEE, `RPS_ENTRY_${Date.now()}`]
              );

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Transaction commit failed' });
                }

                const oppIndex = rpsQueue.findIndex(p => String(p.userId) !== String(user.id));

                if (oppIndex !== -1) {
                  const opponent = rpsQueue.splice(oppIndex, 1)[0];
                  const matchId = `rps_${crypto.randomBytes(8).toString('hex')}`;

                  db.run(
                    `INSERT INTO rps_matches (
                      id, player_a_id, player_b_id, player_a_name, player_b_name,
                      player_a_score, player_b_score, current_round, status, pot_amount, round_start_time
                    ) VALUES (?, ?, ?, ?, ?, 0, 0, 1, 'IN_PROGRESS', 200, CURRENT_TIMESTAMP)`,
                    [matchId, opponent.userId, user.id, opponent.username, user.username],
                    (insErr) => {
                      if (insErr) {
                        console.error('[RPS CREATE ERROR]:', insErr);
                        return res.status(500).json({ error: 'Failed to create match' });
                      }

                      return res.json({
                        success: true,
                        matched: true,
                        matchId: matchId,
                        opponentName: opponent.username
                      });
                    }
                  );
                } else {
                  rpsQueue.push({
                    userId: user.id,
                    username: user.username,
                    joinedAt: Date.now()
                  });

                  return res.json({
                    success: true,
                    matched: false,
                    inQueue: true,
                    message: 'Searching for opponent...'
                  });
                }
              });
            }
          );
        });
      });
    }
  );
});

router.post('/cancel-queue', authenticateToken, (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const qIndex = rpsQueue.findIndex(p => String(p.userId) === String(userId));

  if (qIndex === -1) {
    db.get(
      `SELECT id FROM rps_matches 
       WHERE (player_a_id = ? OR player_b_id = ?) 
         AND status IN ('IN_PROGRESS', 'ROUND_REVEAL')`,
      [userId, userId],
      (err, activeMatch) => {
        if (activeMatch) {
          return res.status(400).json({ error: 'Match already started' });
        }
        return res.status(400).json({ error: 'You are not in the queue' });
      }
    );
    return;
  }

  rpsQueue.splice(qIndex, 1);

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, userId]);
    db.run(
      `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_REFUND', ?, ?)`,
      [userId, ENTRY_FEE, `REFUND_RPS_${Date.now()}`]
    );
    db.run('COMMIT', (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'Refund failed' });
      }
      return res.json({ success: true, message: 'Matchmaking cancelled. 100 coins refunded.' });
    });
  });
});

router.get('/check-queue-status', authenticateToken, (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  db.get(
    `SELECT * FROM rps_matches 
     WHERE (player_a_id = ? OR player_b_id = ?) 
       AND status IN ('IN_PROGRESS', 'ROUND_REVEAL') 
     ORDER BY created_at DESC LIMIT 1`,
    [userId, userId],
    (err, match) => {
      if (err) return res.status(500).json({ error: 'Query failed' });
      if (match) {
        const opponentName = String(match.player_a_id) === String(userId) ? match.player_b_name : match.player_a_name;
        return res.json({
          success: true,
          matched: true,
          matchId: match.id,
          opponentName: opponentName
        });
      }

      return res.json({
        success: true,
        matched: false,
        inQueue: rpsQueue.some(p => String(p.userId) === String(userId))
      });
    }
  );
});

router.get('/match/:matchId', authenticateToken, (req, res) => {
  const { matchId } = req.params;
  const userId = getAuthUserId(req);

  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (String(match.player_a_id) !== String(userId) && String(match.player_b_id) !== String(userId)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const roundStartTime = new Date(match.round_start_time).getTime();
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - roundStartTime) / 1000));
    const secondsRemaining = Math.max(0, ROUND_TIME_LIMIT_SEC - elapsedSeconds);

    if (match.status === 'IN_PROGRESS' && elapsedSeconds >= ROUND_TIME_LIMIT_SEC) {
      return resolveRound(match, (rErr, updatedMatch) => {
        sendMatchPayload(res, updatedMatch || match, userId, 0);
      });
    }

    sendMatchPayload(res, match, userId, secondsRemaining);
  });
});

function sendMatchPayload(res, match, userId, secondsRemaining) {
  const isPlayerA = String(match.player_a_id) === String(userId);
  const myChoice = isPlayerA ? match.player_a_choice : match.player_b_choice;
  const hasOpponentSubmitted = isPlayerA ? (match.player_b_choice !== null) : (match.player_a_choice !== null);

  let lastResult = null;
  try {
    if (match.last_round_result) lastResult = JSON.parse(match.last_round_result);
  } catch (_) {}

  let opponentChoiceRevealed = null;
  if (match.status === 'ROUND_REVEAL' || match.status === 'COMPLETED' || match.status === 'DRAW') {
    opponentChoiceRevealed = isPlayerA ? match.player_b_choice : match.player_a_choice;
  }

  res.json({
    success: true,
    matchId: match.id,
    playerA: { id: match.player_a_id, username: match.player_a_name, score: match.player_a_score },
    playerB: { id: match.player_b_id, username: match.player_b_name, score: match.player_b_score },
    isPlayerA: isPlayerA,
    currentRound: match.current_round,
    status: match.status,
    secondsRemaining: secondsRemaining,
    myChoice: myChoice,
    hasSubmitted: myChoice !== null,
    hasOpponentSubmitted: hasOpponentSubmitted,
    opponentChoice: opponentChoiceRevealed,
    lastRoundResult: lastResult,
    winnerId: match.winner_id,
    potAmount: match.pot_amount
  });
}

router.post('/submit-choice', authenticateToken, (req, res) => {
  const { matchId, choice } = req.body;
  const userId = getAuthUserId(req);

  const validChoices = ['ROCK', 'PAPER', 'SCISSORS'];
  if (!choice || !validChoices.includes(choice.toUpperCase())) {
    return res.status(400).json({ error: 'Choice must be ROCK, PAPER, or SCISSORS' });
  }

  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'IN_PROGRESS') {
      return res.status(400).json({ error: 'Round is not open for submissions' });
    }

    const isPlayerA = String(match.player_a_id) === String(userId);
    const isPlayerB = String(match.player_b_id) === String(userId);
    if (!isPlayerA && !isPlayerB) return res.status(403).json({ error: 'Unauthorized' });

    if ((isPlayerA && match.player_a_choice) || (isPlayerB && match.player_b_choice)) {
      return res.status(400).json({ error: 'Already submitted for this round' });
    }

    const colToUpdate = isPlayerA ? 'player_a_choice' : 'player_b_choice';
    const normalizedChoice = choice.toUpperCase();

    db.run(
      `UPDATE rps_matches SET ${colToUpdate} = ? WHERE id = ?`,
      [normalizedChoice, matchId],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: 'Failed to record choice' });

        db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (checkErr, updatedMatch) => {
          if (updatedMatch.player_a_choice && updatedMatch.player_b_choice) {
            return resolveRound(updatedMatch, (resErr, finalMatch) => {
              if (resErr) return res.status(500).json({ error: 'Resolution error' });
              return res.json({
                success: true,
                status: finalMatch.status,
                revealed: true,
                message: 'Both submitted! Round resolved.'
              });
            });
          }

          return res.json({
            success: true,
            status: 'IN_PROGRESS',
            revealed: false,
            message: 'Waiting for opponent...'
          });
        });
      }
    );
  });
});

router.post('/next-round', authenticateToken, (req, res) => {
  const { matchId } = req.body;

  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'ROUND_REVEAL') {
      return res.json({ success: true, status: match.status });
    }

    db.run(
      `UPDATE rps_matches 
       SET current_round = current_round + 1,
           player_a_choice = NULL,
           player_b_choice = NULL,
           status = 'IN_PROGRESS',
           round_start_time = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [matchId],
      (advanceErr) => {
        if (advanceErr) return res.status(500).json({ error: 'Failed to start next round' });
        return res.json({ success: true, status: 'IN_PROGRESS' });
      }
    );
  });
});

router.post('/surrender', authenticateToken, (req, res) => {
  const { matchId } = req.body;
  const userId = getAuthUserId(req);

  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status === 'COMPLETED' || match.status === 'DRAW') {
      return res.status(400).json({ error: 'Match has ended' });
    }

    const winnerId = String(match.player_a_id) === String(userId) ? match.player_b_id : match.player_a_id;
    settleMatchPayout(match.id, winnerId, false, match.player_a_score, match.player_b_score, match.last_round_result, (pErr) => {
      if (pErr) return res.status(500).json({ error: 'Payout error' });
      res.json({ success: true, message: 'You surrendered the match', winnerId: winnerId });
    });
  });
});

// FIX: Resolves rounds and explicitly records final scores (2-0, 2-1)
function resolveRound(match, callback) {
  if (match.status !== 'IN_PROGRESS') {
    return callback(null, match);
  }

  const evalResult = evaluateRound(match.player_a_choice, match.player_b_choice);

  let newScoreA = match.player_a_score || 0;
  let newScoreB = match.player_b_score || 0;
  let roundWinnerId = null;

  if (evalResult.winner === 'A') {
    newScoreA += 1;
    roundWinnerId = match.player_a_id;
  } else if (evalResult.winner === 'B') {
    newScoreB += 1;
    roundWinnerId = match.player_b_id;
  }

  const roundResultData = JSON.stringify({
    round: match.current_round,
    playerAChoice: match.player_a_choice || 'TIMEOUT',
    playerBChoice: match.player_b_choice || 'TIMEOUT',
    winner: evalResult.winner,
    roundWinnerId: roundWinnerId,
    reason: evalResult.reason
  });

  // End match immediately if someone reaches 2 wins
  if (newScoreA >= WINS_TO_MATCH) {
    settleMatchPayout(match.id, match.player_a_id, false, newScoreA, newScoreB, roundResultData, (err) => {
      db.get('SELECT * FROM rps_matches WHERE id = ?', [match.id], callback);
    });
  } else if (newScoreB >= WINS_TO_MATCH) {
    settleMatchPayout(match.id, match.player_b_id, false, newScoreA, newScoreB, roundResultData, (err) => {
      db.get('SELECT * FROM rps_matches WHERE id = ?', [match.id], callback);
    });
  } else {
    // Intermediate round: Set to ROUND_REVEAL with updated scores
    db.run(
      `UPDATE rps_matches 
       SET player_a_score = ?,
           player_b_score = ?,
           status = 'ROUND_REVEAL',
           last_round_result = ?
       WHERE id = ?`,
      [newScoreA, newScoreB, roundResultData, match.id],
      (uErr) => {
        if (uErr) return callback(uErr);
        db.get('SELECT * FROM rps_matches WHERE id = ?', [match.id], callback);
      }
    );
  }
}

// Atomically stores final scores (e.g. 2-0, 2-1) and handles payouts
function settleMatchPayout(matchId, winnerId, isDraw, finalScoreA, finalScoreB, finalRoundResult, callback) {
  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return callback(new Error('Match not found'));
    if (match.status === 'COMPLETED' || match.status === 'DRAW') return callback(null);

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      if (isDraw) {
        db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, match.player_a_id]);
        db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, match.player_b_id]);
        db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_REFUND', ?, ?)`, [match.player_a_id, ENTRY_FEE, `RPS_DRAW_${match.id}`]);
        db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_REFUND', ?, ?)`, [match.player_b_id, ENTRY_FEE, `RPS_DRAW_${match.id}`]);
        db.run(
          `UPDATE rps_matches 
           SET status = 'DRAW', 
               player_a_score = ?, 
               player_b_score = ?, 
               last_round_result = ? 
           WHERE id = ?`,
          [finalScoreA, finalScoreB, finalRoundResult, matchId],
          (uErr) => {
            if (uErr) { db.run('ROLLBACK'); return callback(uErr); }
            db.run('COMMIT', callback);
          }
        );
      } else {
        db.run(
          `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
          [WINNER_PRIZE, ENTRY_FEE, winnerId]
        );
        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_WIN', ?, ?)`,
          [winnerId, WINNER_PRIZE, `RPS_WIN_${match.id}`]
        );
        // Persist final scores when marking match COMPLETED
        db.run(
          `UPDATE rps_matches 
           SET status = 'COMPLETED', 
               winner_id = ?, 
               player_a_score = ?, 
               player_b_score = ?, 
               last_round_result = ? 
           WHERE id = ?`,
          [winnerId, finalScoreA, finalScoreB, finalRoundResult, matchId],
          (uErr) => {
            if (uErr) { db.run('ROLLBACK'); return callback(uErr); }
            db.run('COMMIT', callback);
          }
        );
      }
    });
  });
}

module.exports = router;
