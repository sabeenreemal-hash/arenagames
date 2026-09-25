// backend/database.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'arena_games.db');
const db = new sqlite3.Database(dbPath);

// Safe helper to add new columns to existing tables without breaking
function addColumnIfNotExists(table, column, type, defaultValue) {
  db.all(`PRAGMA table_info(${table})`, (err, columns) => {
    if (!err && columns) {
      const exists = columns.some((col) => col.name === column);
      if (!exists) {
        let sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`;
        if (defaultValue !== undefined) {
          sql += ` DEFAULT ${defaultValue}`;
        }
        db.run(sql, (alterErr) => {
          if (alterErr) {
            console.error(`Error adding ${column} to ${table}:`, alterErr.message);
          }
        });
      }
    }
  });
}

db.serialize(() => {
  // ==========================================
  // 1. VPS & SQLite Concurrency Optimizations
  // ==========================================
  db.run('PRAGMA journal_mode = WAL;');         // Allows simultaneous reads/writes
  db.run('PRAGMA synchronous = NORMAL;');        // Faster disk writes, safe in WAL mode
  db.run('PRAGMA busy_timeout = 5000;');         // Wait up to 5 seconds before locking error
  db.run('PRAGMA foreign_keys = ON;');           // Enforce relational integrity
  db.run('PRAGMA cache_size = -16000;');         // 16MB in-memory SQLite page cache

  // ==========================================
  // 2. Schema Definitions (Tables Created First)
  // ==========================================

  // Games Configuration Table
  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      max_daily_reward INTEGER DEFAULT 1000,
      reward_multiplier REAL DEFAULT 1.0,
      is_enabled INTEGER DEFAULT 1
    )
  `);

  // Users Table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by_id INTEGER,
      balance INTEGER DEFAULT 100,
      total_coins_earned INTEGER DEFAULT 100,
      current_streak INTEGER DEFAULT 0,
      highest_streak INTEGER DEFAULT 0,
      last_check_in_date TEXT DEFAULT '',
      last_streak_date TEXT DEFAULT '',
      eligible_daily_coins INTEGER DEFAULT 0,
      last_eligible_date TEXT DEFAULT '',
      current_stone TEXT DEFAULT 'NONE',
      highest_stone TEXT DEFAULT 'NONE',
      whatsapp_claimed INTEGER DEFAULT 0,
      telegram_claimed INTEGER DEFAULT 0,
      tiktok_claimed INTEGER DEFAULT 0,
      youtube_claimed INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      creator_badge_enabled INTEGER DEFAULT 0,
      creator_badge_id INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(referred_by_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Column safety migrations
  addColumnIfNotExists('users', 'total_coins_earned', 'INTEGER', 100);
  addColumnIfNotExists('users', 'current_streak', 'INTEGER', 0);
  addColumnIfNotExists('users', 'highest_streak', 'INTEGER', 0);
  addColumnIfNotExists('users', 'last_check_in_date', 'TEXT', "''");
  addColumnIfNotExists('users', 'last_streak_date', 'TEXT', "''");
  addColumnIfNotExists('users', 'eligible_daily_coins', 'INTEGER', 0);
  addColumnIfNotExists('users', 'last_eligible_date', 'TEXT', "''");
  addColumnIfNotExists('users', 'current_stone', 'TEXT', "'NONE'");
  addColumnIfNotExists('users', 'highest_stone', 'TEXT', "'NONE'");
  addColumnIfNotExists('users', 'whatsapp_claimed', 'INTEGER', 0);
  addColumnIfNotExists('users', 'telegram_claimed', 'INTEGER', 0);
  addColumnIfNotExists('users', 'tiktok_claimed', 'INTEGER', 0);
  addColumnIfNotExists('users', 'youtube_claimed', 'INTEGER', 0);
  addColumnIfNotExists('users', 'creator_badge_enabled', 'INTEGER', 0);
  addColumnIfNotExists('users', 'creator_badge_id', 'INTEGER', 'NULL');

  // Badges Table
  db.run(`
    CREATE TABLE IF NOT EXISTS badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon_url TEXT,
      is_enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO badges (id, name, icon_url, is_enabled) 
    VALUES (1, 'Official Creator', 'https://cdn-icons-png.flaticon.com/512/7653/7653930.png', 1)
  `);

  // Creator Rewards Table
  db.run(`
    CREATE TABLE IF NOT EXISTS creator_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      coin_amount INTEGER NOT NULL,
      month TEXT NOT NULL,
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Active Game Sessions Table
  db.run(`
    CREATE TABLE IF NOT EXISTS game_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      game_id TEXT NOT NULL,
      status TEXT CHECK(status IN ('STARTED', 'COMPLETED', 'EXPIRED')) DEFAULT 'STARTED',
      start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_time DATETIME,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(game_id) REFERENCES games(id)
    )
  `);

  // Transactions Table
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reference_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Withdrawals Table
  db.run(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      account_info TEXT NOT NULL,
      coin_amount INTEGER NOT NULL,
      usd_amount REAL NOT NULL,
      status TEXT CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED')) DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Global Configuration Table
  db.run(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('latest_version', '1.0.0')`);
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('min_version', '1.0.0')`);
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('update_url', 'https://play.google.com/store')`);
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('force_update', 'false')`);
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('payment_methods', '[{"id":"eSewa","min":10000,"rate":1000},{"id":"Khalti","min":10000,"rate":1000}]')`);

  // Admins Table
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    )
  `, () => {
    db.get('SELECT COUNT(*) as count FROM admins', (err, row) => {
      if (row && row.count === 0) {
        const defaultUser = 'admin';
        const defaultPass = 'admin123';
        const hash = bcrypt.hashSync(defaultPass, 10);

        db.run(
          'INSERT INTO admins (username, password_hash) VALUES (?, ?)',
          [defaultUser, hash],
          (err) => {
            if (!err) {
              console.log('Default Admin Account Initialized (admin / admin123)');
            }
          }
        );
      }
    });
  });

  // ==========================================
  // 3. Ensure Allowed Games Exist (Arrow Puzzle + Your Other 2 Games)
  // ==========================================
  
  // Arrow Puzzle
  db.run(`
    INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) 
    VALUES ('arrow_puzzle', 'Arrow Puzzle', 1000, 10.0, 1)
  `);

  // Other Game 2 (change ID & name to match your app if needed)
  db.run(`
    INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) 
    VALUES ('game_3', 'Game 3', 1000, 10.0, 1)
  `);

  // Other Game 3 (change ID & name to match your app if needed)
  db.run(`
    INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) 
    VALUES ('game_4', 'Game 4', 1000, 10.0, 1)
  `);

  // ==========================================
  // 4. Remove Tic Tac Toe & Word Puzzle Completely
  // ==========================================
  // Clear any existing game sessions for removed games first (to avoid foreign key blocks)
  db.run("DELETE FROM game_sessions WHERE game_id IN ('tictac', 'tictactoe', 'word_puzzle', 'wordpuzzle', 'word');");
  
  // Delete the games from games table
  db.run("DELETE FROM games WHERE id IN ('tictac', 'tictactoe', 'word_puzzle', 'wordpuzzle', 'word');");
  
  // Drop any legacy standalone tables
  db.run("DROP TABLE IF EXISTS word_puzzle;");
  db.run("DROP TABLE IF EXISTS word_puzzles;");
  db.run("DROP TABLE IF EXISTS tictac;");
  db.run("DROP TABLE IF EXISTS tic_tac_toe;");

  // ==========================================
  // 5. Performance Indexes
  // ==========================================
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_referral ON users(referral_code);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_game_sessions_user ON game_sessions(user_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_creator_rewards_user ON creator_rewards(user_id);`);

  // ==========================================
  // 6. One-Time Database User Reset Flag
  // ==========================================
  if (process.env.RESET_DB === 'true') {
    console.log('⚠️ RESET_DB=true detected. Purging all user data...');
    db.run('DELETE FROM game_sessions;');
    db.run('DELETE FROM transactions;');
    db.run('DELETE FROM withdrawals;');
    db.run('DELETE FROM creator_rewards;');
    db.run('DELETE FROM users;');
    db.run("DELETE FROM sqlite_sequence WHERE name IN ('users', 'transactions', 'withdrawals', 'game_sessions', 'creator_rewards');");
    console.log('✅ All users and history successfully wiped clean.');
  }
});

module.exports = db;
