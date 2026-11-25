cat << 'EOF' > /root/arenagames/database/tictactoeDatabase.js
const db = require('../database');

function addColumnIfNotExists(table, column, type, cb) {
  db.all(`PRAGMA table_info(${table})`, (err, cols) => {
    if (!err && cols && cols.length > 0) {
      const exists = cols.some(c => c.name === column);
      if (!exists) {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, () => {
          if (typeof cb === 'function') cb();
        });
        return;
      }
    }
    if (typeof cb === 'function') cb();
  });
}

function initTicTacToeDatabase() {
  db.serialize(() => {
    // 1. Settings Table
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `, () => {});

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
        [key, val],
        () => {}
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
    `, () => {});

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
        [bot.name, bot.avatar, bot.diff, bot.delay],
        () => {}
      );
    });

    // 3. Match Records
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_matches (
        id TEXT PRIMARY KEY,
        player1_id INTEGER,
        player2_id INTEGER,
        is_bot_match INTEGER DEFAULT 0,
        bot_id INTEGER,
        bot_name TEXT,
        entry_fee INTEGER DEFAULT 100,
        winner_reward INTEGER DEFAULT 180,
        status TEXT DEFAULT 'ACTIVE',
        winner_id INTEGER,
        loser_id INTEGER,
        total_rounds INTEGER DEFAULT 1,
        cancellation_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      )
    `, () => {});

    // Ensure columns exist on old existing tables
    addColumnIfNotExists('tictactoe_matches', 'player1_id', 'INTEGER');
    addColumnIfNotExists('tictactoe_matches', 'player2_id', 'INTEGER');
    addColumnIfNotExists('tictactoe_matches', 'is_bot_match', 'INTEGER DEFAULT 0');
    addColumnIfNotExists('tictactoe_matches', 'bot_id', 'INTEGER');
    addColumnIfNotExists('tictactoe_matches', 'bot_name', 'TEXT');
    addColumnIfNotExists('tictactoe_matches', 'entry_fee', 'INTEGER DEFAULT 100');
    addColumnIfNotExists('tictactoe_matches', 'winner_reward', 'INTEGER DEFAULT 180');
    addColumnIfNotExists('tictactoe_matches', 'status', "TEXT DEFAULT 'ACTIVE'");
    addColumnIfNotExists('tictactoe_matches', 'winner_id', 'INTEGER');
    addColumnIfNotExists('tictactoe_matches', 'loser_id', 'INTEGER');
    addColumnIfNotExists('tictactoe_matches', 'total_rounds', 'INTEGER DEFAULT 1');

    // 4. Rounds Record
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        round_winner_id INTEGER,
        is_draw INTEGER DEFAULT 0,
        p1_symbol TEXT NOT NULL DEFAULT 'X',
        p2_symbol TEXT NOT NULL DEFAULT 'O',
        final_board TEXT NOT NULL DEFAULT '["","","","","","","","",""]',
        winning_line TEXT,
        status TEXT DEFAULT 'PLAYING',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      )
    `, () => {});

    // 5. Move Audit Log
    db.run(`
      CREATE TABLE IF NOT EXISTS tictactoe_moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        move_number INTEGER NOT NULL,
        player_id INTEGER,
        is_bot_move INTEGER DEFAULT 0,
        symbol TEXT NOT NULL,
        cell_index INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, () => {});

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
        bot_cooldown_until DATETIME,
        last_match_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, () => {});

    // Safe Indexes with Error Callbacks (Will never crash PM2)
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_matches_p1 ON tictactoe_matches(player1_id);`, (err) => {});
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_matches_p2 ON tictactoe_matches(player2_id);`, (err) => {});
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_matches_status ON tictactoe_matches(status);`, (err) => {});
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_rounds_match ON tictactoe_rounds(match_id);`, (err) => {});
    db.run(`CREATE INDEX IF NOT EXISTS idx_ttt_moves_match_round ON tictactoe_moves(match_id, round_number);`, (err) => {});

    console.log('[DB SUCCESS] Tic Tac Toe Tables Verified & Safe.');
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
EOF
