// backend/routes/numberGuess.js
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const {
  dbGet,
  dbAll,
  initNumberGuessDb,
  getConfigMap,
} = require('../ngDatabase');
const engine = require('../services/numberGuessEngine');

// Ensure schema exists when route loads
initNumberGuessDb().catch(() => {});

// Helper: sanitize match payload for players (never leak secret number or others' guesses early)
async function buildPlayerMatchView(matchId, userId) {
  const match = await dbGet(`SELECT * FROM ng_matches WHERE id = ?`, [matchId]);
  if (!match) return null;

  const participants = await dbAll(
    `SELECT * FROM ng_match_participants WHERE match_id = ? ORDER BY joined_at ASC`,
    [matchId]
  );

  const me = participants.find((p) => p.user_id === userId);
  if (!me) return null;

  const isCompleted = match.status === 'COMPLETED';
  const nowMs = Date.now();

  let remainingSeconds = 0;
  if (['WAITING', 'FILLING_BOTS'].includes(match.status) && match.search_deadline_at) {
    remainingSeconds = Math.max(0, Math.ceil((new Date(match.search_deadline_at).getTime() - nowMs) / 1000));
  } else if (match.status === 'STARTING' && match.starting_at) {
    remainingSeconds = Math.max(0, Math.ceil((new Date(match.starting_at).getTime() - nowMs) / 1000));
  } else if (match.status === 'ACTIVE' && match.round_deadline_at) {
    remainingSeconds = Math.max(0, Math.ceil((new Date(match.round_deadline_at).getTime() - nowMs) / 1000));
  }

  const userRow = await dbGet(`SELECT balance FROM users WHERE id = ?`, [userId]);

  const currentCount = participants.length;
  const cfg = await getConfigMap();
  const projectedFeePercent =
    match.fee_percent > 0 ? match.fee_percent : engine.getFeePercent(Math.max(2, currentCount), cfg);
  const projectedPool = match.total_pool > 0 ? match.total_pool : match.entry_fee * currentCount;
  const projectedPrize =
    match.prize_pool_coins > 0
      ? match.prize_pool_coins
      : projectedPool - Math.floor((projectedPool * projectedFeePercent) / 100);

  return {
    matchId: match.id,
    roomCode: match.room_code,
    status: match.status,
    entryFee: match.entry_fee,
    minPlayers: match.min_players,
    maxPlayers: match.max_players,
    playerCount: currentCount,
    feePercent: projectedFeePercent,
    winnerSharePercent: 100 - projectedFeePercent,
    totalPool: projectedPool,
    prizePoolCoins: projectedPrize,
    remainingSeconds,
    secretNumber: isCompleted ? match.secret_number : null,
    cancelReason: match.cancel_reason || null,
    myBalance: userRow?.balance ?? 0,
    myParticipant: {
      hasSubmitted: me.guess !== null,
      guess: me.guess,
      guessSubmittedAt: me.guess_submitted_at,
      diff: isCompleted ? me.diff : null,
      isWinner: isCompleted ? Boolean(me.is_winner) : false,
      payoutCoins: isCompleted ? me.payout_coins : 0,
      refunded: Boolean(me.refunded),
    },
    participants: participants.map((p) => ({
      id: p.id,
      username: p.username,
      avatar: p.avatar,
      isBot: p.participant_type === 'BOT',
      isMe: p.user_id === userId,
      hasSubmitted: p.guess !== null,
      guess: isCompleted ? p.guess : null,
      diff: isCompleted ? p.diff : null,
      isWinner: isCompleted ? Boolean(p.is_winner) : false,
      payoutCoins: isCompleted ? p.payout_coins : 0,
    })),
    createdAt: match.created_at,
    startedAt: match.started_at,
    endedAt: match.ended_at,
  };
}

