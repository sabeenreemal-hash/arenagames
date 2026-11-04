// backend/routes/tictactoe.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');

const ENTRY_FEE = 100;
const WINNER_PRIZE = 200;
const TURN_TIMEOUT_SECONDS = 30;
const BOT_WAIT_TIMEOUT_MS = 3500; // Wait 3.5s for real player before matching bot
const BOT_USER_ID = 999999;

const BOT_NAMES = [
  'ShadowNinja', 'ViperQueen', 'Alex_Pro99', 'CyberSamurai', 'NovaStrike',
  'Elena_92', 'ApexHunter', 'GhostRider_X', 'BlazeFury', 'ZenithPulse',
  'AeroKnight', 'PixelWarrior', 'ThunderHawk', 'EchoGamer', 'TitanX',
  'Vortex_77', 'Krypton', 'CrimsonBlade', 'NeonRider', 'Spectre_01'
];

// Self-healing: Ensure Bot account exists in SQLite users table
db.run(`
  INSERT OR IGNORE INTO users (id, full_name, username, email, password_hash, referral_code, balance) 
  VALUES (999999, 'Arena Challenger', 'arena_bot_system', 'bot@arenagames.internal', 'DISABLED_BOT_ACCOUNT', 'BOT9999', 1000000)
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
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
  [0, 4, 8], [2, 4, 6]             // Diagonals
];

function getAuthUserId(req) {
  if (!req.user) return null;
  return req.user.id || req.user.userId || req.user.sub || null;
}

let matchmakingQueue = [];

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

// Casual, Beatable Bot Move Calculation (Not impossible or frustrating)
function calculateCasualBotMove(board, botSymbol, humanSymbol) {
  const emptyCells = [];
  for (let i = 0; i < 9; i++) {
    if (board[i] === '') emptyCells.push(i);
  }
  if (emptyCells.length === 0) return -1;

  // 1. Can Bot win this turn? (Take it 60% of the time, 40% casual oversight)
  if (Math.random() < 0.60) {
    for (const combo of WINNING_COMBOS) {
      const [a, b, c] = combo;
      const line = [board[a], board[b], board[c]];
      if (line.filter(s => s === botSymbol).length === 2 && line.includes('')) {
        if (board[a] === '') return a;
        if (board[b] === '') return b;
        if (board[c] === '') return c;
      }
    }
  }

  // 2. Can Human win next turn? Block it with only 55% probability
  // (45% chance bot makes a mistake so human can actually win and celebrate!)
  if (Math.random() < 0.55) {
    for (const combo of WINNING_COMBOS) {
      const [a, b, c] = combo;
      const line = [board[a], board[b], board[c]];
      if (line.filter(s => s === humanSymbol).length === 2 && line.includes('')) {
        if (board[a] === '') return a;
        if (board[b] === '') return b;
        if (board[c] === '') return c;
      }
    }
  }

  // 3. Take Center (45% chance)
  if (board[4] === '' && Math.random() < 0.45) {
    return 4;
  }

  // 4. Random casual move from remaining cells
  return emptyCells[Math.floor(Math.random() * emptyCells.length)];
}

// Executes bot move with human delay
function triggerBotMoveIfTurn(matchId) {
  db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match || match.status !== 'IN_PROGRESS') return;
    if (String(match.current_turn) !== String(BOT_USER_ID)) return;

    let board = [];
    try { board = JSON.parse(match.board); } catch (_) { board = Array(9).fill(''); }

    const isBotPlayerX = String(match.player_x_id) === String(BOT_USER_ID);
    const botSymbol = isBotPlayerX ? 'X' : 'O';
    const humanSymbol = isBotPlayerX ? 'O' : 'X';

    const chosenCell = calculateCasualBotMove(board, botSymbol, humanSymbol);
    if (chosenCell === -1) return;

    // Realistic human response time: 1.2s - 2.2s
    const delay = Math.floor(Math.random() * 1000) + 1200;

    setTimeout(() => {
      db.get('SELECT * FROM tictactoe_matches WHERE id = ?', [matchId], (currErr, currentMatch) => {
        if (currErr || !currentMatch || currentMatch.status !== 'IN_PROGRESS') return;
        if (String(currentMatch.current_turn) !== String(BOT_USER_ID)) return;

        let curBoard = [];
        try { curBoard = JSON.parse(currentMatch.board); } catch (_) { curBoard = Array(9).fill(''); }
        if (curBoard[chosenCell] !== '') return;

        curBoard[chosenCell] = botSymbol;
        const outcome = checkWinner(curBoard);

        if (outcome.winnerSymbol) {
          handleMatchFinish(matchId, BOT_USER_ID, outcome.winningLine, false, () => {});
        } else if (outcome.isDraw) {
          handleMatchFinish(matchId, null, null, true, () => {});
        } else {
          const nextTurn = isBotPlayerX ? currentMatch.player_o_id : currentMatch.player_x_id;
          db.run(
            `UPDATE tictactoe_matches 
             SET board = ?, current_turn = ?, last_move_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [JSON.stringify(curBoard), nextTurn, matchId]
          );
        }
      });
    }, delay);
  });
}

