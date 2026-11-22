// backend/services/numberGuessEngine.js
const crypto = require('crypto');
const {
  dbGet,
  dbAll,
  runInTransaction,
  initNumberGuessDb,
  getConfigMap,
  generateRoomCode,
} = require('../ngDatabase');

const DEFAULT_FEE_TIERS = {
  2: 10,
  3: 20,
  4: 22,
  5: 25,
  6: 28,
  7: 30,
  8: 35,
  9: 38,
  10: 40,
};

function getFeePercent(participantCount, cfg) {
  const tiers = cfg?.fee_tiers || DEFAULT_FEE_TIERS;
  const key = String(Math.max(2, Math.min(10, participantCount)));
  const fee = Number(tiers[key] ?? DEFAULT_FEE_TIERS[key] ?? 10);
  return Math.max(0, Math.min(90, fee));
}

function generateBotGuess(strategy) {
  switch (String(strategy || 'RANDOM').toUpperCase()) {
    case 'LOW':
      return crypto.randomInt(1, 36); // 1 - 35
    case 'HIGH':
      return crypto.randomInt(66, 101); // 66 - 100
    case 'MIDDLE':
      return crypto.randomInt(34, 68); // 34 - 67
    case 'RANDOM':
    default:
      return crypto.randomInt(1, 101); // 1 - 100
  }
}

async function getEstimatedWaitSeconds(cfg) {
  try {
    const rows = await dbAll(
      `SELECT created_at, started_at FROM ng_matches
       WHERE is_sandbox = 0 AND started_at IS NOT NULL
       ORDER BY created_at DESC LIMIT 30`
    );
    if (rows.length > 0) {
      let sumSec = 0;
      let valid = 0;
      for (const r of rows) {
        const diff = (new Date(r.started_at).getTime() - new Date(r.created_at).getTime()) / 1000;
        if (diff >= 0 && diff <= 300) {
          sumSec += diff;
          valid++;
        }
      }
      if (valid > 0) {
        return Math.max(2, Math.round(sumSec / valid));
      }
    }
  } catch (_) {}
  return cfg.bot_filling_enabled ? Number(cfg.bot_fill_delay_sec || 10) : Number(cfg.search_timeout_sec || 30);
}

