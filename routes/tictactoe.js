// backend/routes/tictactoe.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const ENTRY_FEE = 100;
const WINNER_PRIZE = 200;

// Winning 3-cell lines on a 3x3 board (indices 0..8)
const WINNING_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
  [0, 4, 8], [2, 4, 6]             // Diagonals
];

// In-Memory Matchmaking Queue: Array of { userId, username, joinedAt }
let matchmakingQueue = [];

// Helper: Check winner on a board
function checkWinner(board) {
  for (const combo of WINNING_COMBOS) {
    const [a, b, c] = combo;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winnerSymbol: board[a], winningLine: combo };
    }
  }
  const isFull = board.every(cell => cell !== '');
  return { winnerSymbol: null, winningLine: null, isDraw: isFull };
}

// -----------------------------------------------------------------------------
// 1. GET /api/tictactoe/waiting-players
// -----------------------------------------------------------------------------
router.get('/waiting-players', authenticateToken, (req, res) => {
  // Purge any stale queue tickets (> 90 seconds old)
  const now = Date.now();
  matchmakingQueue = matchmakingQueue.filter(p => (now - p.joinedAt) < 90000);

  res.json({
    success: true,
    count: matchmakingQueue.length,
    players: matchmakingQueue.map(p => ({
      userId: p.userId,
      username: p.username,
      waitingSeconds: Math.floor((now - p.joinedAt) / 1000)
    }))
  });
});

// -----------------------------------------------------------------------------
// 2. POST /api/tictactoe/join-queue
// -----------------------------------------------------------------------------
router.post('/join-queue', authenticateToken, (req, res) => {
  const userId = req.user.id;

  // 1. Check if user already has an active game
  db.get(
    `SELECT id FROM tictactoe_matches 
     WHERE (player_x_id = ? OR player_o_id = ?) AND status = 'IN_PROGRESS'`,
    [userId, userId],
    (matchErr, activeMatch) => {
      if (matchErr) return res.status(500).json({ error: 'Database check failed' });
      if (activeMatch) {
        return res.json({
          success: true,
          matched: true,
          matchId: activeMatch.id,
          message: 'Active match resumed.'
        });
      }

      // 2. Check if already in queue
      const existingQueueIndex = matchmakingQueue.findIndex(p => p.userId === userId);
      if (existingQueueIndex !== -1) {
        return res.json({
          success: true,
          matched: false,
          inQueue: true,
          message: 'Already in matchmaking queue.'
        });
      }

      // 3. Check coin balance and username
      db.get('SELECT balance, username FROM users WHERE id = ?', [userId], (userErr, user) => {
        if (userErr || !user) return res.status(404).json({ error: 'User profile not found' });
        if ((user.balance || 0) < ENTRY_FEE) {
          return res.status(400).json({
            error: `Insufficient coins. ${ENTRY_FEE} coins required to enter.`
          });
        }

        // 4. Deduct 100 coins atomically
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

              const refId = `TTT_ENTRY_${Date.now()}`;
              db.run(
                `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TICTACTOE_ENTRY', ?, ?)`,
                [userId, -ENTRY_FEE, refId]
              );

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Transaction commit failed' });
                }

                // 5. Matchmaking logic
                // Find an available opponent (who is not the same user)
                const opponentIndex = matchmakingQueue.findIndex(p => p.userId !== userId);

                if (opponentIndex !== -1) {
                  const opponent = matchmakingQueue.splice(opponentIndex, 1)[0];
                  const matchId = `match_${crypto.randomBytes(8).toString('hex')}`;

                  // Opponent is Player A (X, goes first), current user is Player B (O)
                  const playerX = opponent;
                  const playerO = { userId: user.id, username: user.username };
                  const initialBoard = JSON.stringify(['', '', '', '', '', '', '', '', '']);

                  db.run(
                    `INSERT INTO tictactoe_matches (
                      id, player_x_id, player_o_id, player_x_name, player_o_name,
                      current_turn, board, status, pot_amount
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', 200)`,
                    [
                      matchId,
                      playerX.userId,
                      playerO.userId,
                      playerX.username,
                      playerO.username,
                      playerX.userId, // Player X moves first
                      initialBoard
                    ],
                    (insErr) => {
                      if (insErr) {
                        console.error('[TTT MATCH CREATE ERROR]:', insErr);
                        return res.status(500).json({ error: 'Failed to create match' });
                      }

                      return res.json({
                        success: true,
                        matched: true,
                        matchId: matchId,
                        symbol: 'O',
                        opponentName: playerX.username
                      });
                    }
                  );
                } else {
                  // No opponent found yet -> add to queue
                  matchmakingQueue.push({
                    userId: user.id,
                    username: user.username,
                    joinedAt: Date.now()
                  });

                  return res.json({
                    success: true,
                    matched: false,
                    inQueue: true,
                    message: 'Joined matchmaking queue. Waiting for opponent...'
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
// 3. POST /api/tictactoe/cancel-queue
// -----------------------------------------------------------------------------
router.post('/cancel-queue', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const queueIndex = matchmakingQueue.findIndex(p => p.userId === userId);

  if (queueIndex === -1) {
    // Check if match started right when user hit cancel
    db.get(
      `SELECT id FROM tictactoe_matches 
       WHERE (player_x_id = ? OR player_o_id = ?) AND status = 'IN_PROGRESS'`,
      [userId, userId],
      (err, activeMatch) => {
        if (activeMatch) {
          return res.status(400).json({
            error: 'Match has already started! Cannot cancel.'
          });
        }
        return res.status(400).json({ error: 'You are not in the matchmaking queue' });
      }
    );
    return;
  }

  // Remove from queue
  matchmakingQueue.splice(queueIndex, 1);

  // Refund 100 coins
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, userId]);
    db.run(
      `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TICTACTOE_REFUND', ?, ?)`,
      [userId, ENTRY_FEE, `REFUND_CANCEL_${Date.now()}`]
    );
    db.run('COMMIT', (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'Refund processing failed' });
      }
      return res.json({
        success: true,
        message: 'Matchmaking cancelled. 100 coins refunded to your wallet.'
      });
    });
  });
});