// -----------------------------------------------------------------------------
// 1. GET /api/tictactoe/waiting-players (Always shows 100+ waiting players)
// -----------------------------------------------------------------------------
router.get('/waiting-players', authenticateToken, (req, res) => {
  const now = Date.now();
  matchmakingQueue = matchmakingQueue.filter(p => (now - p.joinedAt) < 90000);

  // Fluctuates naturally between 100 and 108 players
  const fakeWaitingCount = 100 + Math.floor((now / 15000) % 9);
  const totalCount = Math.max(matchmakingQueue.length, fakeWaitingCount);

  // Generate populated sample list with authentic usernames
  const sampleList = BOT_NAMES.slice(0, 10).map((name, i) => ({
    userId: 900000 + i,
    username: name,
    waitingSeconds: (i * 2) + 1
  }));

  res.json({
    success: true,
    count: totalCount,
    players: matchmakingQueue.length > 0
      ? matchmakingQueue.map(p => ({
          userId: p.userId,
          username: p.username,
          waitingSeconds: Math.floor((now - p.joinedAt) / 1000)
        })).concat(sampleList)
      : sampleList
  });
});

// -----------------------------------------------------------------------------
// 2. POST /api/tictactoe/join-queue
// -----------------------------------------------------------------------------
router.post('/join-queue', authenticateToken, (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

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

                // Check for real human in queue
                const opponentIndex = matchmakingQueue.findIndex(p => String(p.userId) !== String(user.id));

                if (opponentIndex !== -1) {
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
                  matchmakingQueue.push({
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
// 4. GET /api/tictactoe/check-queue-status (Auto Bot Matchmaker)
// -----------------------------------------------------------------------------
router.get('/check-queue-status', authenticateToken, (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // 1. Check if active match exists
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

      // 2. Check if user is in queue
      const qIndex = matchmakingQueue.findIndex(p => String(p.userId) === String(userId));
      if (qIndex === -1) {
        return res.json({ success: true, matched: false, inQueue: false });
      }

      const playerEntry = matchmakingQueue[qIndex];
      const waitingMs = Date.now() - playerEntry.joinedAt;

      // 3. Bot Fallback: Matches bot after 3.5s wait
      if (waitingMs >= BOT_WAIT_TIMEOUT_MS) {
        const matchId = `match_${crypto.randomBytes(8).toString('hex')}`;
        const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
        const isUserPlayerX = Math.random() < 0.5;

        const playerXId = isUserPlayerX ? playerEntry.userId : BOT_USER_ID;
        const playerOId = isUserPlayerX ? BOT_USER_ID : playerEntry.userId;
        const playerXName = isUserPlayerX ? playerEntry.username : botName;
        const playerOName = isUserPlayerX ? botName : playerEntry.username;
        const initialBoard = JSON.stringify(['', '', '', '', '', '', '', '', '']);

        db.run(
          `INSERT INTO tictactoe_matches (
            id, player_x_id, player_o_id, player_x_name, player_o_name,
            current_turn, board, status, pot_amount, last_move_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', 200, CURRENT_TIMESTAMP)`,
          [matchId, playerXId, playerOId, playerXName, playerOName, playerXId, initialBoard],
          (insErr) => {
            if (insErr) {
              console.error('[TTT BOT MATCH INSERT ERROR]:', insErr.message);
              return res.status(500).json({ error: 'Failed to create match' });
            }

            // Remove from queue ONLY after successful insertion
            matchmakingQueue.splice(qIndex, 1);

            if (!isUserPlayerX) {
              triggerBotMoveIfTurn(matchId);
            }

            return res.json({
              success: true,
              matched: true,
              matchId: matchId,
              symbol: isUserPlayerX ? 'X' : 'O',
              opponentName: botName
            });
          }
        );
        return;
      }

      return res.json({
        success: true,
        matched: false,
        inQueue: true
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

    if (match.status === 'IN_PROGRESS' && String(match.current_turn) === String(BOT_USER_ID)) {
      triggerBotMoveIfTurn(match.id);
    }

    sendMatchResponse(res, match, userId, secondsRemaining, false);
  });
});

function sendMatchResponse(res, match, userId, secondsRemaining, timedOut) {
  let board = [];
  let winningLine = null;
  try { board = JSON.parse(match.board); } catch (_) { board = Array(9).fill(''); }
  try { if (match.winning_line) winningLine = JSON.parse(match.winning_line); } catch (_) {}

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
    potAmount: match.pot_amount,
    secondsRemaining: secondsRemaining,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    lastMoveAt: match.last_move_at,
    isTimedOut: timedOut
  });
}

// -----------------------------------------------------------------------------
// 6. POST /api/tictactoe/move
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
      handleMatchFinish(match.id, null, null, true, (finishErr) => {
        if (finishErr) return res.status(500).json({ error: 'Failed to record draw' });
        return res.json({
          success: true,
          status: 'DRAW',
          board: board
        });
      });
    } else {
      const nextTurn = String(match.player_x_id) === String(userId) ? match.player_o_id : match.player_x_id;
      db.run(
        `UPDATE tictactoe_matches 
         SET board = ?, current_turn = ?, last_move_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [JSON.stringify(board), nextTurn, match.id],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: 'Failed to record move' });

          if (String(nextTurn) === String(BOT_USER_ID)) {
            triggerBotMoveIfTurn(match.id);
          }

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

    // Case 1: DRAW -> Refund real human players
    if (isDraw) {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        if (String(match.player_x_id) !== String(BOT_USER_ID)) {
          db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, match.player_x_id]);
          db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TICTACTOE_REFUND', ?, ?)`, [match.player_x_id, ENTRY_FEE, `DRAW_${match.id}`]);
        }

        if (String(match.player_o_id) !== String(BOT_USER_ID)) {
          db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, match.player_o_id]);
          db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TICTACTOE_REFUND', ?, ?)`, [match.player_o_id, ENTRY_FEE, `DRAW_${match.id}`]);
        }

        db.run(
          `UPDATE tictactoe_matches SET status = 'DRAW' WHERE id = ?`,
          [match.id],
          (uErr) => {
            if (uErr) { db.run('ROLLBACK'); return callback(uErr); }
            db.run('COMMIT', callback);
          }
        );
      });
      return;
    }

    // Case 2: BOT WINS -> Simply mark match COMPLETED (preserves real player stats)
    if (String(winnerId) === String(BOT_USER_ID)) {
      db.run(
        `UPDATE tictactoe_matches SET status = 'COMPLETED', winner_id = ?, winning_line = ? WHERE id = ?`,
        [winnerId, winningLine ? JSON.stringify(winningLine) : null, match.id],
        (finErr) => {
          if (finErr) return callback(finErr);
          callback(null);
        }
      );
      return;
    }

    // Case 3: REAL HUMAN WINS -> Award 200 coins and advance Daily Streak
    db.get('SELECT * FROM users WHERE id = ?', [winnerId], (uErr, user) => {
      if (uErr || !user) return callback(new Error('Winner profile missing'));

      const today = getTodayStr();
      const yesterday = getYesterdayStr();
      const coinsEarned = ENTRY_FEE; // Net profit (+100 coins)

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
            db.run('COMMIT', callback);
          }
        );
      });
    });
  });
}

module.exports = router;
