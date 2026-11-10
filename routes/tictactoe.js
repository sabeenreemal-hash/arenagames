// backend/routes/tictactoe.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');
const { creditReferralCommission } = require('../services/referralService');

const GAME_ID = 'tictactoe_1v1';
const ENTRY_FEE = 100;
const WINNER_PRIZE = 200;
const TURN_TIMEOUT_SECONDS = 30;
const MAX_MATCHES = 10;
const BREAK_DURATION_SEC = 10 * 60; // 10 Minutes Break

// Table for tracking 10-match game cycles & 10-minute cooldown
db.run(`
  CREATE TABLE IF NOT EXISTS user_game_cooldowns (
    user_id INTEGER NOT NULL,
    game_id TEXT NOT NULL,
    games_played INTEGER DEFAULT 0,
    cooldown_until DATETIME DEFAULT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, game_id)
  )
`);

// 7-Level Stone Badge definitions
const STONE_TIERS = [
  { rank: 7, name: 'RUBY', days: 100 },
  { rank: 6, name: 'DIAMOND', days: 75 },
  { rank: 5, name: 'AMETHYST', days: 50 },
  { rank: 4, name: 'SAPPHIRE', days: 35 },
  { rank: 3, name: 'JADE', days: 20 },
  { rank: 2, name: 'QUARTZ', days: 10 },
  { rank: 1, name: 'AGATE', days: 5 },
];

function calculateStoneBadge(streakDays) {
  const days = streakDays || 0;
  for (const stone of STONE_TIERS) {
    if (days >= stone.days) return stone.name;
  }
  return 'NONE';
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

const WINNING_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

function getAuthUserId(req) {
  if (!req.user) return null;
  return req.user.id || req.user.userId || req.user.sub || null;
}

// Check 10-match / 10-minute cooldown
function getGameCooldown(userId, callback) {
  db.get(
    'SELECT games_played, cooldown_until FROM user_game_cooldowns WHERE user_id = ? AND game_id = ?',
    [userId, GAME_ID],
    (err, row) => {
      if (err || !row) {
        return callback(null, { gamesPlayed: 0, maxGames: MAX_MATCHES, isBlocked: false, remainingSeconds: 0 });
      }

      const now = Date.now();
      if (row.cooldown_until) {
        const untilStr = row.cooldown_until.includes('Z') ? row.cooldown_until : row.cooldown_until.replace(' ', 'T') + 'Z';
        const cooldownTime = new Date(untilStr).getTime();
        if (now < cooldownTime) {
          const remainingSeconds = Math.max(1, Math.ceil((cooldownTime - now) / 1000));
          return callback(null, {
            gamesPlayed: MAX_MATCHES,
            maxGames: MAX_MATCHES,
            isBlocked: true,
            remainingSeconds: remainingSeconds
          });
        } else {
          db.run(
            'UPDATE user_game_cooldowns SET games_played = 0, cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND game_id = ?',
            [userId, GAME_ID]
          );
          return callback(null, { gamesPlayed: 0, maxGames: MAX_MATCHES, isBlocked: false, remainingSeconds: 0 });
        }
      }

      const played = Math.min(MAX_MATCHES, row.games_played || 0);
      return callback(null, { gamesPlayed: played, maxGames: MAX_MATCHES, isBlocked: false, remainingSeconds: 0 });
    }
  );
}

// Record match completion (+1 count, triggers 10m cooldown when reaching 10)
function recordMatchCompleted(userId) {
  const now = Date.now();
  const cooldownEndIso = new Date(now + BREAK_DURATION_SEC * 1000).toISOString();

  db.get(
    'SELECT games_played, cooldown_until FROM user_game_cooldowns WHERE user_id = ? AND game_id = ?',
    [userId, GAME_ID],
    (err, row) => {
      if (!row) {
        db.run(
          'INSERT INTO user_game_cooldowns (user_id, game_id, games_played, cooldown_until) VALUES (?, ?, 1, NULL)',
          [userId, GAME_ID]
        );
      } else {
        const nextCount = (row.games_played || 0) + 1;
        if (nextCount >= MAX_MATCHES) {
          db.run(
            'UPDATE user_game_cooldowns SET games_played = ?, cooldown_until = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND game_id = ?',
            [MAX_MATCHES, cooldownEndIso, userId, GAME_ID]
          );
        } else {
          db.run(
            'UPDATE user_game_cooldowns SET games_played = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND game_id = ?',
            [nextCount, userId, GAME_ID]
          );
        }
      }
    }
  );
}

// Real Human Matchmaking Queue: [{ userId, username, joinedAt }]
let matchmakingQueue = [];

function checkWinner(board) {
  for (const combo of WINNING_COMBOS) {
    const [a, b, c] = combo;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winnerSymbol: board[a], winningLine: combo };
    }
  }
  return { winnerSymbol: null, winningLine: null, isDraw: board.every(cell => cell !== '') };
}