// -----------------------------------------------------------------------------
// 4. GET /api/tictactoe/check-queue-status
// -----------------------------------------------------------------------------
router.get('/check-queue-status', authenticateToken, (req, res) => {
  const userId = req.user.id;

  // Check if a match was created with this user
  db.get(
    `SELECT * FROM tictactoe_matches 
     WHERE (player_x_id = ? OR player_o_id = ?) AND status = 'IN_PROGRESS' 
     ORDER BY created_at DESC LIMIT 1`,
    [userId, userId],
    (err, match) => {
      if (err) return res.status(500).json({ error: 'Error checking match status' });
      if (match) {
        return res.json({
          success: true,
          matched: true,
          matchId: match.id,
          symbol: match.player_x_id === userId ? 'X' : 'O',
          opponentName: match.player_x_id === userId ? match.player_o_name : match.player_x_name
        });
      }

      const inQueue = matchmakingQueue.some(p => p.userId === userId);
      return res.json({
        success: true,
        matched: false,
        inQueue: inQueue
      });
    }
  );
});

// -----------------------------------------------------------------------------
// 5. GET /api/tictactoe/match/:matchId
// -----------------------------------------------------------------------------
router.get('/match/:matchId', authenticateToken, (req, res) => {
  const { matchId } = req.params;
  const userId = req.user.id;

  db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.player_x_id !== userId && match.player_o_id !== userId) {
      return res.status(403).json({ error: 'Not authorized for this match' });
    }

    // Auto-timeout check: If a player is inactive for > 35 seconds, forfeit to opponent
    const lastMoveTime = new Date(match.last_move_at || match.created_at).getTime();
    const isTimedOut = (Date.now() - lastMoveTime) > 35000 && match.status === 'IN_PROGRESS';

    if (isTimedOut) {
      const winnerId = match.current_turn === match.player_x_id ? match.player_o_id : match.player_x_id;
      handleMatchFinish(match.id, winnerId, null, false, (finishErr) => {
        db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (reErr, updatedMatch) => {
          return sendMatchResponse(res, updatedMatch || match, userId);
        });
      });
      return;
    }

    sendMatchResponse(res, match, userId);
  });
});

function sendMatchResponse(res, match, userId) {
  let board = [];
  let winningLine = null;
  try { board = JSON.parse(match.board); } catch (_) { board = Array(9).fill(''); }
  try { if (match.winning_line) winningLine = JSON.parse(match.winning_line); } catch (_) {}

  res.json({
    success: true,
    matchId: match.id,
    playerX: { id: match.player_x_id, username: match.player_x_name },
    playerO: { id: match.player_o_id, username: match.player_o_name },
    mySymbol: match.player_x_id === userId ? 'X' : 'O',
    isMyTurn: match.current_turn === userId && match.status === 'IN_PROGRESS',
    currentTurnUserId: match.current_turn,
    board: board,
    status: match.status,
    winnerId: match.winner_id,
    winningLine: winningLine,
    potAmount: match.pot_amount,
    lastMoveAt: match.last_move_at
  });
}