// =========================================================================
// Join Production Matchmaking (Atomic Fee Reservation)
// =========================================================================
async function joinMatchmaking(userId, rawEntryFee) {
  await initNumberGuessDb();
  const cfg = await getConfigMap();

  if (!cfg.game_enabled) {
    const err = new Error('Number Guess Battle is currently offline for maintenance.');
    err.status = 503;
    throw err;
  }

  const entryFee = parseInt(rawEntryFee, 10);
  const allowedFees = Array.isArray(cfg.entry_fees) ? cfg.entry_fees.map(Number) : [500, 1000, 2000];
  if (!allowedFees.includes(entryFee)) {
    const err = new Error(`Invalid entry fee. Allowed: ${allowedFees.join(', ')}`);
    err.status = 400;
    throw err;
  }

  return runInTransaction(async ({ dbGet: txGet, dbAll: txAll, dbRun: txRun }) => {
    const user = await txGet(
      `SELECT id, username, full_name, balance, is_banned, ban_reason FROM users WHERE id = ?`,
      [userId]
    );
    if (!user) {
      const err = new Error('User account not found');
      err.status = 404;
      throw err;
    }
    if (user.is_banned) {
      const err = new Error(user.ban_reason || 'Account is banned');
      err.status = 403;
      throw err;
    }

    const activeRestriction = await txGet(
      `SELECT reason FROM ng_player_flags WHERE user_id = ? AND is_restricted = 1 AND is_active = 1 LIMIT 1`,
      [userId]
    );
    if (activeRestriction) {
      const err = new Error(`Matchmaking restricted: ${activeRestriction.reason}`);
      err.status = 403;
      throw err;
    }

    // Check if user is already in an ongoing production match (idempotent return)
    const existingParticipation = await txGet(
      `SELECT m.id FROM ng_match_participants p
       JOIN ng_matches m ON p.match_id = m.id
       WHERE p.user_id = ? AND m.is_sandbox = 0
         AND m.status IN ('WAITING','FILLING_BOTS','STARTING','ACTIVE')
       LIMIT 1`,
      [userId]
    );
    if (existingParticipation) {
      return existingParticipation.id;
    }

    // Atomic coin check & deduction
    const deductRes = await txRun(
      `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
      [entryFee, userId, entryFee]
    );
    if (deductRes.changes === 0) {
      const err = new Error(`Insufficient coins. You need ${entryFee} coins to join.`);
      err.status = 400;
      throw err;
    }

    const updatedUser = await txGet(`SELECT balance FROM users WHERE id = ?`, [userId]);
    const now = new Date();
    const nowIso = now.toISOString();

    // Find open WAITING or FILLING_BOTS room with same entry fee & available seats
    let openMatch = null;
    const candidates = await txAll(
      `SELECT m.* FROM ng_matches m
       WHERE m.is_sandbox = 0
         AND m.entry_fee = ?
         AND m.status IN ('WAITING', 'FILLING_BOTS')
       ORDER BY m.created_at ASC`,
      [entryFee]
    );

    for (const c of candidates) {
      const cntRow = await txGet(`SELECT COUNT(*) AS cnt FROM ng_match_participants WHERE match_id = ?`, [c.id]);
      if ((cntRow?.cnt || 0) < c.max_players) {
        openMatch = c;
        break;
      }
    }

    let matchId;
    if (openMatch) {
      matchId = openMatch.id;
    } else {
      matchId = crypto.randomUUID();
      const minPlayers = Math.max(2, Math.min(10, Number(cfg.min_players || 2)));
      const maxPlayers = Math.max(minPlayers, Math.min(10, Number(cfg.max_players || 10)));
      const searchTimeout = Math.max(10, Math.min(120, Number(cfg.search_timeout_sec || 30)));
      const botDelay = Math.max(1, Number(cfg.bot_fill_delay_sec || 10));

      const searchDeadlineIso = new Date(now.getTime() + searchTimeout * 1000).toISOString();
      const botFillIso = new Date(now.getTime() + botDelay * 1000).toISOString();

      await txRun(
        `INSERT INTO ng_matches (
           id, room_code, is_sandbox, status, entry_fee, min_players, max_players,
           bot_fill_at, next_bot_at, search_deadline_at, created_at
         ) VALUES (?, ?, 0, 'WAITING', ?, ?, ?, ?, ?, ?, ?)`,
        [
          matchId,
          generateRoomCode(),
          entryFee,
          minPlayers,
          maxPlayers,
          botFillIso,
          botFillIso,
          searchDeadlineIso,
          nowIso,
        ]
      );
    }

    await txRun(
      `INSERT INTO ng_match_participants (
         match_id, participant_type, user_id, username, avatar, entry_paid, joined_at
       ) VALUES (?, 'HUMAN', ?, ?, '👤', ?, ?)`,
      [matchId, userId, user.username, entryFee, nowIso]
    );

    // Auditable ledger + main Arena wallet transactions table
    const idempKey = `NG_ENTRY_${matchId}_U${userId}`;
    await txRun(
      `INSERT OR IGNORE INTO ng_ledger (
         idempotency_key, match_id, is_sandbox, participant_type, user_id, tx_type, amount, balance_after, note, created_at
       ) VALUES (?, ?, 0, 'HUMAN', ?, 'MATCH_ENTRY', ?, ?, ?, ?)`,
      [idempKey, matchId, userId, -entryFee, updatedUser.balance, `Joined match ${matchId}`, nowIso]
    );

    await txRun(
      `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MATCH_ENTRY', ?, ?)`,
      [userId, -entryFee, matchId]
    );

    // Lock immediately if room reached max_players
    const countAfter = await txGet(`SELECT COUNT(*) AS cnt FROM ng_match_participants WHERE match_id = ?`, [matchId]);
    const matchRow = await txGet(`SELECT max_players FROM ng_matches WHERE id = ?`, [matchId]);
    if (countAfter && matchRow && countAfter.cnt >= matchRow.max_players) {
      await transitionToStartingTx({ txRun, txGet }, matchId, cfg, now);
    }

    return matchId;
  });
}