// -----------------------------------------------------------------------------
// 1. GET /api/tictactoe/waiting-players (Actual Real Players in Queue)
// -----------------------------------------------------------------------------
router.get('/waiting-players', authenticateToken, (req, res) => {
  const userId = getAuthUserId(req);
  const now = Date.now();

  // Clean stale tickets older than 90s
  matchmakingQueue = matchmakingQueue.filter(p => (now - p.joinedAt) < 90000);

  getGameCooldown(userId, (cdErr, cdInfo) => {
    res.json({
      success: true,
      count: matchmakingQueue.length,
      players: matchmakingQueue.map(p => ({
        userId: p.userId,
        username: p.username,
        waitingSeconds: Math.floor((now - p.joinedAt) / 1000)
      })),
      cooldown: cdInfo
    });
  });
});

// -----------------------------------------------------------------------------
// 2. POST /api/tictactoe/join-queue (Real PvP Matchmaking)
// -----------------------------------------------------------------------------
router.post('/join-queue', authenticateToken, (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  getGameCooldown(userId, (cdErr, cdInfo) => {
    if (cdInfo && cdInfo.isBlocked) {
      const mins = Math.floor(cdInfo.remainingSeconds / 60);
      const secs = cdInfo.remainingSeconds % 60;
      return res.status(400).json({
        success: false,
        error: `10-match limit reached! Take a 10-minute break. Next match in ${mins}m ${secs}s.`,
        cooldown: cdInfo
      });
    }

    // Check if player has an active match already
    db.get(
      `SELECT id FROM tictactoe_matches 
       WHERE (player_x_id = ? OR player_o_id = ?) AND status = 'IN_PROGRESS'`,
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

        if (matchmakingQueue.some(p => String(p.userId) === String(userId))) {
          return res.json({
            success: true,
            matched: false,
            inQueue: true,
            message: 'Already in matchmaking queue.'
          });
        }

        db.get('SELECT id, balance, username FROM users WHERE id = ?', [userId], (userErr, user) => {
          if (userErr || !user) return res.status(404).json({ error: 'User profile not found' });
          
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
                  `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TICTACTOE_ENTRY', ?, ?)`,
                  [user.id, -ENTRY_FEE, `TTT_ENTRY_${Date.now()}`]
                );

                db.run('COMMIT', (commitErr) => {
                  if (commitErr) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Transaction commit failed' });
                  }

                  // Find an available REAL human opponent in the queue
                  const opponentIndex = matchmakingQueue.findIndex(p => String(p.userId) !== String(user.id));

                  if (opponentIndex !== -1) {
                    // Real player found! Connect both players
                    const opponent = matchmakingQueue.splice(opponentIndex, 1)[0];
                    const matchId = `match_${crypto.randomBytes(8).toString('hex')}`;
                    const initialBoard = JSON.stringify(['', '', '', '', '', '', '', '', '']);

                    db.run(
                      `INSERT INTO tictactoe_matches (
                        id, player_x_id, player_o_id, player_x_name, player_o_name,
                        current_turn, board, status, pot_amount, last_move_at
                      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', 200, CURRENT_TIMESTAMP)`,
                      [matchId, opponent.userId, user.id, opponent.username, user.username, opponent.userId, initialBoard],
                      (insErr) => {
                        if (insErr) return res.status(500).json({ error: 'Failed to create match' });
                        return res.json({
                          success: true,
                          matched: true,
                          matchId: matchId,
                          symbol: 'O',
                          opponentName: opponent.username
                        });
                      }
                    );
                  } else {
                    // No other human player available -> Wait in queue
                    matchmakingQueue.push({
                      userId: user.id,
                      username: user.username,
                      joinedAt: Date.now()
                    });

                    return res.json({
                      success: true,
                      matched: false,
                      inQueue: true,
                      message: 'Searching for a real opponent...'
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
});

// -----------------------------------------------------------------------------
// 3. POST /api/tictactoe/cancel-queue
// -----------------------------------------------------------------------------
router.post('/cancel-queue', authenticateToken, (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const queueIndex = matchmakingQueue.findIndex(p => String(p.userId) === String(userId));
  if (queueIndex === -1) {
    db.get(
      `SELECT id FROM tictactoe_matches 
       WHERE (player_x_id = ? OR player_o_id = ?) AND status = 'IN_PROGRESS'`,
      [userId, userId],
      (err, activeMatch) => {
        if (activeMatch) return res.status(400).json({ error: 'Match already started' });
        return res.status(400).json({ error: 'You are not in the queue' });
      }
    );
    return;
  }

  matchmakingQueue.splice(queueIndex, 1);

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
        return res.status(500).json({ error: 'Refund failed' });
      }
      return res.json({ success: true, message: 'Matchmaking cancelled. 100 coins refunded.' });
    });
  });
});

// -----------------------------------------------------------------------------
// 4. GET /api/tictactoe/check-queue-status (Checks if another human paired with you)
// -----------------------------------------------------------------------------
router.get('/check-queue-status', authenticateToken, (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  db.get(
    `SELECT * FROM tictactoe_matches 
     WHERE (player_x_id = ? OR player_o_id = ?) AND status = 'IN_PROGRESS' 
     ORDER BY created_at DESC LIMIT 1`,
    [userId, userId],
    (err, match) => {
      if (err) return res.status(500).json({ error: 'Database query failed' });
      if (match) {
        return res.json({
          success: true,
          matched: true,
          matchId: match.id,
          symbol: String(match.player_x_id) === String(userId) ? 'X' : 'O',
          opponentName: String(match.player_x_id) === String(userId) ? match.player_o_name : match.player_x_name
        });
      }

      const inQueue = matchmakingQueue.some(p => String(p.userId) === String(userId));
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
  const userId = getAuthUserId(req);

  db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (String(match.player_x_id) !== String(userId) && String(match.player_o_id) !== String(userId)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const lastMoveTime = new Date(match.last_move_at || match.created_at).getTime();
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - lastMoveTime) / 1000));
    const secondsRemaining = Math.max(0, TURN_TIMEOUT_SECONDS - elapsedSeconds);

    if (match.status === 'IN_PROGRESS' && elapsedSeconds >= TURN_TIMEOUT_SECONDS) {
      const timedOutPlayerId = match.current_turn;
      const winnerId = String(timedOutPlayerId) === String(match.player_x_id)
          ? match.player_o_id
          : match.player_x_id;

      handleMatchFinish(match.id, winnerId, null, false, () => {
        db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (reErr, updatedMatch) => {
          sendMatchResponse(res, updatedMatch || match, userId, 0, true);
        });
      });
      return;
    }

    sendMatchResponse(res, match, userId, secondsRemaining, false);
  });
});

