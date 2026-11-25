// backend/routes/multiplayerRoutes.js
const express = require('express');
const router = express.Router();
const db = require('../database');
const crypto = require('crypto');
const authenticateToken = require('../middleware/auth');
const botEngine = require('../services/multiplayerBotEngine');

// Database Promise Helpers
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) return reject(err);
    resolve(this);
  });
});

function parseSqliteUtc(dateStr) {
  if (!dateStr) return Date.now();
  let s = String(dateStr).trim();
  if (!s.includes('T')) s = s.replace(' ', 'T');
  if (!s.endsWith('Z')) s += 'Z';
  const parsed = new Date(s).getTime();
  return isNaN(parsed) ? Date.now() : parsed;
}

function getQueueElapsedSeconds(dateStr) {
  const createdMs = parseSqliteUtc(dateStr);
  return Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
}

function getDeadlineIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function getRemainingSeconds(deadlineIso) {
  if (!deadlineIso) return 0;
  const deadline = parseSqliteUtc(deadlineIso);
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

// Rock Paper Scissors Winner Calculator
function calculateRpsWinner(choice1, choice2) {
  if (!choice1 || !choice2) return 'DRAW';
  const c1 = choice1.trim().toUpperCase();
  const c2 = choice2.trim().toUpperCase();

  if (c1 === c2) return 'DRAW';

  if (
    (c1 === 'ROCK' && c2 === 'SCISSORS') ||
    (c1 === 'SCISSORS' && c2 === 'PAPER') ||
    (c1 === 'PAPER' && c2 === 'ROCK')
  ) {
    return 'P1';
  }

  if (
    (c2 === 'ROCK' && c1 === 'SCISSORS') ||
    (c2 === 'SCISSORS' && c1 === 'PAPER') ||
    (c2 === 'PAPER' && c1 === 'ROCK')
  ) {
    return 'P2';
  }

  return 'DRAW';
}

function initGameState(gameId, p1Id, p2Id) {
  if (gameId === 'tictactoe') {
    return {
      board: Array(9).fill(null),
      p1Symbol: 'X',
      p2Symbol: 'O',
      roundNumber: 1,
      botActionScheduledAt: null,
      history: []
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
// 1. JOIN MATCHMAKING QUEUE
// -------------------------------------------------------------
router.post('/matchmake/join', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { gameId } = req.body;

  if (!['tictactoe', 'rps', 'head_tail'].includes(gameId)) {
    return res.status(400).json({ error: 'Invalid game selected.' });
  }

  try {
    const userMatches = await dbAll(
      `SELECT id, turn_deadline, created_at, updated_at FROM multiplayer_matches 
       WHERE (player1_id = ? OR player2_id = ?) AND status = 'ACTIVE'`,
      [userId, userId]
    );

    for (const m of userMatches) {
      const deadline = m.turn_deadline ? parseSqliteUtc(m.turn_deadline) : 0;
      const lastActive = parseSqliteUtc(m.updated_at || m.created_at);
      const isDead = (deadline > 0 && Date.now() > deadline + 10000) || (Date.now() - lastActive > 60000);

      if (isDead) {
        await dbRun(
          `UPDATE multiplayer_matches SET status = 'CANCELLED', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [m.id]
        );
      }
    }

    await dbRun(
      `UPDATE multiplayer_queue SET status = 'CANCELLED' WHERE user_id = ? AND status = 'WAITING'`,
      [userId]
    );

    const trulyActive = await dbGet(
      `SELECT id, turn_deadline FROM multiplayer_matches 
       WHERE (player1_id = ? OR player2_id = ?) AND status = 'ACTIVE' LIMIT 1`,
      [userId, userId]
    );

    if (trulyActive) {
      const remainingSec = getRemainingSeconds(trulyActive.turn_deadline);
      if (remainingSec <= 0) {
        await dbRun(`UPDATE multiplayer_matches SET status = 'CANCELLED' WHERE id = ?`, [trulyActive.id]);
      } else {
        return res.status(400).json({
          error: 'You have an active match in progress.',
          matchId: trulyActive.id
        });
      }
    }

    const config = await dbGet('SELECT * FROM multiplayer_game_configs WHERE game_id = ? AND is_enabled = 1', [gameId]);
    if (!config) return res.status(404).json({ error: 'Game is currently offline.' });
    const entryFee = config.entry_fee || 100;

    const queueId = 'queue_' + crypto.randomUUID();

    await dbRun('BEGIN IMMEDIATE');
    const updateBalance = await dbRun(
      'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?',
      [entryFee, userId, entryFee]
    );

    if (updateBalance.changes === 0) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: `Insufficient balance. ${entryFee} coins required to enter.` });
    }

    await dbRun(
      `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_ENTRY', ?, ?)`,
      [userId, -entryFee, `MP_ENTRY_${gameId}_${queueId}`]
    );

    await dbRun(
      `INSERT INTO multiplayer_queue (id, user_id, game_id, entry_fee, status) VALUES (?, ?, ?, ?, 'WAITING')`,
      [queueId, userId, gameId, entryFee]
    );
    await dbRun('COMMIT');

    return res.json({
      success: true,
      queueId,
      estimatedWaitSeconds: 30,
      botEligibleAfterSeconds: 20
    });
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    console.error('[MP Join Queue Error]:', err);
    return res.status(500).json({ error: 'Failed to join matchmaking.' });
  }
});

// -------------------------------------------------------------
// 2. POLL MATCHMAKING QUEUE (PVP & 20s Bot Fallback)
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

    const elapsedSeconds = getQueueElapsedSeconds(queueRecord.created_at);

    // 1. Search for Real Opponent (0s - 30s)
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
      const entryFee = Number(queueRecord.entry_fee) || 100;
      const winnerReward = entryFee * 2;

      await dbRun('BEGIN IMMEDIATE');
      const matchP1 = await dbRun(
        `UPDATE multiplayer_queue SET status = 'MATCHED', match_id = ? WHERE id = ? AND status = 'WAITING'`,
        [matchId, queueId]
      );
      const matchP2 = await dbRun(
        `UPDATE multiplayer_queue SET status = 'MATCHED', match_id = ? WHERE id = ? AND status = 'WAITING'`,
        [matchId, otherPlayer.id]
      );

      if (matchP1.changes > 0 && matchP2.changes > 0) {
        await dbRun(
          `INSERT INTO multiplayer_matches 
            (id, game_id, player1_id, player2_id, is_bot_match, entry_fee, winner_reward, status, turn_user_id, turn_deadline, game_state) 
           VALUES (?, ?, ?, ?, 0, ?, ?, 'ACTIVE', ?, ?, ?)`,
          [matchId, queueRecord.game_id, userId, otherPlayer.user_id, entryFee, winnerReward, userId, deadline, JSON.stringify(initialGameState)]
        );

        await dbRun(
          `INSERT INTO multiplayer_cooldowns (user_id, consecutive_bot_matches, cooldown_until) VALUES (?, 0, NULL)
           ON CONFLICT(user_id) DO UPDATE SET consecutive_bot_matches = 0, cooldown_until = NULL`,
          [userId]
        );
        await dbRun(
          `INSERT INTO multiplayer_cooldowns (user_id, consecutive_bot_matches, cooldown_until) VALUES (?, 0, NULL)
           ON CONFLICT(user_id) DO UPDATE SET consecutive_bot_matches = 0, cooldown_until = NULL`,
          [otherPlayer.user_id]
        );
        await dbRun('COMMIT');

        return res.json({ status: 'MATCHED', matchId });
      } else {
        await dbRun('ROLLBACK');
      }
    }

    // 2. Bot Matching at >= 20 Seconds
    if (elapsedSeconds >= 20 && elapsedSeconds < 30) {
      const cdRow = await dbGet('SELECT * FROM multiplayer_cooldowns WHERE user_id = ?', [userId]);
      let isBotRestricted = false;
      let remainingCooldownSec = 600;

      if (cdRow) {
        if (cdRow.cooldown_until) {
          const cdEnd = parseSqliteUtc(cdRow.cooldown_until);
          if (Date.now() < cdEnd) {
            isBotRestricted = true;
            remainingCooldownSec = Math.ceil((cdEnd - Date.now()) / 1000);
          } else {
            await dbRun('UPDATE multiplayer_cooldowns SET consecutive_bot_matches = 0, cooldown_until = NULL WHERE user_id = ?', [userId]);
          }
        } else if (cdRow.consecutive_bot_matches >= 3) {
          isBotRestricted = true;
        }
      }

      if (isBotRestricted) {
        const cooldownDeadline = new Date(Date.now() + remainingCooldownSec * 1000).toISOString();

        await dbRun('BEGIN IMMEDIATE');
        const cancelQ = await dbRun(`UPDATE multiplayer_queue SET status = 'CANCELLED' WHERE id = ? AND status = 'WAITING'`, [queueId]);
        if (cancelQ.changes > 0) {
          await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [queueRecord.entry_fee, userId]);
          await dbRun(
            `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_REFUND', ?, ?)`,
            [userId, queueRecord.entry_fee, `MP_BOT_LIMIT_REFUND_${queueId}`]
          );
          await dbRun(
            `INSERT INTO multiplayer_cooldowns (user_id, consecutive_bot_matches, cooldown_until, updated_at)
             VALUES (?, 3, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET consecutive_bot_matches = 3, cooldown_until = COALESCE(cooldown_until, ?), updated_at = CURRENT_TIMESTAMP`,
            [userId, cooldownDeadline, cooldownDeadline]
          );
        }
        await dbRun('COMMIT');

        return res.json({
          status: 'BOT_LIMIT_REACHED',
          message: 'Players are currently unavailable. Please try again after 10 minutes.',
          cooldownRemainingSeconds: remainingCooldownSec
        });
      }

      let bot = await dbGet('SELECT * FROM multiplayer_bots WHERE is_active = 1 ORDER BY RANDOM() LIMIT 1');
      if (!bot) {
        bot = {
          id: 1,
          username: 'ShadowMaster',
          avatar_url: 'https://api.dicebear.com/7.x/bottts/png?seed=ShadowMaster',
          difficulty: 'HARD'
        };
        await dbRun(
          `INSERT OR IGNORE INTO multiplayer_bots (id, username, avatar_url, difficulty, is_active)
           VALUES (1, 'ShadowMaster', 'https://api.dicebear.com/7.x/bottts/png?seed=ShadowMaster', 'HARD', 1)`
        ).catch(() => {});
      }

      const matchId = 'match_' + crypto.randomUUID();
      const config = await dbGet('SELECT * FROM multiplayer_game_configs WHERE game_id = ?', [queueRecord.game_id]);
      const turnTimer = config ? config.turn_timer : 30;
      const initialGameState = initGameState(queueRecord.game_id, userId, -bot.id);
      const deadline = getDeadlineIso(turnTimer);
      const entryFee = Number(queueRecord.entry_fee) || 100;
      const winnerReward = entryFee * 2;

      await dbRun('BEGIN IMMEDIATE');
      const updateQ = await dbRun(
        `UPDATE multiplayer_queue SET status = 'MATCHED', match_id = ? WHERE id = ? AND status = 'WAITING'`,
        [matchId, queueId]
      );

      if (updateQ.changes > 0) {
        await dbRun(
          `INSERT INTO multiplayer_matches 
            (id, game_id, player1_id, player2_id, is_bot_match, bot_id, entry_fee, winner_reward, status, turn_user_id, turn_deadline, game_state) 
           VALUES (?, ?, ?, NULL, 1, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
          [matchId, queueRecord.game_id, userId, bot.id, entryFee, winnerReward, userId, deadline, JSON.stringify(initialGameState)]
        );
        await dbRun('COMMIT');

        return res.json({ status: 'MATCHED', matchId });
      } else {
        await dbRun('ROLLBACK');
      }
    }

    // 3. Matchmaking Timeout at 30 seconds
    if (elapsedSeconds >= 30) {
      await dbRun('BEGIN IMMEDIATE');
      const cancelQ = await dbRun(`UPDATE multiplayer_queue SET status = 'TIMEOUT' WHERE id = ? AND status = 'WAITING'`, [queueId]);
      if (cancelQ.changes > 0) {
        await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [queueRecord.entry_fee, userId]);
        await dbRun(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_REFUND', ?, ?)`,
          [userId, queueRecord.entry_fee, `MP_TIMEOUT_REFUND_${queueId}`]
        );
      }
      await dbRun('COMMIT');
      return res.json({ status: 'TIMEOUT', message: 'No opponents found. 100 coins refunded.' });
    }

    return res.json({
      status: 'WAITING',
      elapsedSeconds,
      remainingSearchTime: Math.max(0, 30 - elapsedSeconds)
    });
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    console.error('[MP Poll Error]:', err);
    return res.status(500).json({ error: 'Error polling matchmaking.' });
  }
});

