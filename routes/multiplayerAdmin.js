// backend/routes/multiplayerAdmin.js
const express = require('express');
const router = express.Router();
const db = require('../database');

const dbGet = (sql, params) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const dbAll = (sql, params) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
const dbRun = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));

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

// 3. Fetch & Update Game Configurations
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
      [
        parseInt(entry_fee, 10),
        parseInt(winner_reward, 10),
        parseInt(turn_timer, 10),
        bot_difficulty || 'HARD',
        is_enabled ? 1 : 0,
        game_id
      ]
    );
    res.json({ success: true, message: `Configuration updated for ${game_id}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Fetch, Create & Edit Bot Profiles
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
    if (!id || !username) {
      return res.status(400).json({ error: 'Bot ID and Username are required' });
    }
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
