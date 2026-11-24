// backend/routes/multiplayerRoutes.js
const express = require('express');
const router = express.Router();
const db = require('../database');
const crypto = require('crypto');
const authenticateToken = require('../middleware/auth');
const botEngine = require('../services/multiplayerBotEngine');

// Database Promise Helpers
const dbGet = (sql, params) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbAll = (sql, params) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const dbRun = (sql, params) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) return reject(err);
    resolve(this);
  });
});

// Helper: Standard ISO deadline & Remaining Seconds
function getDeadlineIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function getRemainingSeconds(deadlineIso) {
  if (!deadlineIso) return 0;
  const deadline = new Date(deadlineIso).getTime();
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

// -------------------------------------------------------------
// 1. JOIN MATCHMAKING QUEUE (Deducts 100 Coins, Permits Real Search)
// -------------------------------------------------------------
router.post('/matchmake/join', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { gameId } = req.body;

  if (!['tictactoe', 'rps', 'head_tail'].includes(gameId)) {
    return res.status(400).json({ error: 'Invalid game selected.' });
  }

  try {
    const config = await dbGet('SELECT * FROM multiplayer_game_configs WHERE game_id = ? AND is_enabled = 1', [gameId]);
    if (!config) return res.status(404).json({ error: 'Game is currently offline.' });
    const entryFee = config.entry_fee || 100;

    // Check user balance
    const user = await dbGet('SELECT balance FROM users WHERE id = ?', [userId]);
    if (!user || user.balance < entryFee) {
      return res.status(400).json({ error: `Insufficient balance. ${entryFee} coins required to enter.` });
    }

    // Check if already in active queue
    const existingQueue = await dbGet("SELECT id FROM multiplayer_queue WHERE user_id = ? AND status = 'WAITING'", [userId]);
    if (existingQueue) {
      return res.json({ success: true, queueId: existingQueue.id, message: 'Already in matchmaking queue.' });
    }

    const queueId = 'queue_' + crypto.randomUUID();

    // Deduct entry fee and enter queue
    await dbRun('BEGIN TRANSACTION');
    await dbRun('UPDATE users SET balance = balance - ? WHERE id = ?', [entryFee, userId]);
    await dbRun(
      `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_ENTRY', ?, ?)`,
      [userId, -entryFee, `MP_ENTRY_${gameId}_${queueId}`]
    );
    await dbRun(
      `INSERT INTO multiplayer_queue (id, user_id, game_id, entry_fee, status) VALUES (?, ?, ?, ?, 'WAITING')`,
      [queueId, userId, gameId, entryFee]
    );
    await dbRun('COMMIT');

    res.json({
      success: true,
      queueId,
      estimatedWaitSeconds: 30,
      botEligibleAfterSeconds: 20
    });
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    console.error('[MP Join Queue Error]:', err);
    res.status(500).json({ error: 'Failed to join matchmaking.' });
  }
});