// =========================================================================
// Leave Before Match Locks
// =========================================================================
async function leaveMatchmaking(userId, matchId) {
  const cfg = await getConfigMap();
  if (!cfg.allow_leave_before_lock) {
    const err = new Error('Leaving queue is disabled once entry fee is reserved.');
    err.status = 403;
    throw err;
  }

  return runInTransaction(async ({ dbGet: txGet, dbRun: txRun }) => {
    const match = await txGet(`SELECT * FROM ng_matches WHERE id = ? AND is_sandbox = 0`, [matchId]);
    if (!match) {
      const err = new Error('Match not found');
      err.status = 404;
      throw err;
    }
    if (!['WAITING', 'FILLING_BOTS'].includes(match.status)) {
      const err = new Error('Match is already locked and cannot be left.');
      err.status = 400;
      throw err;
    }

    const part = await txGet(
      `SELECT * FROM ng_match_participants WHERE match_id = ? AND user_id = ? AND refunded = 0`,
      [matchId, userId]
    );
    if (!part) {
      const err = new Error('Participant record not found');
      err.status = 404;
      throw err;
    }

    const nowIso = new Date().toISOString();
    const idempKey = `NG_REFUND_${matchId}_U${userId}`;

    const ins = await txRun(
      `INSERT OR IGNORE INTO ng_ledger (
         idempotency_key, match_id, is_sandbox, participant_type, user_id, tx_type, amount, note, created_at
       ) VALUES (?, ?, 0, 'HUMAN', ?, 'MATCH_REFUND', ?, 'Player left queue before lock', ?)`,
      [idempKey, matchId, userId, part.entry_paid, nowIso]
    );

    if (ins.changes > 0) {
      await txRun(`UPDATE users SET balance = balance + ? WHERE id = ?`, [part.entry_paid, userId]);
      await txRun(
        `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MATCH_REFUND', ?, ?)`,
        [userId, part.entry_paid, `${matchId}_LEAVE`]
      );
    }

    await txRun(`DELETE FROM ng_match_participants WHERE id = ?`, [part.id]);

    const remainingHumans = await txGet(
      `SELECT COUNT(*) AS cnt FROM ng_match_participants WHERE match_id = ? AND participant_type = 'HUMAN'`,
      [matchId]
    );
    if (!remainingHumans || remainingHumans.cnt === 0) {
      await refundAndCancelMatchTx({ txGet, txAll: async (s, p) => dbAll(s, p), txRun }, matchId, 'All players left queue');
    }

    return { refunded: part.entry_paid };
  });
}

// =========================================================================
// Lock Room -> Generate Secret -> Schedule Bots -> Transition to STARTING/ACTIVE
// =========================================================================
async function transitionToStartingTx({ txRun, txGet }, matchId, cfg, now = new Date()) {
  const match = await txGet(`SELECT * FROM ng_matches WHERE id = ?`, [matchId]);
  if (!match || !['WAITING', 'FILLING_BOTS'].includes(match.status)) return;

  const partCountRow = await txGet(`SELECT COUNT(*) AS cnt FROM ng_match_participants WHERE match_id = ?`, [matchId]);
  const participantCount = partCountRow?.cnt || 0;

  if (participantCount < match.min_players) {
    return;
  }

  const feePercent = getFeePercent(participantCount, cfg);
  const winnerSharePercent = 100 - feePercent;
  const totalPool = match.entry_fee * participantCount;
  const platformFeeCoins = Math.floor((totalPool * feePercent) / 100);
  const prizePoolCoins = totalPool - platformFeeCoins;

  const secretNumber =
    match.is_sandbox && match.secret_number !== null
      ? match.secret_number
      : crypto.randomInt(1, 101);

  const nowIso = now.toISOString();
  const countdownSec = Math.max(0, Number(cfg.starting_countdown_sec ?? 3));
  const startAtMs = now.getTime() + countdownSec * 1000;
  const roundSec = Math.max(10, Number(cfg.round_duration_sec || 30));

  const startingIso = new Date(startAtMs).toISOString();
  const roundDeadlineIso = new Date(startAtMs + roundSec * 1000).toISOString();

  await txRun(
    `UPDATE ng_matches
     SET status = ?,
         secret_number = COALESCE(secret_number, ?),
         secret_generated_at = COALESCE(secret_generated_at, ?),
         fee_percent = ?,
         winner_share_percent = ?,
         total_pool = ?,
         platform_fee_coins = ?,
         prize_pool_coins = ?,
         starting_at = ?,
         round_deadline_at = ?,
         started_at = CASE WHEN ? = 0 THEN ? ELSE started_at END
     WHERE id = ?`,
    [
      countdownSec === 0 ? 'ACTIVE' : 'STARTING',
      secretNumber,
      nowIso,
      feePercent,
      winnerSharePercent,
      totalPool,
      platformFeeCoins,
      prizePoolCoins,
      startingIso,
      roundDeadlineIso,
      countdownSec,
      nowIso,
      matchId,
    ]
  );
}

