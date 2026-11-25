// backend/routes/multiplayerAdmin.js
const express = require('express');
const router = express.Router();
const db = require('../database');

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

// 1. Dashboard Overview Stats
router.get('/dashboard-stats', async (req, res) => {
  try {
    const totalMatches = (await dbGet('SELECT COUNT(*) as c FROM multiplayer_matches')).c;
    const botMatches = (await dbGet('SELECT COUNT(*) as c FROM multiplayer_matches WHERE is_bot_match = 1')).c;
    const realMatches = totalMatches - botMatches;
    const activeMatches = (await dbGet("SELECT COUNT(*) as c FROM multiplayer_matches WHERE status = 'ACTIVE'")).c;

    const coinsSpent = (await dbGet("SELECT COALESCE(SUM(amount), 0) as s FROM transactions WHERE type = 'MULTIPLAYER_ENTRY'")).s;
    const coinsRewarded = (await dbGet("SELECT COALESCE(SUM(amount), 0) as s FROM transactions WHERE type = 'MULTIPLAYER_WIN'")).s;

    res.json({
      totalMatches,
      realMatches,
      botMatches,
      activeMatches,
      totalCoinsCollected: Math.abs(coinsSpent),
      totalCoinsPaidOut: coinsRewarded,
      netDifference: Math.abs(coinsSpent) - coinsRewarded
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Live Active Matches
router.get('/live-matches', async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT m.*, u1.username as p1_name, COALESCE(u2.username, b.username) as p2_name
      FROM multiplayer_matches m
      LEFT JOIN users u1 ON m.player1_id = u1.id
      LEFT JOIN users u2 ON m.player2_id = u2.id
      LEFT JOIN multiplayer_bots b ON m.bot_id = b.id
      WHERE m.status = 'ACTIVE'
      ORDER BY m.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. RESET ALL STUCK ACTIVE MATCHES & QUEUES
router.post('/reset-active-matches', async (req, res) => {
  try {
    await dbRun('BEGIN IMMEDIATE');
    const resetMatches = await dbRun(
      `UPDATE multiplayer_matches 
       SET status = 'CANCELLED', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE status = 'ACTIVE'`
    );
    const resetQueue = await dbRun(
      `UPDATE multiplayer_queue 
       SET status = 'CANCELLED' 
       WHERE status IN ('WAITING', 'PAIRING')`
    );
    await dbRun('COMMIT');

    res.json({
      success: true,
      message: `Successfully reset ${resetMatches.changes} stuck active matches and cleared all waiting queues.`,
      resetCount: resetMatches.changes
    });
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// 4. ALL MATCH HISTORY WITH WALLET LEDGER AUDIT
router.get('/matches', async (req, res) => {
  try {
    const { search, gameId, status, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT 
        m.id,
        m.game_id,
        m.player1_id,
        m.player2_id,
        m.is_bot_match,
        m.bot_id,
        m.entry_fee,
        m.winner_reward,
        m.status,
        m.winner_id,
        m.current_round,
        m.p1_score,
        m.p2_score,
        m.created_at,
        m.completed_at,
        u1.username AS p1_name,
        u1.balance AS p1_balance,
        COALESCE(u2.username, b.username) AS p2_name,
        u2.balance AS p2_balance,
        w.username AS winner_name,
        (
          SELECT t.id FROM transactions t 
          WHERE t.user_id = m.winner_id 
            AND t.type = 'MULTIPLAYER_WIN' 
            AND t.reference_id LIKE '%' || m.id || '%' 
          LIMIT 1
        ) AS payout_tx_id,
        (
          SELECT t.created_at FROM transactions t 
          WHERE t.user_id = m.winner_id 
            AND t.type = 'MULTIPLAYER_WIN' 
            AND t.reference_id LIKE '%' || m.id || '%' 
          LIMIT 1
        ) AS payout_tx_time
      FROM multiplayer_matches m
      LEFT JOIN users u1 ON m.player1_id = u1.id
      LEFT JOIN users u2 ON m.player2_id = u2.id
      LEFT JOIN multiplayer_bots b ON m.bot_id = b.id
      LEFT JOIN users w ON m.winner_id = w.id
      WHERE 1=1
    `;

    const params = [];

    if (gameId && gameId !== 'all') {
      sql += ' AND m.game_id = ?';
      params.push(gameId);
    }

    if (status && status !== 'all') {
      sql += ' AND m.status = ?';
      params.push(status);
    }

    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      const exactId = parseInt(search.trim(), 10) || -999999;
      sql += ` AND (
        u1.username LIKE ? OR 
        u2.username LIKE ? OR 
        b.username LIKE ? OR 
        m.player1_id = ? OR 
        m.player2_id = ? OR 
        m.id LIKE ?
      )`;
      params.push(q, q, q, exactId, exactId, q);
    }

    sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const matches = await dbAll(sql, params);
    res.json({ success: true, count: matches.length, matches });
  } catch (err) {
    console.error('[Admin Matches Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5. INSPECT SINGLE MATCH & COMPLETE LEDGER TIMELINE
router.get('/match/:matchId/details', async (req, res) => {
  const { matchId } = req.params;

  try {
    const match = await dbGet(`
      SELECT 
        m.*,
        u1.username AS p1_name,
        u1.balance AS p1_balance,
        COALESCE(u2.username, b.username) AS p2_name,
        u2.balance AS p2_balance,
        w.username AS winner_name
      FROM multiplayer_matches m
      LEFT JOIN users u1 ON m.player1_id = u1.id
      LEFT JOIN users u2 ON m.player2_id = u2.id
      LEFT JOIN multiplayer_bots b ON m.bot_id = b.id
      LEFT JOIN users w ON m.winner_id = w.id
      WHERE m.id = ?
    `, [matchId]);

    if (!match) return res.status(404).json({ error: 'Match not found.' });

    const transactions = await dbAll(`
      SELECT t.*, u.username 
      FROM transactions t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.reference_id LIKE '%' || ? || '%'
      ORDER BY t.created_at ASC
    `, [matchId]);

    let state = {};
    try {
      state = JSON.parse(match.game_state || '{}');
    } catch (_) {}

    res.json({
      success: true,
      match,
      gameState: state,
      transactions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. MANUAL COIN SETTLEMENT
router.post('/match/:matchId/manual-credit', async (req, res) => {
  const { matchId } = req.params;

  try {
    const match = await dbGet('SELECT * FROM multiplayer_matches WHERE id = ?', [matchId]);
    if (!match) return res.status(404).json({ error: 'Match not found.' });

    if (match.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Only completed matches can be credited.' });
    }

    const winnerId = Number(match.winner_id);
    if (!winnerId || winnerId <= 0) {
      return res.status(400).json({ error: 'No valid human winner found on this match.' });
    }

    const existingTx = await dbGet(`
      SELECT id FROM transactions 
      WHERE user_id = ? AND type = 'MULTIPLAYER_WIN' AND reference_id LIKE '%' || ? || '%'
    `, [winnerId, matchId]);

    if (existingTx) {
      return res.status(400).json({ error: `Winner already credited in Transaction #${existingTx.id}.` });
    }

    const reward = Number(match.winner_reward) || 200;
    const refId = `MP_WIN_${match.game_id}_${matchId}_MANUAL`;

    await dbRun('BEGIN IMMEDIATE');
    await dbRun(
      'UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?',
      [reward, reward, winnerId]
    );
    await dbRun(
      `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'MULTIPLAYER_WIN', ?, ?)`,
      [winnerId, reward, refId]
    );
    await dbRun('COMMIT');

    const winner = await dbGet('SELECT username, balance FROM users WHERE id = ?', [winnerId]);

    res.json({
      success: true,
      message: `Successfully credited ${reward} coins to ${winner?.username}! New Balance: ${winner?.balance} coins.`,
      newBalance: winner?.balance
    });
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// 7. Game Configurations
router.get('/configs', async (req, res) => {
  try {
    const configs = await dbAll('SELECT * FROM multiplayer_game_configs ORDER BY game_id ASC');
    res.json(configs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/configs', async (req, res) => {
  const { game_id, entry_fee, winner_reward, turn_timer, bot_difficulty, is_enabled } = req.body;
  try {
    await dbRun(
      `UPDATE multiplayer_game_configs 
       SET entry_fee = ?, winner_reward = ?, turn_timer = ?, bot_difficulty = ?, is_enabled = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE game_id = ?`,
      [parseInt(entry_fee, 10), parseInt(winner_reward, 10), parseInt(turn_timer, 10), bot_difficulty || 'HARD', is_enabled ? 1 : 0, game_id]
    );
    res.json({ success: true, message: `Configuration updated for ${game_id}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Bot Management
router.get('/bots', async (req, res) => {
  try {
    const bots = await dbAll('SELECT * FROM multiplayer_bots ORDER BY id ASC');
    res.json(bots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bots/edit', async (req, res) => {
  const { id, username, avatar_url, difficulty, is_active } = req.body;
  try {
    await dbRun(
      `UPDATE multiplayer_bots 
       SET username = ?, avatar_url = ?, difficulty = ?, is_active = ? 
       WHERE id = ?`,
      [username, avatar_url, difficulty || 'HARD', is_active !== undefined ? is_active : 1, id]
    );
    res.json({ success: true, message: `Bot ${username} updated successfully!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