// -------------------------------------------------------------
// 2. POLL MATCHMAKING QUEUE (Priority: Real Players -> 3-Bot Threshold)
// -------------------------------------------------------------
router.get('/matchmake/poll/:queueId', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { queueId } = req.params;

  try {
    const queueRecord = await dbGet('SELECT * FROM multiplayer_queue WHERE id = ? AND user_id = ?', [queueId, userId]);
    if (!queueRecord) return res.status(404).json({ error: 'Queue record not found.' });

    if (queueRecord.status === 'MATCHED' && queueRecord.match_id) {
      return res.json({ status: 'MATCHED', matchId: queueRecord.match_id });
    }

    if (queueRecord.status === 'CANCELLED' || queueRecord.status === 'TIMEOUT') {
      return res.json({ status: queueRecord.status, message: 'Matchmaking session ended.' });
    }

    const elapsedSeconds = Math.floor((Date.now() - new Date(queueRecord.created_at).getTime()) / 1000);

    // 1. TOP PRIORITY: Check for another real human in queue
    const otherPlayer = await dbGet(
      `SELECT * FROM multiplayer_queue 
       WHERE game_id = ? AND status = 'WAITING' AND user_id != ? AND id != ?
       ORDER BY created_at ASC LIMIT 1`,
      [queueRecord.game_id, userId, queueId]
    );

    if (otherPlayer) {
      const matchId = 'match_' + crypto.randomUUID();
      const config = await dbGet('SELECT * FROM multiplayer_game_configs WHERE game_id = ?', [queueRecord.game_id]);
      const turnTimer = config ? config.turn_timer : 30;
      const initialGameState = initGameState(queueRecord.game_id, userId, otherPlayer.user_id);
      const deadline = getDeadlineIso(turnTimer);

      await dbRun('BEGIN TRANSACTION');
      await dbRun(
        `INSERT INTO multiplayer_matches 
          (id, game_id, player1_id, player2_id, is_bot_match, entry_fee, winner_reward, status, turn_user_id, turn_deadline, game_state) 
         VALUES (?, ?, ?, ?, 0, ?, ?, 'ACTIVE', ?, ?, ?)`,
        [matchId, queueRecord.game_id, userId, otherPlayer.user_id, queueRecord.entry_fee, queueRecord.entry_fee * 2, userId, deadline, JSON.stringify(initialGameState)]
      );

      await dbRun(`UPDATE multiplayer_queue SET status = 'MATCHED', match_id = ? WHERE id IN (?, ?)`, [matchId, queueId, otherPlayer.id]);

      // A real player match resets the consecutive bot matches counter for both players
      await dbRun(
        `INSERT INTO multiplayer_cooldowns (user_id, consecutive_bot_matches, cooldown_until)
         VALUES (?, 0, NULL)
         ON CONFLICT(user_id) DO UPDATE SET consecutive_bot_matches = 0, cooldown_until = NULL`,
        [userId]
      );
      await dbRun(
        `INSERT INTO multiplayer_cooldowns (user_id, consecutive_bot_matches, cooldown_until)
         VALUES (?, 0, NULL)
         ON CONFLICT(user_id) DO UPDATE SET consecutive_bot_matches = 0, cooldown_until = NULL`,
        [otherPlayer.user_id]
      );

      await dbRun('COMMIT');
      return res.json({ status: 'MATCHED', matchId });
    }

    // 2. CHECK BOT RESTRICTION AT >= 20 SECONDS
    if (elapsedSeconds >= 20) {
      const cdRow = await dbGet('SELECT * FROM multiplayer_cooldowns WHERE user_id = ?', [userId]);
      let isBotRestricted = false;
      let remainingCooldownSec = 600;

      if (cdRow) {
        if (cdRow.cooldown_until) {
          const cdEnd = new Date(cdRow.cooldown_until).getTime();
          if (Date.now() < cdEnd) {
            isBotRestricted = true;
            remainingCooldownSec = Math.ceil((cdEnd - Date.now()) / 1000);
          } else {
            // Cooldown expired: Reset counter
            await dbRun('UPDATE multiplayer_cooldowns SET consecutive_bot_matches = 0, cooldown_until = NULL WHERE user_id = ?', [userId]);
          }
        } else if (cdRow.consecutive_bot_matches >= 3) {
          isBotRestricted = true;
        }
      }

      // If user reached 3 bot matches, DO NOT assign a bot.
      // Refund the 100 coins and return BOT_LIMIT_REACHED.
      if (isBotRestricted) {
        const cooldownDeadline = new Date(Date.now() + remainingCooldownSec * 1000).toISOString();

        await dbRun('BEGIN TRANSACTION');
        await dbRun(`UPDATE multiplayer_queue SET status = 'CANCELLED' WHERE id = ?`, [queueId]);
        await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [queueRecord.entry_fee, userId]);
        await dbRun(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_REFUND', ?, ?)`,
          [userId, queueRecord.entry_fee, `MP_BOT_LIMIT_REFUND_${queueId}`]
        );
        await dbRun(
          `INSERT INTO multiplayer_cooldowns (user_id, consecutive_bot_matches, cooldown_until, updated_at)
           VALUES (?, 3, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(user_id) DO UPDATE SET 
             consecutive_bot_matches = 3, 
             cooldown_until = COALESCE(cooldown_until, ?), 
             updated_at = CURRENT_TIMESTAMP`,
          [userId, cooldownDeadline, cooldownDeadline]
        );
        await dbRun('COMMIT');

        return res.json({
          status: 'BOT_LIMIT_REACHED',
          message: 'Players are currently unavailable. Please try again after 10 minutes.',
          cooldownRemainingSeconds: remainingCooldownSec
        });
      }

      // If eligible for bot (< 3 bot matches), pair with an active bot
      if (elapsedSeconds < 30) {
        const bot = await dbGet('SELECT * FROM multiplayer_bots WHERE is_active = 1 ORDER BY RANDOM() LIMIT 1');
        if (bot) {
          const matchId = 'match_' + crypto.randomUUID();
          const config = await dbGet('SELECT * FROM multiplayer_game_configs WHERE game_id = ?', [queueRecord.game_id]);
          const turnTimer = config ? config.turn_timer : 30;
          const initialGameState = initGameState(queueRecord.game_id, userId, -bot.id);
          const deadline = getDeadlineIso(turnTimer);

          await dbRun('BEGIN TRANSACTION');
          await dbRun(
            `INSERT INTO multiplayer_matches 
              (id, game_id, player1_id, player2_id, is_bot_match, bot_id, entry_fee, winner_reward, status, turn_user_id, turn_deadline, game_state) 
             VALUES (?, ?, ?, NULL, 1, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
            [matchId, queueRecord.game_id, userId, bot.id, queueRecord.entry_fee, queueRecord.entry_fee * 2, userId, deadline, JSON.stringify(initialGameState)]
          );
          await dbRun(`UPDATE multiplayer_queue SET status = 'MATCHED', match_id = ? WHERE id = ?`, [matchId, queueId]);
          await dbRun('COMMIT');

          return res.json({ status: 'MATCHED', matchId });
        }
      }
    }

    // 3. Fallback: Timeout at 30 seconds
    if (elapsedSeconds >= 30) {
      await dbRun('BEGIN TRANSACTION');
      await dbRun(`UPDATE multiplayer_queue SET status = 'TIMEOUT' WHERE id = ?`, [queueId]);
      await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [queueRecord.entry_fee, userId]);
      await dbRun(
        `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_REFUND', ?, ?)`,
        [userId, queueRecord.entry_fee, `MP_TIMEOUT_REFUND_${queueId}`]
      );
      await dbRun('COMMIT');
      return res.json({ status: 'TIMEOUT', message: 'No opponents available. Entry fee refunded.' });
    }

    res.json({
      status: 'WAITING',
      elapsedSeconds,
      remainingSearchTime: Math.max(0, 30 - elapsedSeconds)
    });
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Error polling matchmaking.' });
  }
});