// =========================================================================
// Submit Human Guess (Immutable 1-100)
// =========================================================================
async function submitGuess(userId, matchId, rawGuess) {
  const guess = parseInt(rawGuess, 10);
  if (!Number.isInteger(guess) || guess < 1 || guess > 100) {
    const err = new Error('Guess must be a whole number between 1 and 100.');
    err.status = 400;
    throw err;
  }

  let shouldSettleNow = false;

  const result = await runInTransaction(async ({ dbGet: txGet, dbRun: txRun }) => {
    const match = await txGet(`SELECT * FROM ng_matches WHERE id = ?`, [matchId]);
    if (!match) {
      const err = new Error('Match not found');
      err.status = 404;
      throw err;
    }
    if (match.status !== 'ACTIVE') {
      const err = new Error(`Cannot submit guess while match is ${match.status}.`);
      err.status = 400;
      throw err;
    }
    if (match.round_deadline_at && Date.now() > new Date(match.round_deadline_at).getTime() + 1500) {
      const err = new Error('Round timer has expired.');
      err.status = 400;
      throw err;
    }

    const part = await txGet(
      `SELECT * FROM ng_match_participants WHERE match_id = ? AND user_id = ?`,
      [matchId, userId]
    );
    if (!part) {
      const err = new Error('You are not a participant in this match.');
      err.status = 403;
      throw err;
    }
    if (part.guess !== null) {
      const err = new Error('Guess is already locked and cannot be changed.');
      err.status = 400;
      throw err;
    }

    const nowIso = new Date().toISOString();
    await txRun(
      `UPDATE ng_match_participants SET guess = ?, guess_submitted_at = ? WHERE id = ? AND guess IS NULL`,
      [guess, nowIso, part.id]
    );

    const pendingRow = await txGet(
      `SELECT COUNT(*) AS cnt FROM ng_match_participants WHERE match_id = ? AND guess IS NULL`,
      [matchId]
    );
    if (pendingRow && pendingRow.cnt === 0) {
      shouldSettleNow = true;
    }

    return { guess, guessSubmittedAt: nowIso };
  });

  if (shouldSettleNow) {
    await settleMatch(matchId);
  }

  return result;
}