function sendMatchResponse(res, match, userId, secondsRemaining, timedOut) {
  let board = [];
  let winningLine = null;
  try { board = JSON.parse(match.board); } catch (_) { board = Array(9).fill(''); }
  try {
    if (match.winning_line && match.winning_line !== 'DRAW_RESET') {
      winningLine = JSON.parse(match.winning_line);
    }
  } catch (_) {}

  const isPlayerX = String(match.player_x_id) === String(userId);

  res.json({
    success: true,
    matchId: match.id,
    playerX: { id: match.player_x_id, username: match.player_x_name },
    playerO: { id: match.player_o_id, username: match.player_o_name },
    mySymbol: isPlayerX ? 'X' : 'O',
    isMyTurn: String(match.current_turn) === String(userId) && match.status === 'IN_PROGRESS',
    currentTurnUserId: match.current_turn,
    board: board,
    status: match.status,
    winnerId: match.winner_id,
    winningLine: winningLine,
    isDrawReset: match.winning_line === 'DRAW_RESET',
    potAmount: match.pot_amount,
    secondsRemaining: secondsRemaining,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    lastMoveAt: match.last_move_at,
    isTimedOut: timedOut
  });
}

// -----------------------------------------------------------------------------
// 6. POST /api/tictactoe/move (Handles Instant Rematch on Draw)
// -----------------------------------------------------------------------------
router.post('/move', authenticateToken, (req, res) => {
  const { matchId, cellIndex } = req.body;
  const userId = getAuthUserId(req);

  if (cellIndex === undefined || cellIndex < 0 || cellIndex > 8) {
    return res.status(400).json({ error: 'Invalid cell index' });
  }

  db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'IN_PROGRESS') {
      return res.status(400).json({ error: 'Match has ended' });
    }
    if (String(match.current_turn) !== String(userId)) {
      return res.status(400).json({ error: "It is not your turn" });
    }

    let board = [];
    try { board = JSON.parse(match.board); } catch (_) { board = Array(9).fill(''); }

    if (board[cellIndex] !== '') {
      return res.status(400).json({ error: 'Cell is already occupied' });
    }

    const symbol = String(match.player_x_id) === String(userId) ? 'X' : 'O';
    board[cellIndex] = symbol;

    const outcome = checkWinner(board);

    if (outcome.winnerSymbol) {
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
      // DRAW: Reset the board immediately with the same real human opponent
      const nextTurn = String(match.player_x_id) === String(userId) ? match.player_o_id : match.player_x_id;
      const freshBoard = JSON.stringify(['', '', '', '', '', '', '', '', '']);

      db.run(
        `UPDATE tictactoe_matches 
         SET board = ?, current_turn = ?, winning_line = 'DRAW_RESET', last_move_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [freshBoard, nextTurn, match.id],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: 'Failed to reset draw match' });
          return res.json({
            success: true,
            status: 'IN_PROGRESS',
            isDrawReset: true,
            board: ['', '', '', '', '', '', '', '', ''],
            nextTurn: nextTurn,
            secondsRemaining: TURN_TIMEOUT_SECONDS
          });
        }
      );
    } else {
      const nextTurn = String(match.player_x_id) === String(userId) ? match.player_o_id : match.player_x_id;
      db.run(
        `UPDATE tictactoe_matches 
         SET board = ?, current_turn = ?, winning_line = NULL, last_move_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [JSON.stringify(board), nextTurn, match.id],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: 'Failed to record move' });
          return res.json({
            success: true,
            status: 'IN_PROGRESS',
            board: board,
            nextTurn: nextTurn,
            secondsRemaining: TURN_TIMEOUT_SECONDS
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
  const userId = getAuthUserId(req);

  db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'IN_PROGRESS') {
      return res.status(400).json({ error: 'Match already finished' });
    }

    const winnerId = String(match.player_x_id) === String(userId) ? match.player_o_id : match.player_x_id;
    handleMatchFinish(match.id, winnerId, null, false, (finishErr) => {
      if (finishErr) return res.status(500).json({ error: 'Surrender failed' });
      res.json({ success: true, message: 'You surrendered.', winnerId: winnerId });
    });
  });
});

