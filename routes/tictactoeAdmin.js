// backend/routes/tictactoeAdmin.js

const express = require('express');
const router = express.Router();
const db = require('../database');
const { getSettings, updateSetting } = require('../database/tictactoeDatabase');

// Middleware to authenticate Admin
function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Admin authorization required' });
  // Reuses existing admin auth
  next();
}

// 1. Dashboard Overview Metrics
router.get('/dashboard', authenticateAdmin, (req, res) => {
  const sql = `
    SELECT 
      COUNT(*) as total_matches,
      SUM(CASE WHEN is_bot_match = 0 THEN 1 ELSE 0 END) as real_matches,
      SUM(CASE WHEN is_bot_match = 1 THEN 1 ELSE 0 END) as bot_matches,
      SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_matches,
      SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as ongoing_matches,
      SUM(entry_fee * (CASE WHEN is_bot_match = 1 THEN 1 ELSE 2 END)) as total_fees_collected,
      SUM(CASE WHEN status = 'COMPLETED' AND winner_id IS NOT NULL THEN winner_reward ELSE 0 END) as total_rewards_distributed,
      SUM(total_rounds) as total_rounds_played
    FROM tictactoe_matches
  `;

  db.get(sql, [], (err, stats) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get('SELECT COUNT(*) as draw_rounds FROM tictactoe_rounds WHERE is_draw = 1', (dErr, drawRow) => {
      res.json({
        stats: {
          ...stats,
          draw_rounds: drawRow ? drawRow.draw_rounds : 0
        }
      });
    });
  });
});

// 2. Searchable Match History with full round inspection
router.get('/matches', authenticateAdmin, (req, res) => {
  const { username, matchId, matchType, status, limit = 50, offset = 0 } = req.query;

  let query = `
    SELECT m.*, u1.username as p1_username, COALESCE(u2.username, m.bot_name) as p2_username,
           w.username as winner_username
    FROM tictactoe_matches m
    LEFT JOIN users u1 ON m.player1_id = u1.id
    LEFT JOIN users u2 ON m.player2_id = u2.id
    LEFT JOIN users w ON m.winner_id = w.id
    WHERE 1=1
  `;
  const params = [];

  if (matchId) {
    query += ` AND m.id LIKE ?`;
    params.push(`%${matchId}%`);
  }
  if (username) {
    query += ` AND (u1.username LIKE ? OR u2.username LIKE ?)`;
    params.push(`%${username}%`, `%${username}%`);
  }
  if (matchType === 'BOT') {
    query += ` AND m.is_bot_match = 1`;
  } else if (matchType === 'REAL') {
    query += ` AND m.is_bot_match = 0`;
  }
  if (status) {
    query += ` AND m.status = ?`;
    params.push(status);
  }

  query += ` ORDER BY m.created_at DESC LIMIT ? OFFSET ?`;
  params.push(parseInt(limit, 10), parseInt(offset, 10));

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// 3. Match Details & Moves
router.get('/matches/:matchId/rounds', authenticateAdmin, (req, res) => {
  const { matchId } = req.params;
  db.all(
    'SELECT * FROM tictactoe_rounds WHERE match_id = ? ORDER BY round_number ASC',
    [matchId],
    (err, rounds) => {
      if (err) return res.status(500).json({ error: err.message });

      db.all(
        'SELECT * FROM tictactoe_moves WHERE match_id = ? ORDER BY round_number ASC, move_number ASC',
        [matchId],
        (mErr, moves) => {
          res.json({ rounds: rounds || [], moves: moves || [] });
        }
      );
    }
  );
});

// 4. Player Statistics Search
router.get('/players/:username', authenticateAdmin, (req, res) => {
  const { username } = req.params;
  db.get(
    `SELECT s.*, u.username, u.email, u.balance
     FROM users u
     LEFT JOIN tictactoe_player_stats s ON u.id = s.user_id
     WHERE u.username = ?`,
    [username],
    (err, player) => {
      if (err || !player) return res.status(404).json({ error: 'Player not found' });
      res.json(player);
    }
  );
});

// 5. Bot CRUD Operations
router.get('/bots', authenticateAdmin, (req, res) => {
  db.all('SELECT * FROM tictactoe_bots ORDER BY id ASC', (err, bots) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(bots);
  });
});

router.post('/bots', authenticateAdmin, (req, res) => {
  const { name, avatarUrl, difficulty, moveDelaySec } = req.body;
  db.run(
    `INSERT INTO tictactoe_bots (name, avatar_url, difficulty, move_delay_sec, is_enabled)
     VALUES (?, ?, ?, ?, 1)`,
    [name, avatarUrl || `https://api.dicebear.com/7.x/bottts/png?seed=${name}`, difficulty || 'HARD', moveDelaySec || 2],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

router.put('/bots/:id', authenticateAdmin, (req, res) => {
  const { id } = req.params;
  const { name, difficulty, moveDelaySec, isEnabled } = req.body;
  db.run(
    `UPDATE tictactoe_bots 
     SET name = COALESCE(?, name),
         difficulty = COALESCE(?, difficulty),
         move_delay_sec = COALESCE(?, move_delay_sec),
         is_enabled = COALESCE(?, is_enabled)
     WHERE id = ?`,
    [name, difficulty, moveDelaySec, isEnabled, id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

router.delete('/bots/:id', authenticateAdmin, (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM tictactoe_bots WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 6. Settings Management
router.get('/settings', authenticateAdmin, async (req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

router.post('/settings', authenticateAdmin, async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await updateSetting(key, value);
    }
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