// -------------------------------------------------------------
// 3. CANCEL MATCHMAKING QUEUE (Refund 100 Coins)
// -------------------------------------------------------------
router.post('/matchmake/cancel', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { queueId } = req.body;

  try {
    const queueRecord = await dbGet("SELECT * FROM multiplayer_queue WHERE id = ? AND user_id = ? AND status = 'WAITING'", [queueId, userId]);
    if (!queueRecord) {
      return res.status(400).json({ error: 'Queue record cannot be cancelled or already matched.' });
    }

    await dbRun('BEGIN TRANSACTION');
    await dbRun(`UPDATE multiplayer_queue SET status = 'CANCELLED' WHERE id = ?`, [queueId]);
    await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [queueRecord.entry_fee, userId]);
    await dbRun(
      `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_REFUND', ?, ?)`,
      [userId, queueRecord.entry_fee, `MP_USER_CANCEL_${queueId}`]
    );
    await dbRun('COMMIT');

    res.json({ success: true, message: 'Matchmaking cancelled. Coins refunded.' });
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to cancel queue.' });
  }
});

function initGameState(gameId, p1Id, p2Id) {
  if (gameId === 'tictactoe') {
    return {
      board: Array(9).fill(null),
      currentTurnSymbol: 'X',
      p1Symbol: 'X',
      p2Symbol: 'O',
      roundNumber: 1,
      botActionScheduledAt: null
    };
  } else if (gameId === 'rps') {
    return {
      round: 1,
      p1Choice: null,
      p2Choice: null,
      lastRoundResult: null,
      botActionScheduledAt: null,
      history: []
    };
  } else if (gameId === 'head_tail') {
    return {
      round: 1,
      p1Choice: null,
      p2Choice: null,
      coinResult: null,
      lastRoundResult: null,
      botActionScheduledAt: null,
      history: []
    };
  }
  return {};
}