function handleMatchFinish(matchId, winnerId, winningLine, isDraw, callback) {
  db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return callback(new Error('Match not found'));
    if (match.status !== 'IN_PROGRESS') return callback(null);

    // Record game completion toward the 10-match cycle
    recordMatchCompleted(match.player_x_id);
    recordMatchCompleted(match.player_o_id);

    // Real Human Winner: Award 200 coins and advance Daily Streak
    db.get('SELECT * FROM users WHERE id = ?', [winnerId], (uErr, user) => {
      if (uErr || !user) return callback(new Error('Winner profile missing'));

      const today = getTodayStr();
      const yesterday = getYesterdayStr();
      const coinsEarned = ENTRY_FEE;

      let currentStreak = user.current_streak || 0;
      let highestStreak = user.highest_streak || 0;
      let lastStreakDate = user.last_streak_date || '';

      let newEligible = (user.last_eligible_date === today)
        ? ((user.eligible_daily_coins || 0) + coinsEarned)
        : coinsEarned;

      if (user.last_eligible_date !== today && lastStreakDate !== yesterday && lastStreakDate !== today && currentStreak > 0) {
        currentStreak = 0;
      }

      if (newEligible >= 100 && lastStreakDate !== today) {
        currentStreak += 1;
        lastStreakDate = today;
        if (currentStreak > highestStreak) highestStreak = currentStreak;
      }

      const currentStone = calculateStoneBadge(currentStreak);

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run(
          `UPDATE users SET 
            balance = balance + ?, 
            total_coins_earned = COALESCE(total_coins_earned, 0) + ?, 
            eligible_daily_coins = ?, 
            last_eligible_date = ?, 
            current_streak = ?, 
            highest_streak = ?, 
            last_streak_date = ?, 
            current_stone = ? 
           WHERE id = ?`,
          [
            WINNER_PRIZE,
            coinsEarned,
            newEligible,
            today,
            currentStreak,
            highestStreak,
            lastStreakDate,
            currentStone,
            winnerId
          ]
        );

        db.run(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TICTACTOE_WIN', ?, ?)`,
          [winnerId, WINNER_PRIZE, `WIN_${match.id}`]
        );

        db.run(
          `UPDATE tictactoe_matches SET status = 'COMPLETED', winner_id = ?, winning_line = ? WHERE id = ?`,
          [winnerId, winningLine ? JSON.stringify(winningLine) : null, match.id],
          (finErr) => {
            if (finErr) { db.run('ROLLBACK'); return callback(finErr); }
            db.run('COMMIT', (cErr) => {
              if (!cErr) {
                creditReferralCommission(winnerId, coinsEarned, 'TICTACTOE', `WIN_${match.id}`, 0.10);
              }
              callback(cErr);
            });
          }
        );
      });
    });
  });
}

module.exports = router;