// =========================================================================
// Settle Completed Match (Closest Guess + Equal Tie Splitting)
// =========================================================================
async function settleMatch(matchId) {
  const cfg = await getConfigMap();

  return runInTransaction(async ({ dbGet: txGet, dbAll: txAll, dbRun: txRun }) => {
    const match = await txGet(`SELECT * FROM ng_matches WHERE id = ?`, [matchId]);
    if (!match || match.status !== 'ACTIVE') return null;

    const participants = await txAll(
      `SELECT * FROM ng_match_participants WHERE match_id = ? ORDER BY joined_at ASC`,
      [matchId]
    );

    const submitted = participants.filter((p) => p.guess !== null);

    // If nobody submitted a guess, refund if configured
    if (submitted.length === 0 && cfg.refund_on_no_guesses !== false) {
      await refundAndCancelMatchTx({ txGet, txAll, txRun }, matchId, 'No guesses submitted before timer expired');
      return { status: 'REFUNDED' };
    }

    const secret = match.secret_number ?? crypto.randomInt(1, 101);
    let minDiff = Infinity;

    for (const p of participants) {
      if (p.guess !== null) {
        p._diff = Math.abs(secret - p.guess);
        if (p._diff < minDiff) minDiff = p._diff;
      } else {
        p._diff = null;
      }
    }

    const winners = participants.filter((p) => p._diff !== null && p._diff === minDiff);
    const nowIso = new Date().toISOString();

    let totalRealEntry = 0;
    let totalRealPrize = 0;

    for (const p of participants) {
      if (p.participant_type === 'HUMAN') {
        totalRealEntry += p.entry_paid;
      }
    }

    // Split winner reward equally
    const winnerCount = winners.length;
    const baseShare = winnerCount > 0 ? Math.floor(match.prize_pool_coins / winnerCount) : 0;
    let remainder = winnerCount > 0 ? match.prize_pool_coins % winnerCount : 0;

    // Sort tied winners deterministically by earliest submission timestamp
    winners.sort((a, b) => String(a.guess_submitted_at || '').localeCompare(String(b.guess_submitted_at || '')));
    const winnerPayoutMap = new Map();
    for (const w of winners) {
      const extra = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder--;
      winnerPayoutMap.set(w.id, baseShare + extra);
    }

    for (const p of participants) {
      const isWinner = winnerPayoutMap.has(p.id) ? 1 : 0;
      const payout = winnerPayoutMap.get(p.id) || 0;

      await txRun(
        `UPDATE ng_match_participants SET diff = ?, is_winner = ?, payout_coins = ? WHERE id = ?`,
        [p._diff, isWinner, payout, p.id]
      );

      if (p.participant_type === 'BOT' && p.bot_id) {
        await txRun(
          `UPDATE ng_bots SET matches_played = matches_played + 1, wins = wins + ? WHERE id = ?`,
          [isWinner, p.bot_id]
        );
        if (isWinner && payout > 0) {
          const botKey = `NG_BOT_WIN_${matchId}_B${p.bot_id}`;
          const ins = await txRun(
            `INSERT OR IGNORE INTO ng_ledger (
               idempotency_key, match_id, is_sandbox, participant_type, bot_id, tx_type, amount, note, created_at
             ) VALUES (?, ?, ?, 'BOT', ?, 'BOT_VIRTUAL_REWARD', ?, ?, ?)`,
            [botKey, matchId, match.is_sandbox, p.bot_id, payout, `Bot won match ${match.room_code}`, nowIso]
          );
          if (ins.changes > 0) {
            await txRun(`UPDATE ng_bots SET virtual_balance = virtual_balance + ? WHERE id = ?`, [payout, p.bot_id]);
          }
        }
      } else if (p.participant_type === 'SANDBOX_SIM' && p.sandbox_account_id) {
        await txRun(
          `UPDATE ng_sandbox_accounts SET matches_played = matches_played + 1, wins = wins + ? WHERE id = ?`,
          [isWinner, p.sandbox_account_id]
        );
        if (isWinner && payout > 0) {
          const sbKey = `NG_SB_WIN_${matchId}_S${p.sandbox_account_id}`;
          const ins = await txRun(
            `INSERT OR IGNORE INTO ng_ledger (
               idempotency_key, match_id, is_sandbox, participant_type, sandbox_account_id, tx_type, amount, note, created_at
             ) VALUES (?, ?, 1, 'SANDBOX_SIM', ?, 'TEST_COIN_ADD', ?, ?, ?)`,
            [sbKey, matchId, p.sandbox_account_id, payout, `Sandbox win in ${match.room_code}`, nowIso]
          );
          if (ins.changes > 0) {
            await txRun(
              `UPDATE ng_sandbox_accounts SET balance = balance + ? WHERE id = ?`,
              [payout, p.sandbox_account_id]
            );
          }
        }
      } else if (p.participant_type === 'HUMAN' && p.user_id && !match.is_sandbox) {
        if (isWinner && payout > 0) {
          totalRealPrize += payout;
          const winKey = `NG_WIN_${matchId}_U${p.user_id}`;
          const ins = await txRun(
            `INSERT OR IGNORE INTO ng_ledger (
               idempotency_key, match_id, is_sandbox, participant_type, user_id, tx_type, amount, note, created_at
             ) VALUES (?, ?, 0, 'HUMAN', ?, 'MATCH_WIN', ?, ?, ?)`,
            [winKey, matchId, p.user_id, payout, `Won match ${match.room_code}`, nowIso]
          );
          if (ins.changes > 0) {
            await txRun(`UPDATE users SET balance = balance + ? WHERE id = ?`, [payout, p.user_id]);
            await txRun(
              `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MATCH_WIN', ?, ?)`,
              [p.user_id, payout, matchId]
            );
          }
        }
      }
    }

    // Record platform fee ledger entry
    if (match.platform_fee_coins > 0) {
      await txRun(
        `INSERT OR IGNORE INTO ng_ledger (
           idempotency_key, match_id, is_sandbox, participant_type, tx_type, amount, note, created_at
         ) VALUES (?, ?, ?, 'SYSTEM', 'PLATFORM_FEE', ?, ?, ?)`,
        [
          `NG_FEE_${matchId}`,
          matchId,
          match.is_sandbox,
          match.platform_fee_coins,
          `${match.fee_percent}% fee on pool ${match.total_pool}`,
          nowIso,
        ]
      );
    }

    await txRun(
      `UPDATE ng_matches
       SET status = 'COMPLETED',
           secret_number = ?,
           real_entry_coins = ?,
           real_prize_coins = ?,
           ended_at = ?
       WHERE id = ?`,
      [secret, totalRealEntry, totalRealPrize, nowIso, matchId]
    );

    return { status: 'COMPLETED', secretNumber: secret };
  });
}