// -------------------------------------------------------------
// 4. POLL MATCH STATE (4–5s Natural Bot Delay + Failsafe Timer)
// -------------------------------------------------------------
router.get('/match/:matchId/state', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { matchId } = req.params;

  try {
    const match = await dbGet('SELECT * FROM multiplayer_matches WHERE id = ?', [matchId]);
    if (!match) return res.status(404).json({ error: 'Match not found.' });

    const isPlayer1 = match.player1_id === userId;
    const isPlayer2 = match.player2_id === userId;
    if (!isPlayer1 && !isPlayer2) {
      return res.status(403).json({ error: 'Unauthorized match access.' });
    }

    let state = JSON.parse(match.game_state || '{}');

    // Fetch Player Profiles
    const p1User = await dbGet('SELECT id, username FROM users WHERE id = ?', [match.player1_id]);
    let p2User = null;
    if (match.is_bot_match) {
      p2User = await dbGet('SELECT id, username, avatar_url FROM multiplayer_bots WHERE id = ?', [match.bot_id]);
      if (p2User) {
        // Strip any residual (Bot) marker so it looks like a genuine real player
        p2User.username = p2User.username.replace(/\s*\(Bot\)\s*/gi, '').trim();
      }
    } else if (match.player2_id) {
      p2User = await dbGet('SELECT id, username FROM users WHERE id = ?', [match.player2_id]);
    }

    // Process Bot Delayed Move if scheduled time has arrived (4-5s delay)
    if (match.status === 'ACTIVE' && match.is_bot_match && state.botActionScheduledAt) {
      if (Date.now() >= state.botActionScheduledAt) {
        state.botActionScheduledAt = null;
        await executeDelayedBotMove(match, state);
        const updatedMatch = await dbGet('SELECT * FROM multiplayer_matches WHERE id = ?', [matchId]);
        return res.json(sanitizeMatchResponse(updatedMatch, userId, p1User, p2User));
      }
    }

    // Check Turn Deadline Expiry (Timeout Forfeit)
    if (match.status === 'ACTIVE' && match.turn_deadline) {
      const deadline = new Date(match.turn_deadline).getTime();
      if (Date.now() > deadline) {
        await handleTurnTimeout(match, state);
        const updatedMatch = await dbGet('SELECT * FROM multiplayer_matches WHERE id = ?', [matchId]);
        return res.json(sanitizeMatchResponse(updatedMatch, userId, p1User, p2User));
      }
    }

    res.json(sanitizeMatchResponse(match, userId, p1User, p2User));
  } catch (err) {
    console.error('[MP Poll State Error]:', err);
    res.status(500).json({ error: 'Error fetching match state.' });
  }
});

// Helper: Execute Bot Move after 4-5s Thinking Delay
async function executeDelayedBotMove(match, state) {
  const config = await dbGet('SELECT turn_timer FROM multiplayer_game_configs WHERE game_id = ?', [match.game_id]);
  const timer = config ? config.turn_timer : 30;

  if (match.game_id === 'tictactoe') {
    const botConfig = await dbGet('SELECT difficulty FROM multiplayer_bots WHERE id = ?', [match.bot_id]);
    const botDiff = botConfig ? botConfig.difficulty : 'HARD';
    const botSymbol = state.p2Symbol;
    const playerSymbol = state.p1Symbol;

    const botMove = botEngine.getBestTttMove(state.board, botSymbol, playerSymbol, botDiff);
    if (botMove !== null) {
      state.board[botMove] = botSymbol;

      if (botEngine.evaluateTttWin(state.board, botSymbol)) {
        await completeMatch(match, -match.bot_id, 'Bot Win', state);
        return;
      }

      if (state.board.every(c => c !== null)) {
        state.board = Array(9).fill(null);
        state.roundNumber = (state.roundNumber || 1) + 1;
      }
    }

    const newDeadline = getDeadlineIso(timer);
    await dbRun(
      `UPDATE multiplayer_matches 
       SET game_state = ?, turn_user_id = ?, turn_deadline = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [JSON.stringify(state), match.player1_id, newDeadline, match.id]
    );
  } else if (match.game_id === 'rps' || match.game_id === 'head_tail') {
    state.p2Choice = match.game_id === 'rps' ? botEngine.getRpsMove() : botEngine.getBotCoinGuess();

    if (match.game_id === 'rps') {
      evaluateRpsRound(match, state);
    } else {
      evaluateHeadTailRound(match, state);
    }

    if (match.p1_score >= 2) {
      await completeMatch(match, match.player1_id, 'Best of 3 Win', state);
      return;
    } else if (match.p2_score >= 2) {
      await completeMatch(match, -match.bot_id, 'Best of 3 Win', state);
      return;
    }

    const newDeadline = getDeadlineIso(timer);
    await dbRun(
      `UPDATE multiplayer_matches 
       SET p1_score = ?, p2_score = ?, current_round = ?, game_state = ?, turn_deadline = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [match.p1_score, match.p2_score, state.round, JSON.stringify(state), newDeadline, match.id]
    );
  }
}

