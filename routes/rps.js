// backend/routes/rps.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const ENTRY_FEE = 100;
const WINNER_PRIZE = 200;
const ROUND_TIME_LIMIT_SEC = 15;
const WINS_TO_MATCH = 2; // Best of 3: First to 2 wins

// In-Memory Matchmaking Queue: [{ userId, username, joinedAt }]
let rpsQueue = [];

// Determine winner of two choices: 'ROCK', 'PAPER', 'SCISSORS'
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

// -----------------------------------------------------------------------------
// 1. GET /api/rps/waiting-players
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// 2. POST /api/rps/join-queue
// -----------------------------------------------------------------------------
router.post('/join-queue', authenticateToken, (req, res) => {
  const userId = req.user.id;

  // Check active match
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

      // Check if already in queue
      if (rpsQueue.some(p => p.userId === userId)) {
        return res.json({
          success: true,
          matched: false,
          inQueue: true,
          message: 'Already in matchmaking queue.'
        });
      }

      // Check coins & deduct 100
      db.get('SELECT balance, username FROM users WHERE id = ?', [userId], (userErr, user) => {
        if (userErr || !user) return res.status(404).json({ error: 'User not found' });
        if ((user.balance || 0) < ENTRY_FEE) {
          return res.status(400).json({ error: `Insufficient coins. ${ENTRY_FEE} coins required.` });
        }

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

          db.run(
            `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
            [ENTRY_FEE, userId, ENTRY_FEE],
            function (deductErr) {
              if (deductErr || this.changes === 0) {
                db.run('ROLLBACK');
                return res.status(400).json({ error: 'Failed to reserve entry fee' });
              }

              db.run(
                `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_ENTRY', ?, ?)`,
                [userId, -ENTRY_FEE, `RPS_ENTRY_${Date.now()}`]
              );

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Transaction commit failed' });
                }

                // Match with opponent
                const oppIndex = rpsQueue.findIndex(p => p.userId !== userId);

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
                        console.error('[RPS MATCH CREATE ERROR]:', insErr);
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
                    message: 'Joined matchmaking queue. Searching for opponent...'
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

// -----------------------------------------------------------------------------
// 3. POST /api/rps/cancel-queue
// -----------------------------------------------------------------------------
router.post('/cancel-queue', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const qIndex = rpsQueue.findIndex(p => p.userId === userId);

  if (qIndex === -1) {
    return res.status(400).json({ error: 'You are not in the matchmaking queue' });
  }

  rpsQueue.splice(qIndex, 1);

  // Refund 100 coins
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
      return res.json({
        success: true,
        message: 'Matchmaking cancelled. 100 coins refunded.'
      });
    });
  });
});

// -----------------------------------------------------------------------------
// 4. GET /api/rps/check-queue-status
// -----------------------------------------------------------------------------
router.get('/check-queue-status', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.get(
    `SELECT * FROM rps_matches 
     WHERE (player_a_id = ? OR player_b_id = ?) 
       AND status IN ('IN_PROGRESS', 'ROUND_REVEAL') 
     ORDER BY created_at DESC LIMIT 1`,
    [userId, userId],
    (err, match) => {
      if (err) return res.status(500).json({ error: 'Query failed' });
      if (match) {
        const opponentName = match.player_a_id === userId ? match.player_b_name : match.player_a_name;
        return res.json({
          success: true,
          matched: true,
          matchId: match.id,
          opponentName: opponentName
        });
      }

      const inQueue = rpsQueue.some(p => p.userId === userId);
      return res.json({
        success: true,
        matched: false,
        inQueue: inQueue
      });
    }
  );
});

// -----------------------------------------------------------------------------
// 5. GET /api/rps/match/:matchId
// -----------------------------------------------------------------------------
router.get('/match/:matchId', authenticateToken, (req, res) => {
  const { matchId } = req.params;
  const userId = req.user.id;

  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.player_a_id !== userId && match.player_b_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const roundStartTime = new Date(match.round_start_time).getTime();
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - roundStartTime) / 1000));
    const secondsRemaining = Math.max(0, ROUND_TIME_LIMIT_SEC - elapsedSeconds);

    // Auto-resolve timeout if timer hit 0 and still IN_PROGRESS
    if (match.status === 'IN_PROGRESS' && elapsedSeconds >= ROUND_TIME_LIMIT_SEC) {
      return resolveRound(match, (rErr, updatedMatch) => {
        sendMatchPayload(res, updatedMatch || match, userId, 0);
      });
    }

    sendMatchPayload(res, match, userId, secondsRemaining);
  });
});

function sendMatchPayload(res, match, userId, secondsRemaining) {
  const isPlayerA = match.player_a_id === userId;
  const myChoice = isPlayerA ? match.player_a_choice : match.player_b_choice;
  const hasOpponentSubmitted = isPlayerA ? (match.player_b_choice !== null) : (match.player_a_choice !== null);

  let lastResult = null;
  try {
    if (match.last_round_result) lastResult = JSON.parse(match.last_round_result);
  } catch (_) {}

  // SECURITY: Opponent's choice is hidden until ROUND_REVEAL or COMPLETED
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
    opponentChoice: opponentChoiceRevealed, // Hidden during IN_PROGRESS
    lastRoundResult: lastResult,
    winnerId: match.winner_id,
    potAmount: match.pot_amount
  });
}

