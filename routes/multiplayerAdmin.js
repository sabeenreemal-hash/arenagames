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

    const gameStats = await dbAll(`
      SELECT game_id, COUNT(*) as matches, 
        SUM(CASE WHEN is_bot_match = 1 THEN 1 ELSE 0 END) as bot_matches
      FROM multiplayer_matches GROUP BY game_id
    `);

    res.json({
      totalMatches,
      realMatches,
      botMatches,
      activeMatches,
      totalCoinsCollected: Math.abs(coinsSpent),
      totalCoinsPaidOut: coinsRewarded,
      netDifference: Math.abs(coinsSpent) - coinsRewarded,
      gameStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Live Matches
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

// 3. Bot Management (Get & Update)
router.get('/bots', async (req, res) => {
  const bots = await dbAll('SELECT * FROM multiplayer_bots ORDER BY id DESC');
  res.json(bots);
});

router.post('/bots', async (req, res) => {
  const { username, avatar_url, difficulty } = req.body;
  await dbRun(
    'INSERT INTO multiplayer_bots (username, avatar_url, difficulty) VALUES (?, ?, ?)',
    [username, avatar_url, difficulty || 'HARD']
  );
  res.json({ success: true });
});

// 4. Game Configuration
router.get('/configs', async (req, res) => {
  const configs = await dbAll('SELECT * FROM multiplayer_game_configs');
  res.json(configs);
});

router.post('/configs', async (req, res) => {
  const { game_id, entry_fee, winner_reward, turn_timer, bot_difficulty, is_enabled } = req.body;
  await dbRun(
    `UPDATE multiplayer_game_configs 
     SET entry_fee = ?, winner_reward = ?, turn_timer = ?, bot_difficulty = ?, is_enabled = ?, updated_at = CURRENT_TIMESTAMP 
     WHERE game_id = ?`,
    [entry_fee, winner_reward, turn_timer, bot_difficulty, is_enabled, game_id]
  );
  res.json({ success: true });
});

module.exports = router;