function sanitizeMatchResponse(match, viewerUserId, p1User, p2User) {
  const isP1 = match.player1_id === viewerUserId;
  const state = JSON.parse(match.game_state || '{}');
  const sanitized = { ...state };

  // For RPS / Coin Flip: Conceal opponent choice until round results are published
  if (match.game_id === 'rps' || match.game_id === 'head_tail') {
    if (!state.lastRoundResult && !(sanitized.p1Choice && sanitized.p2Choice)) {
      if (isP1) {
        sanitized.p2Choice = sanitized.p2Choice ? 'LOCKED' : null;
      } else {
        sanitized.p1Choice = sanitized.p1Choice ? 'LOCKED' : null;
      }
    }
  }

  const remainingSeconds = getRemainingSeconds(match.turn_deadline);

  return {
    matchId: match.id,
    gameId: match.game_id,
    status: match.status,
    currentRound: match.current_round,
    p1Score: match.p1_score,
    p2Score: match.p2_score,
    winnerId: match.winner_id,
    entryFee: match.entry_fee,
    winnerReward: match.winner_reward,
    turnUserId: match.turn_user_id,
    turnDeadline: match.turn_deadline,
    remainingSeconds,
    isBotThinking: !!state.botActionScheduledAt,
    gameState: sanitized,
    player1: {
      id: p1User.id,
      username: p1User.username,
      avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=' + p1User.username
    },
    player2: p2User ? {
      id: p2User.id,
      username: p2User.username,
      avatar: p2User.avatar_url || ('https://api.dicebear.com/7.x/bottts/png?seed=' + p2User.username),
      isBot: false // Cleaned for realistic UI presentation
    } : null
  };
}

