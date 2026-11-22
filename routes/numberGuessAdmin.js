// backend/routes/numberGuessAdmin.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const {
  dbGet,
  dbAll,
  dbRun,
  runInTransaction,
  initNumberGuessDb,
  getConfigMap,
  saveConfigKeys,
  logNgAdminAction,
  DEFAULT_CONFIG,
} = require('../ngDatabase');
const { loginAdmin, authenticateNgAdmin } = require('../middleware/ngAdminAuth');
const engine = require('../services/numberGuessEngine');

initNumberGuessDb().catch(() => {});

// =========================================================================
// 0. Admin Authentication
// =========================================================================
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await loginAdmin(username, password);
    if (!result) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    await logNgAdminAction(result.admin, 'ADMIN_LOGIN', 'ADMIN', result.admin.id, 'Logged into Number Guess Admin');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Require admin JWT for all subsequent endpoints
router.use(authenticateNgAdmin);

router.get('/auth/me', (req, res) => {
  res.json({ success: true, admin: req.admin });
});

// =========================================================================
// 1. Dashboard Stats (With Date Filters)
// =========================================================================
router.get('/dashboard', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = ['is_sandbox = 0'];
    const params = [];

    if (from) {
      where.push('created_at >= ?');
      params.push(`${from}T00:00:00.000Z`);
    }
    if (to) {
      where.push('created_at <= ?');
      params.push(`${to}T23:59:59.999Z`);
    }

    const whereSql = where.join(' AND ');

    const matchStats = await dbGet(
      `SELECT
         COUNT(*) AS totalMatches,
         SUM(CASE WHEN status IN ('WAITING','FILLING_BOTS') THEN 1 ELSE 0 END) AS waitingMatches,
         SUM(CASE WHEN status = 'STARTING' THEN 1 ELSE 0 END) AS startingMatches,
         SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS activeMatches,
         SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completedMatches,
         SUM(CASE WHEN status IN ('CANCELLED','REFUNDED') THEN 1 ELSE 0 END) AS cancelledMatches,
         COALESCE(SUM(real_entry_coins), 0) AS totalRealEntryCoins,
         COALESCE(SUM(real_prize_coins), 0) AS totalRealPrizeCoins,
         COALESCE(SUM(real_refund_coins), 0) AS totalRefunds,
         COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN platform_fee_coins ELSE 0 END), 0) AS theoreticalFeeCoins
       FROM ng_matches
       WHERE ${whereSql}`,
      params
    );

    const participantStats = await dbGet(
      `SELECT
         SUM(CASE WHEN p.participant_type = 'HUMAN' THEN 1 ELSE 0 END) AS realParticipants,
         SUM(CASE WHEN p.participant_type = 'BOT' THEN 1 ELSE 0 END) AS botParticipants,
         COALESCE(SUM(CASE WHEN p.participant_type = 'HUMAN' THEN p.entry_paid ELSE 0 END), 0) AS liveRealEntryCoins
       FROM ng_match_participants p
       JOIN ng_matches m ON p.match_id = m.id
       WHERE m.${whereSql}`,
      params
    );

    const botRow = await dbGet(`SELECT COUNT(*) AS availableBots FROM ng_bots WHERE is_enabled = 1`);

    const totalEntry = participantStats?.liveRealEntryCoins || 0;
    const totalPrize = matchStats?.totalRealPrizeCoins || 0;
    const totalRefunds = matchStats?.totalRefunds || 0;
    const platformFeeRevenue = Math.max(0, totalEntry - totalPrize - totalRefunds);

    res.json({
      success: true,
      stats: {
        totalMatches: matchStats?.totalMatches || 0,
        waitingMatches: matchStats?.waitingMatches || 0,
        startingMatches: matchStats?.startingMatches || 0,
        activeMatches: matchStats?.activeMatches || 0,
        completedMatches: matchStats?.completedMatches || 0,
        cancelledMatches: matchStats?.cancelledMatches || 0,
        realParticipants: participantStats?.realParticipants || 0,
        botParticipants: participantStats?.botParticipants || 0,
        totalEntryCoins: totalEntry,
        totalPrizeCoins: totalPrize,
        platformFeeRevenue,
        theoreticalFeeCoins: matchStats?.theoreticalFeeCoins || 0,
        totalRefunds,
        availableBots: botRow?.availableBots || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Dashboard fetch failed' });
  }
});

// =========================================================================
// 2 & 3. Live Matches + Match History + Match Detail + Start / Cancel
// =========================================================================
router.get('/matches/live', async (req, res) => {
  try {
    const cfg = await getConfigMap();
    const matches = await dbAll(
      `SELECT * FROM ng_matches
       WHERE is_sandbox = 0 AND status IN ('WAITING','FILLING_BOTS','STARTING','ACTIVE')
       ORDER BY created_at DESC`
    );

    const nowMs = Date.now();
    const enriched = [];

    for (const m of matches) {
      const parts = await dbAll(`SELECT participant_type FROM ng_match_participants WHERE match_id = ?`, [m.id]);
      const realCount = parts.filter((p) => p.participant_type === 'HUMAN').length;
      const botCount = parts.filter((p) => p.participant_type === 'BOT').length;
      const totalCount = parts.length;
      const feePct = m.fee_percent > 0 ? m.fee_percent : engine.getFeePercent(Math.max(2, totalCount), cfg);
      const totalPool = m.total_pool > 0 ? m.total_pool : m.entry_fee * totalCount;
      const feeCoins = m.platform_fee_coins > 0 ? m.platform_fee_coins : Math.floor((totalPool * feePct) / 100);

      let remainingSec = 0;
      if (['WAITING', 'FILLING_BOTS'].includes(m.status) && m.search_deadline_at) {
        remainingSec = Math.max(0, Math.ceil((new Date(m.search_deadline_at).getTime() - nowMs) / 1000));
      } else if (m.status === 'STARTING' && m.starting_at) {
        remainingSec = Math.max(0, Math.ceil((new Date(m.starting_at).getTime() - nowMs) / 1000));
      } else if (m.status === 'ACTIVE' && m.round_deadline_at) {
        remainingSec = Math.max(0, Math.ceil((new Date(m.round_deadline_at).getTime() - nowMs) / 1000));
      }

      enriched.push({
        id: m.id,
        roomCode: m.room_code,
        entryFee: m.entry_fee,
        participantCount: totalCount,
        realPlayerCount: realCount,
        botCount,
        totalPrizePool: totalPool,
        platformFeeCoins: feeCoins,
        feePercent: feePct,
        status: m.status,
        createdAt: m.created_at,
        remainingSec,
      });
    }

    res.json({ success: true, matches: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load live matches' });
  }
});

router.get('/matches/history', async (req, res) => {
  try {
    const { status, isSandbox, search, from, to, page = 1, limit = 25 } = req.query;
    const where = ['1=1'];
    const params = [];

    if (isSandbox !== undefined && isSandbox !== '') {
      where.push('m.is_sandbox = ?');
      params.push(Number(isSandbox) ? 1 : 0);
    } else {
      where.push('m.is_sandbox = 0');
    }

    if (status) {
      where.push('m.status = ?');
      params.push(status);
    }
    if (search) {
      where.push('(m.id LIKE ? OR m.room_code LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (from) {
      where.push('m.created_at >= ?');
      params.push(`${from}T00:00:00.000Z`);
    }
    if (to) {
      where.push('m.created_at <= ?');
      params.push(`${to}T23:59:59.999Z`);
    }

    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * lim;

    const totalRow = await dbGet(`SELECT COUNT(*) AS cnt FROM ng_matches m WHERE ${where.join(' AND ')}`, params);
    const rows = await dbAll(
      `SELECT m.*,
         (SELECT COUNT(*) FROM ng_match_participants p WHERE p.match_id = m.id) AS participantCount,
         (SELECT COUNT(*) FROM ng_match_participants p WHERE p.match_id = m.id AND p.participant_type = 'HUMAN') AS realCount,
         (SELECT COUNT(*) FROM ng_match_participants p WHERE p.match_id = m.id AND p.participant_type = 'BOT') AS botCount
       FROM ng_matches m
       WHERE ${where.join(' AND ')}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    const sanitized = rows.map((r) => ({
      ...r,
      secret_number: r.is_sandbox || r.status === 'COMPLETED' ? r.secret_number : null,
    }));

    res.json({
      success: true,
      total: totalRow?.cnt || 0,
      matches: sanitized,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch match history' });
  }
});

router.get('/matches/:matchId', async (req, res) => {
  try {
    const match = await dbGet(`SELECT * FROM ng_matches WHERE id = ?`, [req.params.matchId]);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const participants = await dbAll(
      `SELECT * FROM ng_match_participants WHERE match_id = ? ORDER BY joined_at ASC`,
      [match.id]
    );
    const ledger = await dbAll(
      `SELECT * FROM ng_ledger WHERE match_id = ? ORDER BY id ASC`,
      [match.id]
    );

    const canRevealSecret = Boolean(match.is_sandbox) || match.status === 'COMPLETED';
    const durationSec =
      match.started_at && match.ended_at
        ? Math.max(0, Math.round((new Date(match.ended_at).getTime() - new Date(match.started_at).getTime()) / 1000))
        : null;

    res.json({
      success: true,
      match: {
        ...match,
        secret_number: canRevealSecret ? match.secret_number : null,
        durationSec,
      },
      participants,
      ledger,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load match details' });
  }
});

router.post('/matches/:matchId/start', async (req, res) => {
  try {
    const match = await engine.adminStartMatch(req.params.matchId);
    await logNgAdminAction(req.admin, 'MANUAL_START_MATCH', 'MATCH', req.params.matchId, {
      roomCode: match.room_code,
      status: match.status,
    });
    res.json({ success: true, match });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Failed to start match' });
  }
});

router.post('/matches/:matchId/cancel', async (req, res) => {
  try {
    const reason = (req.body.reason || 'Cancelled by administrator').toString().trim();
    const result = await engine.cancelAndRefundMatch(req.params.matchId, reason);
    if (!result) {
      return res.status(400).json({ error: 'Match is already completed or refunded' });
    }
    await logNgAdminAction(req.admin, 'CANCEL_MATCH', 'MATCH', req.params.matchId, { reason, ...result });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to cancel match' });
  }
});

// =========================================================================
// 4, 7, 12. Settings (Matchmaking, Game Config, General Settings)
// =========================================================================
router.get('/settings', async (req, res) => {
  try {
    const cfg = await getConfigMap();
    res.json({ success: true, settings: cfg, defaults: DEFAULT_CONFIG });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const payload = { ...req.body };

    if (payload.min_players !== undefined) {
      payload.min_players = Math.max(2, Math.min(10, parseInt(payload.min_players, 10) || 2));
    }
    if (payload.max_players !== undefined) {
      payload.max_players = Math.max(2, Math.min(10, parseInt(payload.max_players, 10) || 10));
    }
    if (payload.search_timeout_sec !== undefined) {
      payload.search_timeout_sec = Math.max(10, Math.min(120, parseInt(payload.search_timeout_sec, 10) || 30));
    }
    if (payload.match_start_mode !== undefined) {
      payload.match_start_mode = payload.match_start_mode === 'MANUAL' ? 'MANUAL' : 'AUTO';
    }

    const updated = await saveConfigKeys(payload);
    await logNgAdminAction(req.admin, 'UPDATE_SETTINGS', 'CONFIG', 'ng_config', payload);
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// =========================================================================
// 5. Bot Management
// =========================================================================
router.get('/bots', async (req, res) => {
  try {
    const bots = await dbAll(`SELECT * FROM ng_bots ORDER BY id DESC`);
    res.json({ success: true, bots });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bots' });
  }
});

router.post('/bots', async (req, res) => {
  try {
    const { username, avatar = '🤖', strategy = 'RANDOM', is_enabled = 1 } = req.body;
    if (!username || String(username).trim().length < 2) {
      return res.status(400).json({ error: 'Bot username is required' });
    }
    const cleanStrategy = ['RANDOM', 'LOW', 'HIGH', 'MIDDLE'].includes(String(strategy).toUpperCase())
      ? String(strategy).toUpperCase()
      : 'RANDOM';

    const nowIso = new Date().toISOString();
    const r = await dbRun(
      `INSERT INTO ng_bots (username, avatar, is_enabled, strategy, virtual_balance, created_at)
       VALUES (?, ?, ?, ?, 100000, ?)`,
      [String(username).trim(), String(avatar).trim() || '🤖', is_enabled ? 1 : 0, cleanStrategy, nowIso]
    );
    const bot = await dbGet(`SELECT * FROM ng_bots WHERE id = ?`, [r.lastID]);
    await logNgAdminAction(req.admin, 'CREATE_BOT', 'BOT', r.lastID, bot);
    res.json({ success: true, bot });
  } catch (err) {
    res.status(400).json({ error: err.message.includes('UNIQUE') ? 'Bot username already exists' : err.message });
  }
});

router.put('/bots/:id', async (req, res) => {
  try {
    const bot = await dbGet(`SELECT * FROM ng_bots WHERE id = ?`, [req.params.id]);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const username = req.body.username !== undefined ? String(req.body.username).trim() : bot.username;
    const avatar = req.body.avatar !== undefined ? String(req.body.avatar).trim() : bot.avatar;
    const isEnabled = req.body.is_enabled !== undefined ? (req.body.is_enabled ? 1 : 0) : bot.is_enabled;
    const strategy =
      req.body.strategy && ['RANDOM', 'LOW', 'HIGH', 'MIDDLE'].includes(String(req.body.strategy).toUpperCase())
        ? String(req.body.strategy).toUpperCase()
        : bot.strategy;

    await dbRun(
      `UPDATE ng_bots SET username = ?, avatar = ?, is_enabled = ?, strategy = ? WHERE id = ?`,
      [username, avatar, isEnabled, strategy, bot.id]
    );
    const updated = await dbGet(`SELECT * FROM ng_bots WHERE id = ?`, [bot.id]);
    await logNgAdminAction(req.admin, 'UPDATE_BOT', 'BOT', bot.id, updated);
    res.json({ success: true, bot: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/bots/:id', async (req, res) => {
  try {
    const r = await dbRun(`DELETE FROM ng_bots WHERE id = ?`, [req.params.id]);
    if (r.changes === 0) return res.status(404).json({ error: 'Bot not found' });
    await logNgAdminAction(req.admin, 'DELETE_BOT', 'BOT', req.params.id, 'Deleted bot');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete bot' });
  }
});

router.get('/bots/:id/history', async (req, res) => {
  try {
    const bot = await dbGet(`SELECT * FROM ng_bots WHERE id = ?`, [req.params.id]);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const history = await dbAll(
      `SELECT m.id AS matchId, m.room_code AS roomCode, m.status, m.entry_fee AS entryFee,
              m.secret_number AS secretNumber, p.guess, p.diff, p.is_winner AS isWinner,
              p.payout_coins AS payoutCoins, m.created_at AS createdAt
       FROM ng_match_participants p
       JOIN ng_matches m ON p.match_id = m.id
       WHERE p.bot_id = ?
       ORDER BY m.created_at DESC LIMIT 50`,
      [bot.id]
    );
    res.json({ success: true, bot, history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load bot history' });
  }
});

// =========================================================================
// 6. Player Management (Search, Dossier, Flags & Restrictions)
// =========================================================================
router.get('/players', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const isId = /^\d+$/.test(q);

    const rows = q
      ? await dbAll(
          `SELECT u.id, u.username, u.full_name, u.balance, u.is_banned, u.created_at,
                  (SELECT COUNT(*) FROM ng_match_participants p WHERE p.user_id = u.id) AS ngMatches,
                  (SELECT COUNT(*) FROM ng_match_participants p WHERE p.user_id = u.id AND p.is_winner = 1) AS ngWins,
                  (SELECT COUNT(*) FROM ng_player_flags f WHERE f.user_id = u.id AND f.is_active = 1) AS activeFlags,
                  (SELECT COUNT(*) FROM ng_player_flags f WHERE f.user_id = u.id AND f.is_active = 1 AND f.is_restricted = 1) AS isRestricted
           FROM users u
           WHERE ${isId ? 'u.id = ? OR u.username LIKE ?' : 'u.username LIKE ? OR u.full_name LIKE ?'}
           ORDER BY u.id DESC LIMIT 30`,
          isId ? [parseInt(q, 10), `%${q}%`] : [`%${q}%`, `%${q}%`]
        )
      : await dbAll(
          `SELECT u.id, u.username, u.full_name, u.balance, u.is_banned, u.created_at,
                  (SELECT COUNT(*) FROM ng_match_participants p WHERE p.user_id = u.id) AS ngMatches,
                  (SELECT COUNT(*) FROM ng_match_participants p WHERE p.user_id = u.id AND p.is_winner = 1) AS ngWins,
                  (SELECT COUNT(*) FROM ng_player_flags f WHERE f.user_id = u.id AND f.is_active = 1) AS activeFlags,
                  (SELECT COUNT(*) FROM ng_player_flags f WHERE f.user_id = u.id AND f.is_active = 1 AND f.is_restricted = 1) AS isRestricted
           FROM users u
           ORDER BY ngMatches DESC, u.id DESC LIMIT 30`
        );

    res.json({ success: true, players: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to search players' });
  }
});

router.get('/players/:userId', async (req, res) => {
  try {
    const user = await dbGet(
      `SELECT id, username, full_name, email, balance, is_banned, ban_reason, created_at FROM users WHERE id = ?`,
      [req.params.userId]
    );
    if (!user) return res.status(404).json({ error: 'Player not found' });

    const matches = await dbAll(
      `SELECT m.id AS matchId, m.room_code AS roomCode, m.status, m.entry_fee AS entryFee,
              m.secret_number AS secretNumber, p.guess, p.diff, p.is_winner AS isWinner,
              p.payout_coins AS payoutCoins, p.refunded, m.created_at AS createdAt
       FROM ng_match_participants p
       JOIN ng_matches m ON p.match_id = m.id
       WHERE p.user_id = ? AND m.is_sandbox = 0
       ORDER BY m.created_at DESC LIMIT 100`,
      [user.id]
    );

    const ledger = await dbAll(
      `SELECT * FROM ng_ledger WHERE user_id = ? AND is_sandbox = 0 ORDER BY id DESC LIMIT 100`,
      [user.id]
    );

    const flags = await dbAll(
      `SELECT * FROM ng_player_flags WHERE user_id = ? ORDER BY id DESC`,
      [user.id]
    );

    const summary = {
      matchesPlayed: matches.length,
      wins: matches.filter((m) => m.isWinner).length,
      losses: matches.filter((m) => m.status === 'COMPLETED' && !m.isWinner).length,
      totalEntryPaid: matches.reduce((s, m) => s + (m.entryFee || 0), 0),
      totalWonCoins: matches.reduce((s, m) => s + (m.payoutCoins || 0), 0),
      totalRefunded: matches.filter((m) => m.refunded).reduce((s, m) => s + (m.entryFee || 0), 0),
    };

    res.json({ success: true, player: user, summary, matches, ledger, flags });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load player dossier' });
  }
});

router.post('/players/:userId/flag', async (req, res) => {
  try {
    const { action = 'FLAG', flagType = 'SUSPICIOUS', isRestricted = false, reason = '' } = req.body;
    const nowIso = new Date().toISOString();

    if (action === 'CLEAR') {
      await dbRun(
        `UPDATE ng_player_flags SET is_active = 0, resolved_at = ? WHERE user_id = ? AND is_active = 1`,
        [nowIso, req.params.userId]
      );
      await logNgAdminAction(req.admin, 'CLEAR_PLAYER_FLAGS', 'USER', req.params.userId, reason || 'Cleared flags');
      return res.json({ success: true });
    }

    if (!reason || String(reason).trim().length < 3) {
      return res.status(400).json({ error: 'Documented reason is required' });
    }

    await dbRun(
      `INSERT INTO ng_player_flags (user_id, flag_type, is_restricted, reason, admin_username, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [req.params.userId, flagType, isRestricted ? 1 : 0, String(reason).trim(), req.admin.username, nowIso]
    );

    await logNgAdminAction(req.admin, isRestricted ? 'RESTRICT_PLAYER' : 'FLAG_PLAYER', 'USER', req.params.userId, {
      flagType,
      isRestricted,
      reason,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update player flag' });
  }
});

// =========================================================================
// 8 & 9. Coin Management & Transactions Ledger
// =========================================================================
router.get('/transactions', async (req, res) => {
  try {
    const { type, userId, isSandbox, from, to, page = 1, limit = 50 } = req.query;
    const where = ['1=1'];
    const params = [];

    if (type) {
      where.push('l.tx_type = ?');
      params.push(type);
    }
    if (userId) {
      where.push('l.user_id = ?');
      params.push(parseInt(userId, 10));
    }
    if (isSandbox !== undefined && isSandbox !== '') {
      where.push('l.is_sandbox = ?');
      params.push(Number(isSandbox) ? 1 : 0);
    }
    if (from) {
      where.push('l.created_at >= ?');
      params.push(`${from}T00:00:00.000Z`);
    }
    if (to) {
      where.push('l.created_at <= ?');
      params.push(`${to}T23:59:59.999Z`);
    }

    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * lim;

    const totalRow = await dbGet(`SELECT COUNT(*) AS cnt FROM ng_ledger l WHERE ${where.join(' AND ')}`, params);
    const rows = await dbAll(
      `SELECT l.*, u.username AS humanUsername, b.username AS botUsername, s.username AS sandboxUsername
       FROM ng_ledger l
       LEFT JOIN users u ON l.user_id = u.id
       LEFT JOIN ng_bots b ON l.bot_id = b.id
       LEFT JOIN ng_sandbox_accounts s ON l.sandbox_account_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    const totals = await dbAll(
      `SELECT tx_type, COALESCE(SUM(amount), 0) AS totalAmount, COUNT(*) AS cnt
       FROM ng_ledger WHERE is_sandbox = 0 GROUP BY tx_type`
    );

    res.json({ success: true, total: totalRow?.cnt || 0, transactions: rows, summaryByType: totals });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load ledger transactions' });
  }
});

// =========================================================================
// 10. Private Sandbox Testing Environment (Strictly Isolated)
// =========================================================================
router.get('/sandbox/accounts', async (req, res) => {
  try {
    const accounts = await dbAll(`SELECT * FROM ng_sandbox_accounts ORDER BY id ASC`);
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sandbox accounts' });
  }
});

router.post('/sandbox/accounts', async (req, res) => {
  try {
    const { username, balance = 10000 } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const nowIso = new Date().toISOString();
    const bal = Math.max(0, parseInt(balance, 10) || 10000);

    const r = await dbRun(
      `INSERT INTO ng_sandbox_accounts (username, avatar, balance, created_at) VALUES (?, '🧪', ?, ?)`,
      [String(username).trim(), bal, nowIso]
    );
    await dbRun(
      `INSERT INTO ng_ledger (idempotency_key, is_sandbox, participant_type, sandbox_account_id, tx_type, amount, balance_after, note, created_at)
       VALUES (?, 1, 'SANDBOX_SIM', ?, 'TEST_COIN_ADD', ?, ?, 'Initial sandbox test coins', ?)`,
      [`SB_INIT_${r.lastID}_${Date.now()}`, r.lastID, bal, bal, nowIso]
    );
    const acc = await dbGet(`SELECT * FROM ng_sandbox_accounts WHERE id = ?`, [r.lastID]);
    res.json({ success: true, account: acc });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sandbox/accounts/:id/coins', async (req, res) => {
  try {
    const { operation = 'ADD', amount = 1000, note = 'Admin sandbox adjustment' } = req.body;
    const amt = Math.max(1, parseInt(amount, 10) || 0);
    const nowIso = new Date().toISOString();

    const updated = await runInTransaction(async ({ dbGet: txGet, dbRun: txRun }) => {
      const acc = await txGet(`SELECT * FROM ng_sandbox_accounts WHERE id = ?`, [req.params.id]);
      if (!acc) throw new Error('Sandbox account not found');

      const isDeduct = String(operation).toUpperCase() === 'DEDUCT';
      const delta = isDeduct ? -Math.min(acc.balance, amt) : amt;
      const newBal = acc.balance + delta;

      await txRun(`UPDATE ng_sandbox_accounts SET balance = ? WHERE id = ?`, [newBal, acc.id]);
      await txRun(
        `INSERT INTO ng_ledger (idempotency_key, is_sandbox, participant_type, sandbox_account_id, tx_type, amount, balance_after, note, created_at)
         VALUES (?, 1, 'SANDBOX_SIM', ?, ?, ?, ?, ?, ?)`,
        [
          `SB_ADJ_${acc.id}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
          acc.id,
          isDeduct ? 'TEST_COIN_DEDUCT' : 'TEST_COIN_ADD',
          delta,
          newBal,
          note,
          nowIso,
        ]
      );
      return txGet(`SELECT * FROM ng_sandbox_accounts WHERE id = ?`, [acc.id]);
    });

    await logNgAdminAction(req.admin, 'SANDBOX_COIN_ADJUST', 'SANDBOX_ACC', req.params.id, { operation, amt });
    res.json({ success: true, account: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sandbox/matches', async (req, res) => {
  try {
    const {
      entryFee = 500,
      secretNumber,
      sandboxAccountIds = [],
      botIds = [],
      guesses = {},
      autoSettle = false,
    } = req.body;

    const secret = parseInt(secretNumber, 10);
    if (!Number.isInteger(secret) || secret < 1 || secret > 100) {
      return res.status(400).json({ error: 'Manual sandbox secretNumber must be between 1 and 100' });
    }

    const totalParticipants = sandboxAccountIds.length + botIds.length;
    if (totalParticipants < 2 || totalParticipants > 10) {
      return res.status(400).json({ error: 'Sandbox match requires between 2 and 10 participants' });
    }

    const cfg = await getConfigMap();
    const fee = parseInt(entryFee, 10) || 500;
    const feePercent = engine.getFeePercent(totalParticipants, cfg);
    const totalPool = fee * totalParticipants;
    const platformFeeCoins = Math.floor((totalPool * feePercent) / 100);
    const prizePoolCoins = totalPool - platformFeeCoins;

    const matchId = await runInTransaction(async ({ dbGet: txGet, dbRun: txRun }) => {
      const mId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const deadlineIso = new Date(Date.now() + 300 * 1000).toISOString();

      await txRun(
        `INSERT INTO ng_matches (
           id, room_code, is_sandbox, status, entry_fee, min_players, max_players,
           secret_number, secret_generated_at, secret_mode, fee_percent, winner_share_percent,
           total_pool, platform_fee_coins, prize_pool_coins, search_deadline_at, round_deadline_at,
           created_at, started_at
         ) VALUES (?, ?, 1, 'ACTIVE', ?, 2, 10, ?, ?, 'MANUAL_SANDBOX', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mId,
          'SB-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
          fee,
          secret,
          nowIso,
          feePercent,
          100 - feePercent,
          totalPool,
          platformFeeCoins,
          prizePoolCoins,
          deadlineIso,
          deadlineIso,
          nowIso,
          nowIso,
        ]
      );

      for (const accId of sandboxAccountIds) {
        const acc = await txGet(`SELECT * FROM ng_sandbox_accounts WHERE id = ?`, [accId]);
        if (!acc) throw new Error(`Sandbox account ${accId} not found`);
        if (acc.balance < fee) throw new Error(`Sandbox account ${acc.username} has insufficient test coins`);

        const newBal = acc.balance - fee;
        await txRun(`UPDATE ng_sandbox_accounts SET balance = ? WHERE id = ?`, [newBal, acc.id]);
        await txRun(
          `INSERT INTO ng_ledger (idempotency_key, match_id, is_sandbox, participant_type, sandbox_account_id, tx_type, amount, balance_after, note, created_at)
           VALUES (?, ?, 1, 'SANDBOX_SIM', ?, 'TEST_COIN_DEDUCT', ?, ?, 'Sandbox match entry', ?)`,
          [`SB_ENT_${mId}_S${acc.id}`, mId, acc.id, -fee, newBal, nowIso]
        );

        const g = guesses[`sim_${acc.id}`] !== undefined ? parseInt(guesses[`sim_${acc.id}`], 10) : null;
        await txRun(
          `INSERT INTO ng_match_participants (
             match_id, participant_type, sandbox_account_id, username, avatar, entry_paid, guess, guess_submitted_at, joined_at
           ) VALUES (?, 'SANDBOX_SIM', ?, ?, ?, ?, ?, ?, ?)`,
          [mId, acc.id, acc.username, acc.avatar, fee, g, g !== null ? nowIso : null, nowIso]
        );
      }

      for (const bId of botIds) {
        const bot = await txGet(`SELECT * FROM ng_bots WHERE id = ?`, [bId]);
        if (!bot) throw new Error(`Bot ${bId} not found`);
        const g = guesses[`bot_${bot.id}`] !== undefined ? parseInt(guesses[`bot_${bot.id}`], 10) : null;
        await txRun(
          `INSERT INTO ng_match_participants (
             match_id, participant_type, bot_id, username, avatar, entry_paid, guess, guess_submitted_at, joined_at
           ) VALUES (?, 'BOT', ?, ?, ?, ?, ?, ?, ?)`,
          [mId, bot.id, bot.username, bot.avatar, fee, g, g !== null ? nowIso : null, nowIso]
        );
      }

      return mId;
    });

    if (autoSettle) {
      await engine.settleMatch(matchId);
    }

    await logNgAdminAction(req.admin, 'CREATE_SANDBOX_MATCH', 'MATCH', matchId, { secret, fee, autoSettle });
    const match = await dbGet(`SELECT * FROM ng_matches WHERE id = ?`, [matchId]);
    const participants = await dbAll(`SELECT * FROM ng_match_participants WHERE match_id = ?`, [matchId]);

    res.json({ success: true, match, participants });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create sandbox match' });
  }
});

router.post('/sandbox/matches/:matchId/simulate', async (req, res) => {
  try {
    const { participantGuesses = {}, settleNow = true } = req.body;
    const match = await dbGet(`SELECT * FROM ng_matches WHERE id = ? AND is_sandbox = 1`, [req.params.matchId]);
    if (!match) return res.status(404).json({ error: 'Sandbox match not found' });

    const nowIso = new Date().toISOString();
    await runInTransaction(async ({ dbAll: txAll, dbRun: txRun }) => {
      const parts = await txAll(`SELECT * FROM ng_match_participants WHERE match_id = ?`, [match.id]);
      for (const p of parts) {
        if (p.guess !== null) continue;
        let g = participantGuesses[p.id];
        if (g === undefined) {
          g = crypto.randomInt(1, 101);
        }
        const parsed = Math.max(1, Math.min(100, parseInt(g, 10) || 50));
        await txRun(`UPDATE ng_match_participants SET guess = ?, guess_submitted_at = ? WHERE id = ?`, [
          parsed,
          nowIso,
          p.id,
        ]);
      }
    });

    if (settleNow) {
      await engine.settleMatch(match.id);
    }

    const updatedMatch = await dbGet(`SELECT * FROM ng_matches WHERE id = ?`, [match.id]);
    const participants = await dbAll(`SELECT * FROM ng_match_participants WHERE match_id = ?`, [match.id]);
    res.json({ success: true, match: updatedMatch, participants });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sandbox/reset', async (req, res) => {
  try {
    const nowIso = new Date().toISOString();
    await runInTransaction(async ({ dbRun: txRun }) => {
      await txRun(`DELETE FROM ng_ledger WHERE is_sandbox = 1`);
      await txRun(`DELETE FROM ng_matches WHERE is_sandbox = 1`);
      await txRun(`UPDATE ng_sandbox_accounts SET balance = 10000, matches_played = 0, wins = 0`);
    });
    await logNgAdminAction(req.admin, 'SANDBOX_RESET', 'SANDBOX', 'ALL', 'Reset all sandbox test data');
    res.json({ success: true, resetAt: nowIso });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset sandbox data' });
  }
});

// =========================================================================
// 11. Admin Activity Logs
// =========================================================================
router.get('/logs', async (req, res) => {
  try {
    const logs = await dbAll(`SELECT * FROM ng_admin_logs ORDER BY id DESC LIMIT 200`);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin activity logs' });
  }
});

module.exports = router;
