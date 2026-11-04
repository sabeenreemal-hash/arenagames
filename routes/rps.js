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
const BOT_WAIT_TIMEOUT_MS = 3500; // Wait 3.5s for real player before matching bot
const BOT_USER_ID = 999999;

const BOT_NAMES = [
  'ShadowNinja', 'ViperQueen', 'Alex_Pro99', 'CyberSamurai', 'NovaStrike',
  'Elena_92', 'ApexHunter', 'GhostRider_X', 'BlazeFury', 'ZenithPulse',
  'AeroKnight', 'PixelWarrior', 'ThunderHawk', 'EchoGamer', 'TitanX',
  'Vortex_77', 'Krypton', 'CrimsonBlade', 'NeonRider', 'Spectre_01'
];

const CHOICES = ['ROCK', 'PAPER', 'SCISSORS'];

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

// Balanced & Beatable RPS choice calculation (~50/50 fair rate)
function predictCasualRpsMove(lastResult) {
  // 70% of the time play clean, natural random choice
  if (Math.random() < 0.70 || !lastResult) {
    return CHOICES[Math.floor(Math.random() * CHOICES.length)];
  }

  // 30% of the time, slight human intuition variation
  return CHOICES[Math.floor(Math.random() * CHOICES.length)];
}

// Automatically submits bot choice with human delay
function triggerBotRpsChoice(matchId) {
  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match || match.status !== 'IN_PROGRESS') return;

    const isBotPlayerA = String(match.player_a_id) === String(BOT_USER_ID);
    const isBotPlayerB = String(match.player_b_id) === String(BOT_USER_ID);
    if (!isBotPlayerA && !isBotPlayerB) return;

    const botAlreadySubmitted = isBotPlayerA ? (match.player_a_choice !== null) : (match.player_b_choice !== null);
    if (botAlreadySubmitted) return;

    let lastResult = null;
    try { if (match.last_round_result) lastResult = JSON.parse(match.last_round_result); } catch (_) {}

    const botChoice = predictCasualRpsMove(lastResult);
    const delay = Math.floor(Math.random() * 1200) + 1300; // 1.3s - 2.5s delay

    setTimeout(() => {
      db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (reErr, currMatch) => {
        if (reErr || !currMatch || currMatch.status !== 'IN_PROGRESS') return;

        const col = isBotPlayerA ? 'player_a_choice' : 'player_b_choice';
        db.run(`UPDATE rps_matches SET ${col} = ? WHERE id = ?`, [botChoice, matchId], () => {
          db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (finalErr, refreshedMatch) => {
            if (refreshedMatch && refreshedMatch.player_a_choice && refreshedMatch.player_b_choice) {
              resolveRound(refreshedMatch, () => {});
            }
          });
        });
      });
    }, delay);
  });
}

// -----------------------------------------------------------------------------
// 1. GET /api/rps/waiting-players (Always shows 100+ waiting players)
// -----------------------------------------------------------------------------
router.get('/waiting-players', authenticateToken, (req, res) => {
  const now = Date.now();
  rpsQueue = rpsQueue.filter(p => (now - p.joinedAt) < 90000);

  // Fluctuates naturally between 100 and 108 players
  const fakeWaitingCount = 100 + Math.floor((now / 15000) % 9);
  const totalCount = Math.max(rpsQueue.length, fakeWaitingCount);

  const sampleList = BOT_NAMES.slice(0, 10).map((name, i) => ({
    userId: 900000 + i,
    username: name,
    waitingSeconds: (i * 2) + 1
  }));

  res.json({
    success: true,
    count: totalCount,
    players: rpsQueue.length > 0
      ? rpsQueue.map(p => ({
          userId: p.userId,
          username: p.username,
          waitingSeconds: Math.floor((now - p.joinedAt) / 1000)
        })).concat(sampleList)
      : sampleList
  });
});

// -----------------------------------------------------------------------------
// 2. POST /api/rps/join-queue
// -----------------------------------------------------------------------------
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
                      if (insErr) return res.status(500).json({ error: 'Failed to create match' });
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

// -----------------------------------------------------------------------------
// 3. POST /api/rps/cancel-queue
// -----------------------------------------------------------------------------
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
        if (activeMatch) return res.status(400).json({ error: 'Match already started' });
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