// -------------------------------------------------------------
// 5. SUBMIT PLAYER ACTION (Move / Selection)
// -------------------------------------------------------------
router.post('/match/:matchId/action', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { matchId } = req.params;
  const payload = req.body;

  try {
    const match = await dbGet('SELECT * FROM multiplayer_matches WHERE id = ?', [matchId]);
    if (!match || match.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Match is not active.' });
    }

    const isP1 = match.player1_id === userId;
    const isP2 = match.player2_id === userId;
    if (!isP1 && !isP2) return res.status(403).json({ error: 'Unauthorized.' });

    let state = JSON.parse(match.game_state || '{}');
    const config = await dbGet('SELECT turn_timer FROM multiplayer_game_configs WHERE game_id = ?', [match.game_id]);
    const timer = config ? config.turn_timer : 30;

    // --- TIC TAC TOE ---
    if (match.game_id === 'tictactoe') {
      const { cellIndex } = payload;
      if (cellIndex === undefined || cellIndex < 0 || cellIndex > 8) {
        return res.status(400).json({ error: 'Invalid cell index.' });
      }
      if (match.turn_user_id !== userId) {
        return res.status(400).json({ error: 'Not your turn.' });
      }
      if (state.board[cellIndex] !== null) {
        return res.status(400).json({ error: 'Cell is already occupied.' });
      }

      const playerSymbol = isP1 ? state.p1Symbol : state.p2Symbol;
      state.board[cellIndex] = playerSymbol;

      if (botEngine.evaluateTttWin(state.board, playerSymbol)) {
        await completeMatch(match, userId, 'Player Win', state);
        return res.json({ success: true, message: 'Game won!' });
      }

      const isFull = state.board.every(c => c !== null);
      if (isFull) {
        state.board = Array(9).fill(null);
        state.roundNumber = (state.roundNumber || 1) + 1;
        state.p1Symbol = state.p1Symbol === 'X' ? 'O' : 'X';
        state.p2Symbol = state.p2Symbol === 'X' ? 'O' : 'X';
      }

      const nextTurnUserId = isP1 ? (match.is_bot_match ? -match.bot_id : match.player2_id) : match.player1_id;

      // Natural Bot Delay: Schedule bot move in 4 to 5 seconds
      if (match.is_bot_match && nextTurnUserId === -match.bot_id) {
        const randomDelay = Math.floor(Math.random() * 1000) + 4000; // 4000ms - 5000ms
        state.botActionScheduledAt = Date.now() + randomDelay;
      }

      const newDeadline = getDeadlineIso(timer);
      await dbRun(
        `UPDATE multiplayer_matches 
         SET game_state = ?, turn_user_id = ?, turn_deadline = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [JSON.stringify(state), nextTurnUserId, newDeadline, matchId]
      );

      return res.json({ success: true });
    }

    // --- ROCK PAPER SCISSORS & HEAD OR TAILS ---
    if (match.game_id === 'rps' || match.game_id === 'head_tail') {
      const { choice } = payload;
      if (!choice) return res.status(400).json({ error: 'Choice required.' });

      if (isP1) state.p1Choice = choice;
      if (isP2) state.p2Choice = choice;

      // Natural Bot Delay: Schedule bot choice in 4 to 5 seconds
      if (match.is_bot_match && !state.p2Choice) {
        const randomDelay = Math.floor(Math.random() * 1000) + 4000; // 4000ms - 5000ms
        state.botActionScheduledAt = Date.now() + randomDelay;
        const newDeadline = getDeadlineIso(timer);

        await dbRun(
          `UPDATE multiplayer_matches SET game_state = ?, turn_deadline = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [JSON.stringify(state), newDeadline, matchId]
        );
        return res.json({ success: true, message: 'Choice locked. Waiting for opponent...' });
      }

      // If both real players submitted
      if (state.p1Choice && state.p2Choice) {
        if (match.game_id === 'rps') evaluateRpsRound(match, state);
        else evaluateHeadTailRound(match, state);

        if (match.p1_score >= 2) {
          await completeMatch(match, match.player1_id, 'Best of 3 Win', state);
          return res.json({ success: true, message: 'Match completed!' });
        } else if (match.p2_score >= 2) {
          await completeMatch(match, match.player2_id, 'Best of 3 Win', state);
          return res.json({ success: true, message: 'Match completed!' });
        }
      }

      const newDeadline = getDeadlineIso(timer);
      await dbRun(
        `UPDATE multiplayer_matches 
         SET p1_score = ?, p2_score = ?, current_round = ?, game_state = ?, turn_deadline = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [match.p1_score, match.p2_score, state.round || 1, JSON.stringify(state), newDeadline, matchId]
      );

      return res.json({ success: true });
    }
  } catch (err) {
    console.error('[MP Action Error]:', err);
    res.status(500).json({ error: 'Failed to process move.' });
  }
});

function evaluateRpsRound(match, state) {
  const c1 = state.p1Choice;
  const c2 = state.p2Choice;
  let roundWinner = 'DRAW';

  if (c1 === c2) {
    roundWinner = 'DRAW';
  } else if (
    (c1 === 'ROCK' && c2 === 'SCISSORS') ||
    (c1 === 'SCISSORS' && c2 === 'PAPER') ||
    (c1 === 'PAPER' && c2 === 'ROCK')
  ) {
    roundWinner = 'P1';
    match.p1_score += 1;
  } else {
    roundWinner = 'P2';
    match.p2_score += 1;
  }

  state.lastRoundResult = {
    round: state.round,
    p1Choice: c1,
    p2Choice: c2,
    winner: roundWinner
  };
  state.history.push({ ...state.lastRoundResult });
  state.round += 1;
  state.p1Choice = null;
  state.p2Choice = null;
}

function evaluateHeadTailRound(match, state) {
  const fairFlip = botEngine.getFairCoinFlip();
  state.coinResult = fairFlip;

  let roundWinner = 'DRAW';
  const p1Match = state.p1Choice === fairFlip;
  const p2Match = state.p2Choice === fairFlip;

  if (p1Match && !p2Match) {
    roundWinner = 'P1';
    match.p1_score += 1;
  } else if (!p1Match && p2Match) {
    roundWinner = 'P2';
    match.p2_score += 1;
  }

  state.lastRoundResult = {
    round: state.round,
    p1Choice: state.p1Choice,
    p2Choice: state.p2Choice,
    coinResult: fairFlip,
    winner: roundWinner
  };
  state.history.push({ ...state.lastRoundResult });
  state.round += 1;
  state.p1Choice = null;
  state.p2Choice = null;
}

async function handleTurnTimeout(match, state) {
  if (match.turn_user_id === match.player1_id) {
    const winner = match.is_bot_match ? -match.bot_id : match.player2_id;
    await completeMatch(match, winner, 'P1 Timeout', state);
  } else {
    await completeMatch(match, match.player1_id, 'P2 Timeout', state);
  }
}

// Complete Match and Settle (Persists final game_state and round results)
async function completeMatch(match, winnerId, reason, state) {
  const isHumanWinner = winnerId > 0;
  const reward = match.winner_reward || 200;
  const finalStateJson = state ? JSON.stringify(state) : match.game_state;

  await dbRun('BEGIN TRANSACTION');
  await dbRun(
    `UPDATE multiplayer_matches 
     SET status = 'COMPLETED', winner_id = ?, p1_score = ?, p2_score = ?, game_state = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
     WHERE id = ?`,
    [winnerId, match.p1_score, match.p2_score, finalStateJson, match.id]
  );

  if (isHumanWinner) {
    await dbRun('UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?', [reward, reward, winnerId]);
    await dbRun(
      `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_WIN', ?, ?)`,
      [winnerId, reward, `MP_WIN_${match.game_id}_${match.id}`]
    );
  }

  if (match.is_bot_match) {
    const cd = await dbGet('SELECT consecutive_bot_matches FROM multiplayer_cooldowns WHERE user_id = ?', [match.player1_id]);
    const currentCount = (cd ? cd.consecutive_bot_matches : 0) + 1;
    let cooldownUntil = null;
    if (currentCount >= 3) {
      cooldownUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    }
    await dbRun(
      `INSERT INTO multiplayer_cooldowns (user_id, consecutive_bot_matches, cooldown_until, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET 
         consecutive_bot_matches = ?, 
         cooldown_until = ?, 
         updated_at = CURRENT_TIMESTAMP`,
      [match.player1_id, currentCount, cooldownUntil, currentCount, cooldownUntil]
    );
  } else {
    // Human-to-human match resets both players' consecutive bot counters
    await dbRun(`UPDATE multiplayer_cooldowns SET consecutive_bot_matches = 0, cooldown_until = NULL WHERE user_id IN (?, ?)`, [match.player1_id, match.player2_id]);
  }

  await dbRun('COMMIT');
}