// -----------------------------------------------------------------------------
// 6. POST /api/tictactoe/move
// -----------------------------------------------------------------------------
router.post('/move', authenticateToken, (req, res) => {
  const { matchId, cellIndex } = req.body;
  const userId = req.user.id;

  if (cellIndex === undefined || cellIndex < 0 || cellIndex > 8) {
    return res.status(400).json({ error: 'Invalid cell position (must be 0-8)' });
  }

  db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'IN_PROGRESS') {
      return res.status(400).json({ error: 'Match is already finished' });
    }
    if (match.current_turn !== userId) {
      return res.status(400).json({ error: "It is not your turn" });
    }

    let board = [];
    try { board = JSON.parse(match.board); } catch (_) { board = Array(9).fill(''); }

    if (board[cellIndex] !== '') {
      return res.status(400).json({ error: 'Cell is already occupied' });
    }

    const symbol = match.player_x_id === userId ? 'X' : 'O';
    board[cellIndex] = symbol;

    const outcome = checkWinner(board);

    if (outcome.winnerSymbol) {
      // Current player won!
      handleMatchFinish(match.id, userId, outcome.winningLine, false, (finishErr) => {
        if (finishErr) return res.status(500).json({ error: 'Failed to record win' });
        return res.json({
          success: true,
          status: 'COMPLETED',
          winnerId: userId,
          winningLine: outcome.winningLine,
          board: board
        });
      });
    } else if (outcome.isDraw) {
      // Draw!
      handleMatchFinish(match.id, null, null, true, (finishErr) => {
        if (finishErr) return res.status(500).json({ error: 'Failed to record draw' });
        return res.json({
          success: true,
          status: 'DRAW',
          board: board
        });
      });
    } else {
      // Continue game: pass turn to opponent
      const nextTurn = match.player_x_id === userId ? match.player_o_id : match.player_x_id;
      db.run(
        `UPDATE tictactoe_matches 
         SET board = ?, current_turn = ?, last_move_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [JSON.stringify(board), nextTurn, match.id],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: 'Failed to save move' });
          return res.json({
            success: true,
            status: 'IN_PROGRESS',
            board: board,
            nextTurn: nextTurn
          });
        }
      );
    }
  });
});

// -----------------------------------------------------------------------------
// 7. POST /api/tictactoe/surrender
// -----------------------------------------------------------------------------
router.post('/surrender', authenticateToken, (req, res) => {
  const { matchId } = req.body;
  const userId = req.user.id;

  db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'IN_PROGRESS') {
      return res.status(400).json({ error: 'Match has already ended' });
    }

    const winnerId = match.player_x_id === userId ? match.player_o_id : match.player_x_id;
    handleMatchFinish(match.id, winnerId, null, false, (finishErr) => {
      if (finishErr) return res.status(500).json({ error: 'Failed to process surrender' });
      res.json({
        success: true,
        message: 'You surrendered the match.',
        winnerId: winnerId
      });
    });
  });
});

// -----------------------------------------------------------------------------
// Internal Helper: Atomically Credit Winner / Refund Draws
// -----------------------------------------------------------------------------
function handleMatchFinish(matchId, winnerId, winningLine, isDraw, callback) {
  db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return callback(new Error('Match not found'));
    if (match.status !== 'IN_PROGRESS') return callback(null); // Already settled

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      if (isDraw) {
        // Both players receive their 100 coin entry fee back
        db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, match.player_x_id]);
        db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, match.player_o_id]);

        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TICTACTOE_REFUND', ?, ?)`,
          [match.player_x_id, ENTRY_FEE, `DRAW_${match.id}`]
        );
        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TICTACTOE_REFUND', ?, ?)`,
          [match.player_o_id, ENTRY_FEE, `DRAW_${match.id}`]
        );

        db.run(
          `UPDATE tictactoe_matches SET status = 'DRAW' WHERE id = ?`,
          [match.id],
          (uErr) => {
            if (uErr) {
              db.run('ROLLBACK');
              return callback(uErr);
            }
            db.run('COMMIT', callback);
          }
        );
      } else {
        // Winner gets 200 coins
        db.run(
          `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
          [WINNER_PRIZE, ENTRY_FEE, winnerId] // Net gain +100
        );

        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TICTACTOE_WIN', ?, ?)`,
          [winnerId, WINNER_PRIZE, `WIN_${match.id}`]
        );

        db.run(
          `UPDATE tictactoe_matches SET status = 'COMPLETED', winner_id = ?, winning_line = ? WHERE id = ?`,
          [winnerId, winningLine ? JSON.stringify(winningLine) : null, match.id],
          (uErr) => {
            if (uErr) {
              db.run('ROLLBACK');
              return callback(uErr);
            }
            db.run('COMMIT', callback);
          }
        );
      }
    });
  });
}

module.exports = router;
