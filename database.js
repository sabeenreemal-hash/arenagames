// backend/database.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'arena_games.db');
const db = new sqlite3.Database(dbPath);

// Global safety net: Catches any database error without crashing the server
db.on('error', (err) => {
  console.error('[Database Handled Error]:', err.message);
});

// Safe helper to add new columns to existing tables without breaking
function addColumnIfNotExists(table, column, type, defaultValue) {
  db.all(`PRAGMA table_info(${table})`, (err, columns) => {
    if (!err && columns) {
      const exists = columns.some((col) => col.name === column);
      if (!exists) {
        let sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`;
        if (defaultValue !== undefined && defaultValue !== null) {
          sql += ` DEFAULT ${defaultValue}`;
        }
        db.run(sql, () => {});
      }
    }
  });
}

db.serialize(() => {
  // ==========================================
  // 1. VPS & SQLite Concurrency Optimizations
  // ==========================================
  db.run('PRAGMA journal_mode = WAL;', () => {});
  db.run('PRAGMA synchronous = NORMAL;', () => {});
  db.run('PRAGMA busy_timeout = 5000;', () => {});
  db.run('PRAGMA foreign_keys = ON;', () => {});
  db.run('PRAGMA cache_size = -16000;', () => {});

  // ==========================================
  // 2. Schema Definitions (Tables Created First)
  // ==========================================
  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      max_daily_reward INTEGER DEFAULT 1000,
      reward_multiplier REAL DEFAULT 1.0,
      is_enabled INTEGER DEFAULT 1
    )
  `, () => {});

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
      youtube_claimed INTEGER DEFAULT 0,
      playstore_claimed INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      creator_badge_enabled INTEGER DEFAULT 0,
      creator_badge_id INTEGER DEFAULT NULL,
      last_withdrawal_at DATETIME DEFAULT NULL,
      last_active_at DATETIME DEFAULT NULL,
      registration_ip TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(referred_by_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `, () => {});

  // Column safety migrations for Users
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
  addColumnIfNotExists('users', 'youtube_claimed', 'INTEGER', 0);
  addColumnIfNotExists('users', 'playstore_claimed', 'INTEGER', 0);
  addColumnIfNotExists('users', 'creator_badge_enabled', 'INTEGER', 0);
  addColumnIfNotExists('users', 'creator_badge_id', 'INTEGER', 'NULL');
  addColumnIfNotExists('users', 'last_withdrawal_at', 'DATETIME', 'NULL');
  addColumnIfNotExists('users', 'last_active_at', 'DATETIME', 'NULL');
  addColumnIfNotExists('users', 'registration_ip', 'TEXT', 'NULL');

  // Badges Table
  db.run(`
    CREATE TABLE IF NOT EXISTS badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon_url TEXT,
      is_enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {});

  db.run(`
    INSERT OR IGNORE INTO badges (id, name, icon_url, is_enabled) 
    VALUES (1, 'Official Creator', 'https://cdn-icons-png.flaticon.com/512/7653/7653930.png', 1)
  `, () => {});

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
  `, () => {});

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
  `, () => {});

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
  `, () => {});

  // Withdrawals Table
  db.run(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      account_info TEXT NOT NULL,
      coin_amount INTEGER NOT NULL,
      usd_amount REAL NOT NULL,
      npr_amount REAL DEFAULT 0.0,
      inr_amount REAL DEFAULT 0.0,
      status TEXT CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED')) DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  addColumnIfNotExists('withdrawals', 'npr_amount', 'REAL', 0.0);
  addColumnIfNotExists('withdrawals', 'inr_amount', 'REAL', 0.0);

  // Global Configuration Table
  db.run(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `, () => {});

  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('latest_version', '1.0.0')`, () => {});
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('min_version', '1.0.0')`, () => {});
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('update_url', 'https://play.google.com/store')`, () => {});
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('force_update', 'false')`, () => {});

  const defaultGateways = JSON.stringify([
    { id: "eSewa", name: "eSewa (NPR)", icon: "🟢", min: 5000, currency: "NPR", label: "eSewa Mobile Number", hint: "98XXXXXXXX" },
    { id: "Khalti", name: "Khalti (NPR)", icon: "🟣", min: 5000, currency: "NPR", label: "Khalti Mobile Number", hint: "98XXXXXXXX" },
    { id: "UPI", name: "UPI / Paytm (INR)", icon: "🇮🇳", min: 5000, currency: "INR", label: "UPI ID / Number", hint: "user@upi" },
    { id: "PayPal", name: "PayPal (USD)", icon: "🅿️", min: 5000, currency: "USD", label: "PayPal Email Address", hint: "user@example.com" },
    { id: "USDT", name: "USDT (TRC20)", icon: "💲", min: 10000, currency: "USD", label: "TRC20 Wallet Address", hint: "T..." }
  ]);
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('payment_methods', ?)`, [defaultGateways], () => {});

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
          () => {
            console.log('Default Admin Account Initialized (admin / admin123)');
          }
        );
      }
    });
  });

  // Spin Wheel Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS user_spin_state (
      user_id INTEGER NOT NULL,
      spin_type TEXT NOT NULL,
      daily_date TEXT NOT NULL,
      daily_spins_used INTEGER DEFAULT 0,
      cooldown_until DATETIME DEFAULT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, spin_type),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS spin_transactions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      spin_type TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      reward_type TEXT NOT NULL,
      base_coins INTEGER DEFAULT 0,
      multiplier INTEGER DEFAULT 1,
      final_coins INTEGER DEFAULT 0,
      is_2x_claimed INTEGER DEFAULT 0,
      is_try_again_claimed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'COMPLETED',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  // Tasks Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      reward_coins INTEGER NOT NULL DEFAULT 50,
      instructions TEXT NOT NULL,
      proof_type TEXT CHECK(proof_type IN ('text', 'screenshot', 'both')) DEFAULT 'both',
      action_url TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS task_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      proof_text TEXT DEFAULT '',
      screenshot_path TEXT DEFAULT NULL,
      status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      rejection_reason TEXT DEFAULT '',
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME DEFAULT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  addColumnIfNotExists('tasks', 'action_url', 'TEXT', "''");
  addColumnIfNotExists('tasks', 'is_active', 'INTEGER', 1);
  addColumnIfNotExists('task_submissions', 'proof_text', 'TEXT', "''");
  addColumnIfNotExists('task_submissions', 'rejection_reason', 'TEXT', "''");

  // Tic-Tac-Toe Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS tictactoe_matches (
      id TEXT PRIMARY KEY,
      player_x_id INTEGER NOT NULL,
      player_o_id INTEGER NOT NULL,
      player_x_name TEXT NOT NULL,
      player_o_name TEXT NOT NULL,
      current_turn INTEGER NOT NULL,
      board TEXT NOT NULL DEFAULT '["","","","","","","","",""]',
      status TEXT CHECK(status IN ('IN_PROGRESS', 'COMPLETED', 'DRAW', 'ABANDONED')) DEFAULT 'IN_PROGRESS',
      winner_id INTEGER DEFAULT NULL,
      winning_line TEXT DEFAULT NULL,
      pot_amount INTEGER DEFAULT 200,
      last_move_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(player_x_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(player_o_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  // Rock Paper Scissors Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS rps_matches (
      id TEXT PRIMARY KEY,
      player_a_id INTEGER NOT NULL,
      player_b_id INTEGER NOT NULL,
      player_a_name TEXT NOT NULL,
      player_b_name TEXT NOT NULL,
      player_a_score INTEGER DEFAULT 0,
      player_b_score INTEGER DEFAULT 0,
      current_round INTEGER DEFAULT 1,
      player_a_choice TEXT DEFAULT NULL,
      player_b_choice TEXT DEFAULT NULL,
      round_start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_round_result TEXT DEFAULT NULL,
      status TEXT CHECK(status IN ('IN_PROGRESS', 'ROUND_REVEAL', 'COMPLETED', 'DRAW', 'ABANDONED')) DEFAULT 'IN_PROGRESS',
      winner_id INTEGER DEFAULT NULL,
      pot_amount INTEGER DEFAULT 200,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(player_a_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(player_b_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  // ==========================================
  // Universal Cloud Game Progress Table
  // (Used by routes/games.js for all games)
  // ==========================================
  db.run(`
    CREATE TABLE IF NOT EXISTS user_game_data (
      user_id INTEGER NOT NULL,
      game_id TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      data TEXT DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, game_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(game_id) REFERENCES games(id)
    )
  `, () => {});

  // ==========================================
  // Register Allowed Games in Database
  // ==========================================
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('dot_connect', 'Dot Connect', 1000, 10.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('spin_wheel', 'Spin Wheel', 5000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('tictactoe_1v1', '1v1 Tic-Tac-Toe', 50000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('rps_1v1', '1v1 Rock Paper Scissors', 50000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('mines', 'Mines Puzzle', 1000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('color_tap', 'Color Tap Challenge', 1000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('memory_match', 'Memory Match', 1000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('memoryMatch', 'Memory Match', 1000, 1.0, 1)`, () => {});

  // Cleanup Unused Legacy Games
  db.run("DELETE FROM game_sessions WHERE game_id IN ('word_puzzle', 'wordpuzzle', 'word', 'arrow_puzzle', 'ball_sort', 'coin_sprint');", () => {});
  db.run("DELETE FROM games WHERE id IN ('word_puzzle', 'wordpuzzle', 'word', 'arrow_puzzle', 'ball_sort', 'coin_sprint');", () => {});
  db.run("DROP TABLE IF EXISTS word_puzzle;", () => {});
  db.run("DROP TABLE IF EXISTS word_puzzles;", () => {});

  // Safe Performance Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_referral ON users(referral_code);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_game_sessions_user ON game_sessions(user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_creator_rewards_user ON creator_rewards(user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_spin_state_user ON user_spin_state(user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_spin_transactions_user ON spin_transactions(user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_active);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_task_submissions_user ON task_submissions(user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_task_submissions_task ON task_submissions(task_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_task_submissions_status ON task_submissions(status);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_game_data ON user_game_data(user_id, game_id);`, () => {});

  // Backfill last_active_at safely
  db.run(`UPDATE users SET last_active_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE last_active_at IS NULL;`, () => {});
});

module.exports = db;