// =========================================================================
// Atomic Cancel & Refund Helper
// =========================================================================
async function refundAndCancelMatchTx({ txGet, txAll, txRun }, matchId, reason = 'Cancelled') {
  const match = await txGet(`SELECT * FROM ng_matches WHERE id = ?`, [matchId]);
  if (!match || ['COMPLETED', 'REFUNDED'].includes(match.status)) return null;

  const participants = await txAll(`SELECT * FROM ng_match_participants WHERE match_id = ?`, [matchId]);
  const nowIso = new Date().toISOString();
  let realRefundTotal = 0;

  for (const p of participants) {
    if (p.refunded) continue;

    if (p.participant_type === 'HUMAN' && p.user_id && !match.is_sandbox && p.entry_paid > 0) {
      realRefundTotal += p.entry_paid;
      const refKey = `NG_REFUND_${matchId}_U${p.user_id}`;
      const ins = await txRun(
        `INSERT OR IGNORE INTO ng_ledger (
           idempotency_key, match_id, is_sandbox, participant_type, user_id, tx_type, amount, note, created_at
         ) VALUES (?, ?, 0, 'HUMAN', ?, 'MATCH_REFUND', ?, ?, ?)`,
        [refKey, matchId, p.user_id, p.entry_paid, reason, nowIso]
      );
      if (ins.changes > 0) {
        await txRun(`UPDATE users SET balance = balance + ? WHERE id = ?`, [p.entry_paid, p.user_id]);
        await txRun(
          `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MATCH_REFUND', ?, ?)`,
          [p.user_id, p.entry_paid, matchId]
        );
      }
    } else if (p.participant_type === 'BOT' && p.bot_id && p.entry_paid > 0) {
      await txRun(`UPDATE ng_bots SET virtual_balance = virtual_balance + ? WHERE id = ?`, [p.entry_paid, p.bot_id]);
    } else if (p.participant_type === 'SANDBOX_SIM' && p.sandbox_account_id && p.entry_paid > 0) {
      await txRun(
        `UPDATE ng_sandbox_accounts SET balance = balance + ? WHERE id = ?`,
        [p.entry_paid, p.sandbox_account_id]
      );
    }

    await txRun(`UPDATE ng_match_participants SET refunded = 1 WHERE id = ?`, [p.id]);
  }

  await txRun(
    `UPDATE ng_matches
     SET status = 'REFUNDED',
         real_refund_coins = ?,
         cancel_reason = ?,
         ended_at = ?
     WHERE id = ?`,
    [realRefundTotal, reason, nowIso, matchId]
  );

  return { status: 'REFUNDED', realRefundTotal };
}