// -------------------------------------------------------------
// 3. CANCEL QUEUE & REFUND
// -------------------------------------------------------------
router.post('/matchmake/cancel', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { queueId } = req.body;

  try {
    await dbRun('BEGIN IMMEDIATE');
    const queueRecord = await dbGet("SELECT * FROM multiplayer_queue WHERE id = ? AND user_id = ? AND status = 'WAITING'", [queueId, userId]);
    if (!queueRecord) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Queue cannot be cancelled or is already matched.' });
    }

    await dbRun(`UPDATE multiplayer_queue SET status = 'CANCELLED' WHERE id = ?`, [queueId]);
    await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [queueRecord.entry_fee, userId]);
    await dbRun(
      `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_REFUND', ?, ?)`,
      [userId, queueRecord.entry_fee, `MP_USER_CANCEL_${queueId}`]
    );
    await dbRun('COMMIT');

    return res.json({ success: true, message: 'Matchmaking cancelled. Coins refunded.' });
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: 'Failed to cancel queue.' });
  }
});

// -------------------------------------------------------------
// 4. POLL MATCH STATE
// -------------------------------------------------------------
router.get('/match/:matchId/state', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { matchId } = req.params;

  try {
    const match = await dbGet('SELECT * FROM multiplayer_matches WHERE id = ?', [matchId]);
    if (!match) return res.status(404).json({ error: 'Match not found.' });

    const isPlayer1 = Number(match.player1_id) === Number(userId);
    const isPlayer2 = Number(match.player2_id) === Number(userId);
    if (!isPlayer1 && !isPlayer2) {
      return res.status(403).json({ error: 'Unauthorized match access.' });
    }

    let state = JSON.parse(match.game_state || '{}');

    // Fetch Profiles
    const p1User = await dbGet('SELECT id, username, balance FROM users WHERE id = ?', [match.player1_id]);
    let p2User = null;
    if (match.is_bot_match) {
      const bot = await dbGet('SELECT id, username, avatar_url FROM multiplayer_bots WHERE id = ?', [match.bot_id]);
      p2User = {
        id: bot ? -bot.id : -1,
        username: (bot?.username || 'ShadowMaster').replace(/\s*\(Bot\)\s*/gi, '').trim(),
        avatar_url: bot?.avatar_url || 'https://api.dicebear.com/7.x/bottts/png?seed=ShadowMaster',
        balance: 0
      };
    } else if (match.player2_id) {
      p2User = await dbGet('SELECT id, username, balance FROM users WHERE id = ?', [match.player2_id]);
    }

    // Process Bot Turn if delay arrived
    if (match.status === 'ACTIVE' && match.is_bot_match && state.botActionScheduledAt) {
      if (Date.now() >= state.botActionScheduledAt) {
        state.botActionScheduledAt = null;
        await executeDelayedBotMove(match, state);
        const updatedMatch = await dbGet('SELECT * FROM multiplayer_matches WHERE id = ?', [matchId]);
        const freshUser = await dbGet('SELECT balance FROM users WHERE id = ?', [userId]);
        return res.json(buildSanitizedResponse(updatedMatch, userId, p1User, p2User, freshUser?.balance));
      }
    }

    // Turn Deadline Expiry
    if (match.status === 'ACTIVE' && match.turn_deadline) {
      const deadline = parseSqliteUtc(match.turn_deadline);
      if (Date.now() > deadline) {
        await handleTurnTimeout(match, state);
        const updatedMatch = await dbGet('SELECT * FROM multiplayer_matches WHERE id = ?', [matchId]);
        const freshUser = await dbGet('SELECT balance FROM users WHERE id = ?', [userId]);
        return res.json(buildSanitizedResponse(updatedMatch, userId, p1User, p2User, freshUser?.balance));
      }
    }

    const freshUser = await dbGet('SELECT balance FROM users WHERE id = ?', [userId]);
    return res.json(buildSanitizedResponse(match, userId, p1User, p2User, freshUser?.balance));
  } catch (err) {
    console.error('[MP Poll State Error]:', err);
    return res.status(500).json({ error: 'Error fetching match state.' });
  }
});

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

    const isP1 = Number(match.player1_id) === Number(userId);
    const isP2 = Number(match.player2_id) === Number(userId);
    if (!isP1 && !isP2) return res.status(403).json({ error: 'Unauthorized.' });

    let state = JSON.parse(match.game_state || '{}');
    const config = await dbGet('SELECT turn_timer FROM multiplayer_game_configs WHERE game_id = ?', [match.game_id]);
    const timer = config ? config.turn_timer : 30;

    // --- TIC TAC TOE ENGINE ---
    if (match.game_id === 'tictactoe') {
      const { cellIndex } = payload;
      if (cellIndex === undefined || cellIndex < 0 || cellIndex > 8) {
        return res.status(400).json({ error: 'Invalid cell index.' });
      }

      if (Number(match.turn_user_id) !== Number(userId)) {
        return res.status(400).json({ error: 'Not your turn. Please wait for opponent.' });
      }

      if (state.board[cellIndex] !== null) {
        return res.status(400).json({ error: 'Cell is already occupied.' });
      }

      const playerSymbol = isP1 ? state.p1Symbol : state.p2Symbol;
      state.board[cellIndex] = playerSymbol;

      // Check Win: Assign 1 point so final score reflects 1 - 0 instead of 0 - 0
      if (botEngine.evaluateTttWin(state.board, playerSymbol)) {
        if (isP1) {
          match.p1_score = 1;
        } else {
          match.p2_score = 1;
        }
        await completeMatch(match, userId, 'Normal Win', state);
        return res.json({ success: true, message: 'Game won!' });
      }

      // Check Draw -> Restart Round
      const isFull = state.board.every(c => c !== null);
      if (isFull) {
        state.board = Array(9).fill(null);
        state.roundNumber = (state.roundNumber || 1) + 1;
        state.p1Symbol = state.p1Symbol === 'X' ? 'O' : 'X';
        state.p2Symbol = state.p2Symbol === 'X' ? 'O' : 'X';
      }

      // Switch Turn
      const nextTurnUserId = isP1
        ? (match.is_bot_match ? -match.bot_id : match.player2_id)
        : match.player1_id;

      if (match.is_bot_match && Number(nextTurnUserId) === -Number(match.bot_id)) {
        state.botActionScheduledAt = Date.now() + Math.floor(Math.random() * 800) + 2000;
      }

      const newDeadline = getDeadlineIso(timer);
      await dbRun(
        `UPDATE multiplayer_matches 
         SET game_state = ?, turn_user_id = ?, turn_deadline = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ? AND status = 'ACTIVE'`,
        [JSON.stringify(state), nextTurnUserId, newDeadline, matchId]
      );

      return res.json({ success: true, isMyTurn: false });
    }

    // --- ROCK PAPER SCISSORS & HEAD OR TAILS ENGINE ---
    if (match.game_id === 'rps' || match.game_id === 'head_tail') {
      const choice = String(payload.choice || '').trim().toUpperCase();
      if (!choice) return res.status(400).json({ error: 'Selection required.' });

      if (match.game_id === 'rps' && !['ROCK', 'PAPER', 'SCISSORS'].includes(choice)) {
        return res.status(400).json({ error: 'Invalid Rock Paper Scissors move.' });
      }
      if (match.game_id === 'head_tail' && !['HEADS', 'TAILS'].includes(choice)) {
        return res.status(400).json({ error: 'Invalid Coin choice.' });
      }

      if (isP1) state.p1Choice = choice;
      if (isP2) state.p2Choice = choice;

      if (match.is_bot_match && !state.p2Choice) {
        state.botActionScheduledAt = Date.now() + Math.floor(Math.random() * 800) + 2000;
        const newDeadline = getDeadlineIso(timer);
        await dbRun(
          `UPDATE multiplayer_matches SET game_state = ?, turn_deadline = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'ACTIVE'`,
          [JSON.stringify(state), newDeadline, matchId]
        );
        return res.json({ success: true, message: 'Choice locked. Waiting for opponent...' });
      }

      if (state.p1Choice && state.p2Choice) {
        if (match.game_id === 'rps') {
          evaluateRpsRound(match, state);
        } else {
          evaluateHeadTailRound(match, state);
        }

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
         WHERE id = ? AND status = 'ACTIVE'`,
        [match.p1_score, match.p2_score, state.round || 1, JSON.stringify(state), newDeadline, matchId]
      );

      return res.json({ success: true });
    }
  } catch (err) {
    console.error('[MP Action Error]:', err);
    return res.status(500).json({ error: 'Failed to process move.' });
  }
});

// =============================================================
// BOT ENGINE MOVES
// =============================================================
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
        match.p2_score = 1; // Bot awarded 1 point on win
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
       WHERE id = ? AND status = 'ACTIVE'`,
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
       WHERE id = ? AND status = 'ACTIVE'`,
      [match.p1_score, match.p2_score, state.round, JSON.stringify(state), newDeadline, match.id]
    );
  }
}

function evaluateRpsRound(match, state) {
  const c1 = state.p1Choice;
  const c2 = state.p2Choice;
  const outcome = calculateRpsWinner(c1, c2);

  if (outcome === 'P1') {
    match.p1_score += 1;
  } else if (outcome === 'P2') {
    match.p2_score += 1;
  }

  state.lastRoundResult = {
    round: state.round,
    p1Choice: c1,
    p2Choice: c2,
    winner: outcome
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
  if (Number(match.turn_user_id) === Number(match.player1_id)) {
    const winner = match.is_bot_match ? -match.bot_id : match.player2_id;
    match.p2_score = 1;
    await completeMatch(match, winner, 'P1 Timeout Forfeit', state);
  } else {
    match.p1_score = 1;
    await completeMatch(match, match.player1_id, 'P2 Timeout Forfeit', state);
  }
}

// Complete Match and Settle Coins
async function completeMatch(match, winnerId, reason, state) {
  const isHumanWinner = Number(winnerId) > 0;
  const reward = Number(match.winner_reward) || 200;
  const finalStateJson = state ? JSON.stringify(state) : match.game_state;

  try {
    await dbRun('BEGIN IMMEDIATE');

    const updateMatch = await dbRun(
      `UPDATE multiplayer_matches 
       SET status = 'COMPLETED', winner_id = ?, p1_score = ?, p2_score = ?, game_state = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ? AND status = 'ACTIVE'`,
      [winnerId, match.p1_score, match.p2_score, finalStateJson, match.id]
    );

    if (updateMatch.changes === 0) {
      await dbRun('ROLLBACK');
      return;
    }

    if (isHumanWinner) {
      await dbRun(
        'UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?',
        [reward, reward, winnerId]
      );
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
      await dbRun(
        `UPDATE multiplayer_cooldowns SET consecutive_bot_matches = 0, cooldown_until = NULL WHERE user_id IN (?, ?)`,
        [match.player1_id, match.player2_id]
      );
    }

    await dbRun('COMMIT');
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    console.error('[Complete Match Error]:', err);
  }
}

// Builds Sanitized Response with viewer-relative fields
function buildSanitizedResponse(match, viewerUserId, p1User, p2User, userBalance) {
  const isP1 = Number(match.player1_id) === Number(viewerUserId);
  const state = JSON.parse(match.game_state || '{}');
  const sanitizedState = { ...state };

  if (match.game_id === 'rps' || match.game_id === 'head_tail') {
    if (!state.lastRoundResult && !(sanitizedState.p1Choice && sanitizedState.p2Choice)) {
      if (isP1) {
        sanitizedState.p2Choice = sanitizedState.p2Choice ? 'LOCKED' : null;
      } else {
        sanitizedState.p1Choice = sanitizedState.p1Choice ? 'LOCKED' : null;
      }
    }
  }

  // Pre-calculate viewer-relative round result for 100% transparency
  let relativeLastRound = null;
  if (state.lastRoundResult) {
    const lr = state.lastRoundResult;
    const myChoice = isP1 ? lr.p1Choice : lr.p2Choice;
    const oppChoice = isP1 ? lr.p2Choice : lr.p1Choice;
    const didIWin = (lr.winner === 'P1' && isP1) || (lr.winner === 'P2' && !isP1);
    const isDraw = lr.winner === 'DRAW';

    relativeLastRound = {
      round: lr.round,
      myChoice: myChoice,
      opponentChoice: oppChoice,
      winner: lr.winner,
      didIWinRound: didIWin,
      isRoundDraw: isDraw,
      coinResult: lr.coinResult || null
    };
    sanitizedState.lastRoundResult = relativeLastRound;
  }

  const isCompleted = match.status === 'COMPLETED';
  const isWinner = isCompleted && Number(match.winner_id) === Number(viewerUserId);
  const isLoser = isCompleted && match.winner_id !== null && Number(match.winner_id) !== Number(viewerUserId);
  const isDraw = isCompleted && (match.winner_id === null || Number(match.winner_id) === 0);

  const me = isP1 ? p1User : p2User;
  const opponent = isP1 ? p2User : p1User;

  return {
    matchId: match.id,
    gameId: match.game_id,
    status: match.status,
    currentRound: match.current_round,
    entryFee: match.entry_fee,
    winnerReward: match.winner_reward,
    turnDeadline: match.turn_deadline,
    remainingSeconds: getRemainingSeconds(match.turn_deadline),
    isBotThinking: !!state.botActionScheduledAt,

    isPlayer1: isP1,
    isMyTurn: match.status === 'ACTIVE' && Number(match.turn_user_id) === Number(viewerUserId),
    mySymbol: match.game_id === 'tictactoe' ? (isP1 ? state.p1Symbol : state.p2Symbol) : null,
    opponentSymbol: match.game_id === 'tictactoe' ? (isP1 ? state.p2Symbol : state.p1Symbol) : null,
    myScore: isP1 ? match.p1_score : match.p2_score,
    opponentScore: isP1 ? match.p2_score : match.p1_score,
    myBalance: userBalance !== undefined ? userBalance : me?.balance,

    didIWin: isWinner,
    didILose: isLoser,
    isDraw: isDraw,

    lastRoundResult: relativeLastRound,

    me: {
      id: me?.id,
      username: me?.username,
      avatar: me?.avatar_url || ('https://api.dicebear.com/7.x/bottts/png?seed=' + me?.username)
    },
    opponent: opponent ? {
      id: opponent.id,
      username: opponent.username,
      avatar: opponent.avatar_url || ('https://api.dicebear.com/7.x/bottts/png?seed=' + opponent.username)
    } : null,

    gameState: sanitizedState
  };
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
      const isP1 = Number(r.player1_id) === Number(userId);
      let outcome = 'DRAW';
      if (Number(r.winner_id) === Number(userId)) outcome = 'WIN';
      else if (r.winner_id) outcome = 'LOSS';

      const cleanOpponentName = (isP1 ? r.p2_name : r.p1_name) || 'Opponent';

      return {
        matchId: r.id,
        gameId: r.game_id,
        opponentName: cleanOpponentName.replace(/\s*\(Bot\)\s*/gi, '').trim(),
        opponentAvatar: isP1 ? r.p2_avatar : 'https://api.dicebear.com/7.x/bottts/png?seed=' + r.p1_name,
        entryFee: r.entry_fee,
        reward: outcome === 'WIN' ? r.winner_reward : 0,
        result: outcome,
        createdAt: r.created_at
      };
    });

    return res.json({ success: true, history });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve match history.' });
  }
});

setInterval(async () => {
  try {
    await dbRun(`
      UPDATE multiplayer_matches 
      SET status = 'CANCELLED', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
      WHERE status = 'ACTIVE' AND turn_deadline < datetime('now', '-1 minute')
    `);
    await dbRun(`
      UPDATE multiplayer_queue 
      SET status = 'TIMEOUT' 
      WHERE status = 'WAITING' AND created_at < datetime('now', '-2 minutes')
    `);
  } catch (_) {}
}, 60000);

module.exports = router;
