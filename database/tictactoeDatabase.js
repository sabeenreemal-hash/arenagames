// backend/database/tictactoeDatabase.js

const db = require('../database');

function initTicTacToeDatabase() {
  db.serialize(() => {
    // 1. Settings Table
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const defaultSettings = {
      is_enabled: '1',
      entry_fee: '100',
      winner_reward: '180',
      real_player_search_time: '30',
      bot_activation_time: '20',
      max_consecutive_bot_matches: '3',
      bot_cooldown_minutes: '10',
      turn_timer: '30',
      bot_difficulty: 'HARD',
      bot_move_delay_min: '2',
      bot_move_delay_max: '4',
      automatic_draw_rematch: '1'
    };

    Object.entries(defaultSettings).forEach(([key, val]) => {
      db.run(
        `INSERT OR IGNORE INTO tictactoe_settings (key, value) VALUES (?, ?)`,
        [key, val]
      );
    });

    // 2. Bots Registry
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        avatar_url TEXT NOT NULL,
        difficulty TEXT DEFAULT 'HARD',
        move_delay_sec INTEGER DEFAULT 2,
        is_enabled INTEGER DEFAULT 1,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const seedBots = [
      { name: 'NeonViper (Bot)', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=NeonViper', diff: 'HARD', delay: 2 },
      { name: 'CyberTitan (Bot)', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=CyberTitan', diff: 'EXPERT', delay: 3 },
      { name: 'ShadowMaster (Bot)', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=ShadowMaster', diff: 'HARD', delay: 2 },
      { name: 'BlazeRider (Bot)', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=BlazeRider', diff: 'MEDIUM', delay: 2 },
      { name: 'PixelNova (Bot)', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=PixelNova', diff: 'HARD', delay: 3 }
    ];

    seedBots.forEach(bot => {
      db.run(
        `INSERT OR IGNORE INTO tictactoe_bots (name, avatar_url, difficulty, move_delay_sec, is_enabled)
         VALUES (?, ?, ?, ?, 1)`,
        [bot.name, bot.avatar, bot.diff, bot.delay]
      );
    });

    // 3. Match Records
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_matches (
        id TEXT PRIMARY KEY,
        player1_id INTEGER NOT NULL,
        player2_id INTEGER DEFAULT NULL,
        is_bot_match INTEGER DEFAULT 0,
        bot_id INTEGER DEFAULT NULL,
        bot_name TEXT DEFAULT NULL,
        entry_fee INTEGER NOT NULL DEFAULT 100,
        winner_reward INTEGER NOT NULL DEFAULT 180,
        status TEXT CHECK(status IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'FORFEITED')) DEFAULT 'ACTIVE',
        winner_id INTEGER DEFAULT NULL,
        loser_id INTEGER DEFAULT NULL,
        total_rounds INTEGER DEFAULT 1,
        cancellation_reason TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME DEFAULT NULL,
        FOREIGN KEY(player1_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 4. Rounds Record (Supports Infinite Draw Rematches)
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        round_winner_id INTEGER DEFAULT NULL,
        is_draw INTEGER DEFAULT 0,
        p1_symbol TEXT CHECK(p1_symbol IN ('X', 'O')) NOT NULL,
        p2_symbol TEXT CHECK(p2_symbol IN ('X', 'O')) NOT NULL,
        final_board TEXT NOT NULL DEFAULT '["","","","","","","","",""]',
        winning_line TEXT DEFAULT NULL,
        status TEXT CHECK(status IN ('PLAYING', 'DRAW', 'COMPLETED')) DEFAULT 'PLAYING',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME DEFAULT NULL,
        FOREIGN KEY(match_id) REFERENCES tictactoe_matches(id) ON DELETE CASCADE
      )
    `);

    // 5. Move Audit Log
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        move_number INTEGER NOT NULL,
        player_id INTEGER DEFAULT NULL,
        is_bot_move INTEGER DEFAULT 0,
        symbol TEXT NOT NULL,
        cell_index INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(match_id) REFERENCES tictactoe_matches(id) ON DELETE CASCADE
      )
    `);

    // 6. Player Aggregate Stats & Cooldown State
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_player_stats (
        user_id INTEGER PRIMARY KEY,
        total_matches INTEGER DEFAULT 0,
        real_matches INTEGER DEFAULT 0,
        bot_matches INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        total_rounds INTEGER DEFAULT 0,
        draw_rounds INTEGER DEFAULT 0,
        coins_spent INTEGER DEFAULT 0,
        coins_won INTEGER DEFAULT 0,
        consecutive_bot_matches INTEGER DEFAULT 0,
        bot_cooldown_until DATETIME DEFAULT NULL,
        last_match_at DATETIME DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Performance Indexes
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_matches_p1 ON tictactoe_matches(player1_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_matches_p2 ON tictactoe_matches(player2_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_matches_status ON tictactoe_matches(status);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_rounds_match ON tictactoe_rounds(match_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_moves_match_round ON tictactoe_moves(match_id, round_number);`);

    console.log('[DB SUCCESS] Tic Tac Toe Dedicated Tables Initialized.');
  });
}

function getSettings() {
  return new Promise((resolve) => {
    db.all('SELECT key, value FROM tictactoe_settings', (err, rows) => {
      if (err || !rows) return resolve({});
      const config = {};
      rows.forEach(r => {
        config[r.key] = r.value;
      });
      resolve(config);
    });
  });
}

function updateSetting(key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO tictactoe_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, String(value)],
      function(err) {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

module.exports = {
  initTicTacToeDatabase,
  getSettings,
  updateSetting
};