// -----------------------------------------------------------------------------
// 4. GET /api/rps/check-queue-status (Auto Bot Matchmaker)
// -----------------------------------------------------------------------------
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

      const qIndex = rpsQueue.findIndex(p => String(p.userId) === String(userId));
      if (qIndex === -1) {
        return res.json({ success: true, matched: false, inQueue: false });
      }

      const playerEntry = rpsQueue[qIndex];
      const waitingMs = Date.now() - playerEntry.joinedAt;

      // Bot Fallback: Matches bot after 3.5s wait
      if (waitingMs >= BOT_WAIT_TIMEOUT_MS) {
        const matchId = `rps_${crypto.randomBytes(8).toString('hex')}`;
        const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];

        db.run(
          `INSERT INTO rps_matches (
            id, player_a_id, player_b_id, player_a_name, player_b_name,
            player_a_score, player_b_score, current_round, status, pot_amount, round_start_time
          ) VALUES (?, ?, ?, ?, ?, 0, 0, 1, 'IN_PROGRESS', 200, CURRENT_TIMESTAMP)`,
          [matchId, playerEntry.userId, BOT_USER_ID, playerEntry.username, botName],
          (insErr) => {
            if (insErr) {
              console.error('[RPS BOT MATCH INSERT ERROR]:', insErr.message);
              return res.status(500).json({ error: 'Failed to create match' });
            }

            // Remove from queue ONLY after successful insertion
            rpsQueue.splice(qIndex, 1);

            triggerBotRpsChoice(matchId);

            return res.json({
              success: true,
              matched: true,
              matchId: matchId,
              opponentName: botName
            });
          }
        );
        return;
      }

      return res.json({ success: true, matched: false, inQueue: true });
    }
  );
});

// -----------------------------------------------------------------------------
// 5. GET /api/rps/match/:matchId
// -----------------------------------------------------------------------------
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

    if (match.status === 'IN_PROGRESS') {
      const isBotInvolved = String(match.player_a_id) === String(BOT_USER_ID) || String(match.player_b_id) === String(BOT_USER_ID);
      if (isBotInvolved) {
        triggerBotRpsChoice(match.id);
      }
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

// -----------------------------------------------------------------------------
// 6. POST /api/rps/submit-choice
// -----------------------------------------------------------------------------
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

          triggerBotRpsChoice(matchId);

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

        triggerBotRpsChoice(matchId);

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

  if (newScoreA >= WINS_TO_MATCH) {
    settleMatchPayout(match.id, match.player_a_id, false, newScoreA, newScoreB, roundResultData, (err) => {
      db.get('SELECT * FROM rps_matches WHERE id = ?', [match.id], callback);
    });
  } else if (newScoreB >= WINS_TO_MATCH) {
    settleMatchPayout(match.id, match.player_b_id, false, newScoreA, newScoreB, roundResultData, (err) => {
      db.get('SELECT * FROM rps_matches WHERE id = ?', [match.id], callback);
    });
  } else {
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

function settleMatchPayout(matchId, winnerId, isDraw, finalScoreA, finalScoreB, finalRoundResult, callback) {
  db.get('SELECT * FROM rps_matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return callback(new Error('Match not found'));
    if (match.status === 'COMPLETED' || match.status === 'DRAW') return callback(null);

    // Case 1: DRAW -> Refund real human players
    if (isDraw) {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        if (String(match.player_a_id) !== String(BOT_USER_ID)) {
          db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, match.player_a_id]);
          db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_REFUND', ?, ?)`, [match.player_a_id, ENTRY_FEE, `RPS_DRAW_${match.id}`]);
        }
        if (String(match.player_b_id) !== String(BOT_USER_ID)) {
          db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [ENTRY_FEE, match.player_b_id]);
          db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_REFUND', ?, ?)`, [match.player_b_id, ENTRY_FEE, `RPS_DRAW_${match.id}`]);
        }

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
      });
      return;
    }

    // Case 2: BOT WINS -> Simply mark match COMPLETED (preserves real player stats)
    if (String(winnerId) === String(BOT_USER_ID)) {
      db.run(
        `UPDATE rps_matches 
         SET status = 'COMPLETED', 
             winner_id = ?, 
             player_a_score = ?, 
             player_b_score = ?, 
             last_round_result = ? 
         WHERE id = ?`,
        [winnerId, finalScoreA, finalScoreB, finalRoundResult, matchId],
        (finErr) => {
          if (finErr) return callback(finErr);
          callback(null);
        }
      );
      return;
    }

    // Case 3: REAL USER WINS -> Credit 200 coins & advance Daily Streak
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
        if (currentStreak > highestStreak) {
          highestStreak = currentStreak;
        }
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
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'RPS_WIN', ?, ?)`,
          [winnerId, WINNER_PRIZE, `RPS_WIN_${match.id}`]
        );

        db.run(
          `UPDATE rps_matches 
           SET status = 'COMPLETED', 
               winner_id = ?, 
               player_a_score = ?, 
               player_b_score = ?, 
               last_round_result = ? 
           WHERE id = ?`,
          [winnerId, finalScoreA, finalScoreB, finalRoundResult, matchId],
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