// -----------------------------------------------------------------------------
// 6. POST /api/rps/submit-choice
// -----------------------------------------------------------------------------
router.post('/submit-choice', authenticateToken, (req, res) => {
  const { matchId, choice } = req.body;
  const userId = req.user.id;

  const validChoices = ['ROCK', 'PAPER', 'SCISSORS'];
  if (!choice || !validChoices.includes(choice.toUpperCase())) {
    return res.status(400).json({ error: 'Choice must be ROCK, PAPER, or SCISSORS' });
  }

  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'IN_PROGRESS') {
      return res.status(400).json({ error: 'Round is not open for submissions' });
    }

    const isPlayerA = match.player_a_id === userId;
    const isPlayerB = match.player_b_id === userId;
    if (!isPlayerA && !isPlayerB) return res.status(403).json({ error: 'Unauthorized' });

    // Prevent double submissions in same round
    if ((isPlayerA && match.player_a_choice) || (isPlayerB && match.player_b_choice)) {
      return res.status(400).json({ error: 'You have already submitted your choice for this round' });
    }

    const colToUpdate = isPlayerA ? 'player_a_choice' : 'player_b_choice';
    const normalizedChoice = choice.toUpperCase();

    db.run(
      `UPDATE rps_matches SET ${colToUpdate} = ? WHERE id = ?`,
      [normalizedChoice, matchId],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: 'Failed to record choice' });

        // Re-read match to check if both players have now submitted
        db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (checkErr, updatedMatch) => {
          if (updatedMatch.player_a_choice && updatedMatch.player_b_choice) {
            // Both submitted -> reveal and evaluate immediately!
            return resolveRound(updatedMatch, (resErr, finalMatch) => {
              if (resErr) return res.status(500).json({ error: 'Resolution error' });
              return res.json({
                success: true,
                status: finalMatch.status,
                revealed: true,
                message: 'Both choices submitted! Round resolved.'
              });
            });
          }

          // Waiting for opponent
          return res.json({
            success: true,
            status: 'IN_PROGRESS',
            revealed: false,
            message: 'Choice recorded. Waiting for opponent...'
          });
        });
      }
    );
  });
});

// -----------------------------------------------------------------------------
// 7. POST /api/rps/next-round
// -----------------------------------------------------------------------------
router.post('/next-round', authenticateToken, (req, res) => {
  const { matchId } = req.body;

  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'ROUND_REVEAL') {
      return res.json({ success: true, status: match.status });
    }

    // Advance to next round
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

// -----------------------------------------------------------------------------
// 8. POST /api/rps/surrender
// -----------------------------------------------------------------------------
router.post('/surrender', authenticateToken, (req, res) => {
  const { matchId } = req.body;
  const userId = req.user.id;

  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status === 'COMPLETED' || match.status === 'DRAW') {
      return res.status(400).json({ error: 'Match has already ended' });
    }

    const winnerId = match.player_a_id === userId ? match.player_b_id : match.player_a_id;
    settleMatchPayout(match.id, winnerId, false, (pErr) => {
      if (pErr) return res.status(500).json({ error: 'Payout error' });
      res.json({ success: true, message: 'You surrendered the match', winnerId: winnerId });
    });
  });
});

// -----------------------------------------------------------------------------
// Internal Round Evaluator & Match Settle
// -----------------------------------------------------------------------------
function resolveRound(match, callback) {
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

  // Check if someone reached 2 wins
  if (newScoreA >= WINS_TO_MATCH) {
    // Player A wins match
    settleMatchPayout(match.id, match.player_a_id, false, (err) => {
      db.get('SELECT * FROM rps_matches WHERE id = ?', [match.id], callback);
    });
  } else if (newScoreB >= WINS_TO_MATCH) {
    // Player B wins match
    settleMatchPayout(match.id, match.player_b_id, false, (err) => {
      db.get('SELECT * FROM rps_matches WHERE id = ?', [match.id], callback);
    });
  } else {
    // Set to ROUND_REVEAL so clients can display the side-by-side animation
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

function settleMatchPayout(matchId, winnerId, isDraw, callback) {
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
        db.run(`UPDATE rps_matches SET status = 'DRAW' WHERE id = ?`, [matchId], (uErr) => {
          if (uErr) { db.run('ROLLBACK'); return callback(uErr); }
          db.run('COMMIT', callback);
        });
      } else {
        db.run(
          `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
          [WINNER_PRIZE, ENTRY_FEE, winnerId]
        );
        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_WIN', ?, ?)`,
          [winnerId, WINNER_PRIZE, `RPS_WIN_${match.id}`]
        );
        db.run(
          `UPDATE rps_matches SET status = 'COMPLETED', winner_id = ? WHERE id = ?`,
          [winnerId, matchId],
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
