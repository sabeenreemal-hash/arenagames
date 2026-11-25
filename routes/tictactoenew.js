// backend/routes/tictactoenew.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const authenticateToken = require('../middleware/auth');
const { getSettings } = require('../database/tictactoeDatabase');
const { checkPlayerBotCooldown } = require('../services/tictactoeMatchmaking');

// 1. Get Game Settings & User Eligibility / Cooldown
router.get('/config', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const settings = await getSettings();
  const cooldown = await checkPlayerBotCooldown(userId);

  res.json({
    success: true,
    settings: {
      isEnabled: settings.is_enabled === '1',
      entryFee: parseInt(settings.entry_fee || '100', 10),
      winnerReward: parseInt(settings.winner_reward || '180', 10),
      turnTimer: parseInt(settings.turn_timer || '30', 10),
      searchTime: parseInt(settings.real_player_search_time || '30', 10)
    },
    cooldown
  });
});

// 2. Fetch User Aggregate Stats
router.get('/stats', authenticateToken, (req, res) => {
  db.get(
    'SELECT * FROM tictactoe_player_stats WHERE user_id = ?',
    [req.user.id],
    (err, stats) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json(stats || {
        total_matches: 0,
        real_matches: 0,
        bot_matches: 0,
        wins: 0,
        losses: 0,
        total_rounds: 0,
        draw_rounds: 0,
        coins_spent: 0,
        coins_won: 0,
        consecutive_bot_matches: 0
      });
    }
  );
});

// 3. User Match History (With Rounds and Moves)
router.get('/history', authenticateToken, (req, res) => {
  const userId = req.user.id;
  db.all(
    `SELECT m.*, u1.username as p1_name, COALESCE(u2.username, m.bot_name) as p2_name
     FROM tictactoe_matches m
     LEFT JOIN users u1 ON m.player1_id = u1.id
     LEFT JOIN users u2 ON m.player2_id = u2.id
     WHERE m.player1_id = ? OR m.player2_id = ?
     ORDER BY m.created_at DESC LIMIT 30`,
    [userId, userId],
    (err, matches) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch match history' });
      res.json(matches || []);
    }
  );
});

module.exports = router;