// -------------------------------------------------------------
// 6. MULTIPLAYER MATCH HISTORY
// -------------------------------------------------------------
router.get('/history', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { gameId } = req.query;

  try {
    let sql = `
      SELECT m.*, 
        u1.username AS p1_name,
        COALESCE(u2.username, b.username) AS p2_name,
        COALESCE(b.avatar_url, 'https://api.dicebear.com/7.x/bottts/png?seed=' || u2.username) AS p2_avatar
      FROM multiplayer_matches m
      LEFT JOIN users u1 ON m.player1_id = u1.id
      LEFT JOIN users u2 ON m.player2_id = u2.id
      LEFT JOIN multiplayer_bots b ON m.bot_id = b.id
      WHERE (m.player1_id = ? OR m.player2_id = ?)
    `;
    const params = [userId, userId];
    if (gameId) {
      sql += ' AND m.game_id = ?';
      params.push(gameId);
    }
    sql += ' ORDER BY m.created_at DESC LIMIT 50';
    const rows = await dbAll(sql, params);

    const history = rows.map(r => {
      const isP1 = r.player1_id === userId;
      let outcome = 'DRAW';
      if (r.winner_id === userId) outcome = 'WIN';
      else if (r.winner_id) outcome = 'LOSS';

      const cleanOpponentName = (isP1 ? r.p2_name : r.p1_name) || 'Opponent';

      return {
        matchId: r.id,
        gameId: r.game_id,
        opponentName: cleanOpponentName.replace(/\s*\(Bot\)\s*/gi, '').trim(),
        opponentAvatar: isP1 ? r.p2_avatar : 'https://api.dicebear.com/7.x/bottts/png?seed=' + r.p1_name,
        isBot: false,
        entryFee: r.entry_fee,
        reward: outcome === 'WIN' ? r.winner_reward : 0,
        result: outcome,
        createdAt: r.created_at
      };
    });

    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve match history.' });
  }
});

module.exports = router;