async function cancelAndRefundMatch(matchId, reason) {
  return runInTransaction((tx) => refundAndCancelMatchTx(tx, matchId, reason));
}

// =========================================================================
// Background 1-Second State Machine Tick Loop
// =========================================================================
let tickTimer = null;
let tickBusy = false;

async function processTick() {
  if (tickBusy) return;
  tickBusy = true;

  try {
    const cfg = await getConfigMap();
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    // 1. Progress WAITING / FILLING_BOTS rooms
    const waitingMatches = await dbAll(
      `SELECT * FROM ng_matches WHERE is_sandbox = 0 AND status IN ('WAITING', 'FILLING_BOTS')`
    );

    for (const m of waitingMatches) {
      const participants = await dbAll(`SELECT * FROM ng_match_participants WHERE match_id = ?`, [m.id]);
      const totalCount = participants.length;
      const botCount = participants.filter((p) => p.participant_type === 'BOT').length;

      // Room full -> lock immediately
      if (totalCount >= m.max_players) {
        await runInTransaction((tx) => transitionToStartingTx(tx, m.id, cfg, now));
        continue;
      }

      const searchDeadlineMs = new Date(m.search_deadline_at).getTime();

      // Search timeout reached
      if (nowMs >= searchDeadlineMs) {
        if (totalCount >= m.min_players) {
          await runInTransaction((tx) => transitionToStartingTx(tx, m.id, cfg, now));
        } else {
          await cancelAndRefundMatch(m.id, 'Matchmaking timed out with insufficient players');
        }
        continue;
      }

      // Bot filling stage
      if (cfg.bot_filling_enabled && m.bot_fill_at && nowMs >= new Date(m.bot_fill_at).getTime()) {
        const nextBotMs = m.next_bot_at ? new Date(m.next_bot_at).getTime() : 0;
        if (nowMs >= nextBotMs) {
          const maxBotsMatch = Math.max(0, Number(cfg.max_bots_per_match ?? 9));
          const maxBotsGlobal = Math.max(0, Number(cfg.max_available_bots ?? 20));
          const targetTotal = Math.min(m.max_players, Math.max(m.min_players, 4));

          if (botCount < maxBotsMatch && totalCount < targetTotal) {
            await runInTransaction(async ({ dbGet: txGet, dbAll: txAll, dbRun: txRun }) => {
              const currentMatch = await txGet(`SELECT * FROM ng_matches WHERE id = ?`, [m.id]);
              if (!currentMatch || !['WAITING', 'FILLING_BOTS'].includes(currentMatch.status)) return;

              const existingBotIds = (
                await txAll(`SELECT bot_id FROM ng_match_participants WHERE match_id = ? AND bot_id IS NOT NULL`, [m.id])
              ).map((r) => r.bot_id);

              const enabledBots = await txAll(
                `SELECT * FROM ng_bots WHERE is_enabled = 1 AND virtual_balance >= ? ORDER BY RANDOM() LIMIT ?`,
                [currentMatch.entry_fee, maxBotsGlobal]
              );

              const candidateBot = enabledBots.find((b) => !existingBotIds.includes(b.id));
              if (candidateBot) {
                await txRun(`UPDATE ng_bots SET virtual_balance = virtual_balance - ? WHERE id = ?`, [
                  currentMatch.entry_fee,
                  candidateBot.id,
                ]);
                await txRun(
                  `INSERT OR IGNORE INTO ng_match_participants (
                     match_id, participant_type, bot_id, username, avatar, entry_paid, joined_at
                   ) VALUES (?, 'BOT', ?, ?, ?, ?, ?)`,
                  [m.id, candidateBot.id, candidateBot.username, candidateBot.avatar, currentMatch.entry_fee, nowIso]
                );
              }

              const intervalSec = Math.max(1, Number(cfg.bot_join_interval_sec || 2));
              const nextBotIso = new Date(nowMs + intervalSec * 1000).toISOString();
              await txRun(
                `UPDATE ng_matches SET status = 'FILLING_BOTS', next_bot_at = ? WHERE id = ?`,
                [nextBotIso, m.id]
              );
            });
          } else if (totalCount >= m.min_players && botCount >= maxBotsMatch) {
            await runInTransaction((tx) => transitionToStartingTx(tx, m.id, cfg, now));
          }
        }
      }
    }

    // 2. Progress STARTING -> ACTIVE
    const startingMatches = await dbAll(`SELECT * FROM ng_matches WHERE status = 'STARTING'`);
    for (const m of startingMatches) {
      if (m.starting_at && nowMs >= new Date(m.starting_at).getTime()) {
        await runInTransaction(async ({ dbAll: txAll, dbRun: txRun }) => {
          const roundSec = Math.max(10, Number(cfg.round_duration_sec || 30));
          const roundDeadlineIso = new Date(nowMs + roundSec * 1000).toISOString();

          await txRun(
            `UPDATE ng_matches SET status = 'ACTIVE', started_at = ?, round_deadline_at = ? WHERE id = ? AND status = 'STARTING'`,
            [nowIso, roundDeadlineIso, m.id]
          );

          // Schedule bot guess submissions
          const bots = await txAll(
            `SELECT id FROM ng_match_participants WHERE match_id = ? AND participant_type = 'BOT' AND guess IS NULL`,
            [m.id]
          );
          const minDelay = Math.max(1, Number(cfg.bot_submit_delay_min_sec || 3));
          const maxDelay = Math.max(minDelay, Math.min(roundSec - 2, Number(cfg.bot_submit_delay_max_sec || 15)));

          for (const b of bots) {
            const delaySec = crypto.randomInt(minDelay, maxDelay + 1);
            const submitAtIso = new Date(nowMs + delaySec * 1000).toISOString();
            await txRun(`UPDATE ng_match_participants SET scheduled_bot_submit_at = ? WHERE id = ?`, [
              submitAtIso,
              b.id,
            ]);
          }
        });
      }
    }

    // 3. Process ACTIVE matches (Bot submissions + Round timeout + All-submitted early finish)
    const activeMatches = await dbAll(`SELECT * FROM ng_matches WHERE status = 'ACTIVE'`);
    for (const m of activeMatches) {
      // Submit due bot guesses
      const dueBots = await dbAll(
        `SELECT p.id, b.strategy
         FROM ng_match_participants p
         LEFT JOIN ng_bots b ON p.bot_id = b.id
         WHERE p.match_id = ? AND p.participant_type = 'BOT' AND p.guess IS NULL
           AND p.scheduled_bot_submit_at IS NOT NULL AND p.scheduled_bot_submit_at <= ?`,
        [m.id, nowIso]
      );

      for (const dbBot of dueBots) {
        const botGuess = generateBotGuess(dbBot.strategy);
        await runInTransaction(async ({ dbRun: txRun }) => {
          await txRun(
            `UPDATE ng_match_participants SET guess = ?, guess_submitted_at = ? WHERE id = ? AND guess IS NULL`,
            [botGuess, nowIso, dbBot.id]
          );
        });
      }

      const pendingCountRow = await dbGet(
        `SELECT COUNT(*) AS cnt FROM ng_match_participants WHERE match_id = ? AND guess IS NULL`,
        [m.id]
      );

      const roundExpired = m.round_deadline_at && nowMs >= new Date(m.round_deadline_at).getTime();
      const allSubmitted = pendingCountRow && pendingCountRow.cnt === 0;

      if (allSubmitted || roundExpired) {
        await settleMatch(m.id);
      }
    }
  } catch (err) {
    console.error('[NG ENGINE TICK ERROR]:', err);
  } finally {
    tickBusy = false;
  }
}

function startEngine() {
  initNumberGuessDb()
    .then(() => {
      if (!tickTimer) {
        tickTimer = setInterval(processTick, 1000);
        console.log('🎯 Number Guess Battle Engine started (1s polling tick).');
      }
    })
    .catch((err) => {
      console.error('[NG ENGINE START FAILED]:', err);
    });
}

module.exports = {
  startEngine,
  joinMatchmaking,
  leaveMatchmaking,
  submitGuess,
  settleMatch,
  cancelAndRefundMatch,
  getEstimatedWaitSeconds,
  getFeePercent,
  generateBotGuess,
};