// 1. GET /api/number-guess/config
router.get('/config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const cfg = await getConfigMap();
    const user = await dbGet(`SELECT balance, is_banned FROM users WHERE id = ?`, [userId]);
    const estimatedWaitSec = await engine.getEstimatedWaitSeconds(cfg);

    const activeMatchRow = await dbGet(
      `SELECT m.id FROM ng_match_participants p
       JOIN ng_matches m ON p.match_id = m.id
       WHERE p.user_id = ? AND m.is_sandbox = 0
         AND m.status IN ('WAITING','FILLING_BOTS','STARTING','ACTIVE')
       ORDER BY m.created_at DESC LIMIT 1`,
      [userId]
    );

    const feeTable = Object.entries(cfg.fee_tiers || {}).map(([players, feePercent]) => ({
      players: Number(players),
      feePercent: Number(feePercent),
      winnerSharePercent: 100 - Number(feePercent),
    }));

    res.json({
      success: true,
      gameEnabled: Boolean(cfg.game_enabled),
      entryFees: cfg.entry_fees || [500, 1000, 2000],
      minPlayers: cfg.min_players,
      maxPlayers: cfg.max_players,
      searchTimeoutSec: cfg.search_timeout_sec,
      roundDurationSec: cfg.round_duration_sec,
      botFillingEnabled: Boolean(cfg.bot_filling_enabled),
      allowLeaveBeforeLock: Boolean(cfg.allow_leave_before_lock),
      estimatedWaitSec,
      feeTable,
      balance: user?.balance ?? 0,
      activeMatchId: activeMatchRow?.id || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load game config' });
  }
});

// 2. POST /api/number-guess/matchmaking/join
router.post('/matchmaking/join', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { entryFee } = req.body;
    const matchId = await engine.joinMatchmaking(userId, entryFee);
    const matchView = await buildPlayerMatchView(matchId, userId);

    res.json({
      success: true,
      match: matchView,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to join match' });
  }
});

// 3. POST /api/number-guess/matchmaking/leave
router.post('/matchmaking/leave', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { matchId } = req.body;
    if (!matchId) return res.status(400).json({ error: 'matchId is required' });

    const out = await engine.leaveMatchmaking(userId, matchId);
    const user = await dbGet(`SELECT balance FROM users WHERE id = ?`, [userId]);

    res.json({
      success: true,
      refunded: out.refunded,
      balance: user?.balance ?? 0,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to leave match' });
  }
});

// 4. GET /api/number-guess/matches/:matchId (1s HTTP Polling Endpoint)
router.get('/matches/:matchId', authenticateToken, async (req, res) => {
  try {
    const view = await buildPlayerMatchView(req.params.matchId, req.user.id);
    if (!view) {
      return res.status(404).json({ error: 'Match not found or access denied' });
    }
    res.json({ success: true, match: view });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch match state' });
  }
});

// 5. POST /api/number-guess/matches/:matchId/guess
router.post('/matches/:matchId/guess', authenticateToken, async (req, res) => {
  try {
    const { guess } = req.body;
    await engine.submitGuess(req.user.id, req.params.matchId, guess);
    const view = await buildPlayerMatchView(req.params.matchId, req.user.id);

    res.json({
      success: true,
      match: view,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to submit guess' });
  }
});

// 6. GET /api/number-guess/history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT m.id AS matchId, m.room_code AS roomCode, m.status, m.entry_fee AS entryFee,
              m.secret_number AS secretNumber, m.prize_pool_coins AS prizePoolCoins,
              m.ended_at AS endedAt, m.created_at AS createdAt,
              p.guess, p.diff, p.is_winner AS isWinner, p.payout_coins AS payoutCoins, p.refunded
       FROM ng_match_participants p
       JOIN ng_matches m ON p.match_id = m.id
       WHERE p.user_id = ? AND m.is_sandbox = 0
         AND m.status IN ('COMPLETED','CANCELLED','REFUNDED')
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ success: true, history: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load match history' });
  }
});

module.exports = router;
