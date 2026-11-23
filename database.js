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
function addColumnIfNotExists(table, column, type, defaultValue, onReady) {
  db.all(`PRAGMA table_info(${table})`, (err, columns) => {
    if (!err && columns) {
      const exists = columns.some((col) => col.name === column);
      if (!exists) {
        let sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`;
        if (defaultValue !== undefined && defaultValue !== null) {
          sql += ` DEFAULT ${defaultValue}`;
        }
        db.run(sql, () => {
          if (typeof onReady === 'function') onReady();
        });
      } else if (typeof onReady === 'function') {
        onReady();
      }
    }
  });
}

function getNextMondayUtcIso(fromDate = new Date()) {
  const d = new Date(fromDate);
  const day = d.getUTCDay();
  const daysUntilMonday = (8 - day) % 7 || 7;
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + daysUntilMonday,
      0,
      0,
      0,
      0
    )
  ).toISOString();
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
  // 2. Core Games Table
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

  // ==========================================
  // 3. Users Table
  // ==========================================
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
      weekly_coins INTEGER DEFAULT 0,
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
      ban_reason TEXT DEFAULT NULL,
      creator_badge_enabled INTEGER DEFAULT 0,
      creator_badge_id INTEGER DEFAULT NULL,
      last_withdrawal_at DATETIME DEFAULT NULL,
      last_active_at DATETIME DEFAULT NULL,
      fcm_token TEXT DEFAULT NULL,
      fcm_updated_at DATETIME DEFAULT NULL,
      registration_ip TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(referred_by_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `, () => {});

  // Column safety migrations for Users
  addColumnIfNotExists('users', 'total_coins_earned', 'INTEGER', 100);
  addColumnIfNotExists('users', 'weekly_coins', 'INTEGER', 0, () => {
    db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_sync_weekly_coins
      AFTER UPDATE OF total_coins_earned ON users
      WHEN NEW.total_coins_earned > COALESCE(OLD.total_coins_earned, 0)
      BEGIN
        UPDATE users
        SET weekly_coins = COALESCE(weekly_coins, 0) + (NEW.total_coins_earned - COALESCE(OLD.total_coins_earned, 0))
        WHERE id = NEW.id;
      END;
    `, () => {});

    db.run(`CREATE INDEX IF NOT EXISTS idx_users_weekly_coins ON users(weekly_coins DESC);`, () => {});
  });
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
  addColumnIfNotExists('users', 'ban_reason', 'TEXT', 'NULL');
  addColumnIfNotExists('users', 'creator_badge_enabled', 'INTEGER', 0);
  addColumnIfNotExists('users', 'creator_badge_id', 'INTEGER', 'NULL');
  addColumnIfNotExists('users', 'last_withdrawal_at', 'DATETIME', 'NULL');
  addColumnIfNotExists('users', 'last_active_at', 'DATETIME', 'NULL');
  addColumnIfNotExists('users', 'fcm_token', 'TEXT', 'NULL');
  addColumnIfNotExists('users', 'fcm_updated_at', 'DATETIME', 'NULL');
  addColumnIfNotExists('users', 'registration_ip', 'TEXT', 'NULL');

  // ==========================================
  // 4. Leaderboard & Badges
  // ==========================================
  db.run(`
    CREATE TABLE IF NOT EXISTS leaderboard_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_ending TEXT NOT NULL,
      rank INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      weekly_coins INTEGER NOT NULL,
      reward_coins INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

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

  // ==========================================
  // 5. Game Sessions & Transactions
  // ==========================================
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
      processed_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  addColumnIfNotExists('withdrawals', 'npr_amount', 'REAL', 0.0);
  addColumnIfNotExists('withdrawals', 'inr_amount', 'REAL', 0.0);
  addColumnIfNotExists('withdrawals', 'processed_at', 'DATETIME', 'NULL');

  // ==========================================
  // 6. Global Configuration
  // ==========================================
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
  db.run(
    `INSERT OR IGNORE INTO app_config (key, value) VALUES ('leaderboard_next_reset_at', ?)`,
    [getNextMondayUtcIso()],
    () => {}
  );

  const defaultGateways = JSON.stringify([
    { id: "eSewa", name: "eSewa (NPR)", icon: "🟢", min: 5000, currency: "NPR", label: "eSewa Mobile Number", hint: "98XXXXXXXX" },
    { id: "Khalti", name: "Khalti (NPR)", icon: "🟣", min: 5000, currency: "NPR", label: "Khalti Mobile Number", hint: "98XXXXXXXX" },
    { id: "UPI", name: "UPI / Paytm (INR)", icon: "🇮🇳", min: 5000, currency: "INR", label: "UPI ID / Number", hint: "user@upi" },
    { id: "PayPal", name: "PayPal (USD)", icon: "🅿️", min: 5000, currency: "USD", label: "PayPal Email Address", hint: "user@example.com" },
    { id: "USDT", name: "USDT (TRC20)", icon: "💲", min: 10000, currency: "USD", label: "TRC20 Wallet Address", hint: "T..." }
  ]);
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('payment_methods', ?)`, [defaultGateways], () => {});

  // Default High or Low Engine Configuration
  const defaultHighLowConfig = JSON.stringify({
    entryCost: 500,
    startingReward: 500,
    multiplier: 2.0,
    minWinsForClaim: 3,
    aceRule: 'HIGHEST', // 'HIGHEST' or 'LOWEST'
    tieRule: 'LOSE',    // 'LOSE', 'PUSH', or 'WIN'
    isEnabled: true,
    version: 1
  });
  db.run(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('high_low_config', ?)`, [defaultHighLowConfig], () => {});

  // ==========================================
  // 7. Admins & Logs
  // ==========================================
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      full_name TEXT,
      password_hash TEXT NOT NULL,
      is_online INTEGER DEFAULT 0,
      online_since TEXT DEFAULT NULL,
      last_heartbeat_at TEXT DEFAULT NULL,
      last_login_at TEXT DEFAULT NULL,
      total_online_seconds INTEGER DEFAULT 0,
      daily_online_seconds INTEGER DEFAULT 0,
      daily_online_date TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    addColumnIfNotExists('admins', 'full_name', 'TEXT', 'NULL');
    addColumnIfNotExists('admins', 'is_online', 'INTEGER', 0);
    addColumnIfNotExists('admins', 'online_since', 'TEXT', 'NULL');
    addColumnIfNotExists('admins', 'last_heartbeat_at', 'TEXT', 'NULL');
    addColumnIfNotExists('admins', 'last_login_at', 'TEXT', 'NULL');
    addColumnIfNotExists('admins', 'total_online_seconds', 'INTEGER', 0);
    addColumnIfNotExists('admins', 'daily_online_seconds', 'INTEGER', 0);
    addColumnIfNotExists('admins', 'daily_online_date', 'TEXT', "''");

    db.get('SELECT COUNT(*) as count FROM admins', (err, row) => {
      if (row && row.count === 0) {
        const defaultUser = 'admin';
        const defaultPass = 'admin123';
        const hash = bcrypt.hashSync(defaultPass, 10);
        db.run(
          'INSERT INTO admins (username, full_name, password_hash) VALUES (?, ?, ?)',
          [defaultUser, 'Master Admin', hash],
          () => {
            console.log('Default Admin Account Initialized (admin / admin123)');
          }
        );
      }
    });
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS admin_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      admin_username TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target_type TEXT DEFAULT '',
      target_id TEXT DEFAULT '',
      target_label TEXT DEFAULT '',
      details TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    db.run(`CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_activity_logs(id DESC);`, () => {});
    db.run(`CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_activity_logs(admin_username, id DESC);`, () => {});
  });

  // ==========================================
  // 8. Spin, Tasks & Mini-Games
  // ==========================================
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
  // 9. ARENA POT LOTTERY SYSTEM TABLES
  // ==========================================
  db.run(`
    CREATE TABLE IF NOT EXISTS arena_pot_lotteries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      prize_title TEXT NOT NULL,
      prize_image TEXT DEFAULT '',
      description TEXT DEFAULT '',
      total_seats INTEGER NOT NULL,
      sold_seats INTEGER DEFAULT 0,
      ticket_price INTEGER NOT NULL DEFAULT 50,
      user_ticket_limit INTEGER DEFAULT 0,
      start_time DATETIME NOT NULL,
      end_time DATETIME NOT NULL,
      winner_count INTEGER DEFAULT 1,
      status TEXT CHECK(status IN ('DRAFT', 'UPCOMING', 'ACTIVE', 'PAUSED', 'CLOSED', 'RESULTS_PUBLISHED', 'COMPLETED', 'CANCELLED')) DEFAULT 'DRAFT',
      is_featured INTEGER DEFAULT 0,
      created_by INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS arena_pot_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lottery_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      ticket_number INTEGER NOT NULL,
      coin_price INTEGER NOT NULL,
      purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(lottery_id) REFERENCES arena_pot_lotteries(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(lottery_id, ticket_number)
    )
  `, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS arena_pot_prizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lottery_id INTEGER NOT NULL,
      winner_position INTEGER NOT NULL,
      prize_type TEXT CHECK(prize_type IN ('COINS', 'PHYSICAL', 'CUSTOM')) DEFAULT 'COINS',
      prize_amount INTEGER DEFAULT 0,
      prize_title TEXT NOT NULL,
      delivery_status TEXT DEFAULT 'PENDING',
      FOREIGN KEY(lottery_id) REFERENCES arena_pot_lotteries(id) ON DELETE CASCADE
    )
  `, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS arena_pot_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lottery_id INTEGER NOT NULL,
      ticket_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      winner_position INTEGER NOT NULL,
      prize_id INTEGER,
      prize_title TEXT NOT NULL,
      prize_type TEXT NOT NULL,
      prize_amount INTEGER DEFAULT 0,
      published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(lottery_id) REFERENCES arena_pot_lotteries(id) ON DELETE CASCADE,
      FOREIGN KEY(ticket_id) REFERENCES arena_pot_tickets(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(prize_id) REFERENCES arena_pot_prizes(id) ON DELETE SET NULL
    )
  `, () => {});

  db.run(`CREATE INDEX IF NOT EXISTS idx_arena_pot_lotteries_status ON arena_pot_lotteries(status);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_arena_pot_tickets_lottery_user ON arena_pot_tickets(lottery_id, user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_arena_pot_tickets_user ON arena_pot_tickets(user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_arena_pot_winners_lottery ON arena_pot_winners(lottery_id);`, () => {});

  // ==========================================
  // 10. HIGH OR LOW CARD GAME TABLES
  // ==========================================
  db.run(`
    CREATE TABLE IF NOT EXISTS high_low_games (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      entry_cost INTEGER NOT NULL DEFAULT 500,
      starting_card TEXT NOT NULL,
      current_card TEXT NOT NULL,
      remaining_deck TEXT NOT NULL,
      consecutive_wins INTEGER DEFAULT 0,
      potential_reward INTEGER DEFAULT 500,
      claimed_reward INTEGER DEFAULT 0,
      status TEXT CHECK(status IN ('ACTIVE', 'CLAIMED', 'LOST', 'CANCELLED')) DEFAULT 'ACTIVE',
      config_version INTEGER DEFAULT 1,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS high_low_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      current_card TEXT NOT NULL,
      prediction TEXT CHECK(prediction IN ('HIGHER', 'LOWER')) NOT NULL,
      revealed_card TEXT NOT NULL,
      result TEXT CHECK(result IN ('WIN', 'LOSS', 'PUSH')) NOT NULL,
      reward_before INTEGER NOT NULL,
      reward_after INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(game_id) REFERENCES high_low_games(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS high_low_user_stats (
      user_id INTEGER PRIMARY KEY,
      total_games INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      total_losses INTEGER DEFAULT 0,
      total_coins_spent INTEGER DEFAULT 0,
      total_coins_rewarded INTEGER DEFAULT 0,
      highest_streak INTEGER DEFAULT 0,
      highest_reward_claimed INTEGER DEFAULT 0,
      total_potential_lost INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS high_low_target_users (
      user_id INTEGER PRIMARY KEY,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `, () => {});

  db.run(`CREATE INDEX IF NOT EXISTS idx_hl_games_user_status ON high_low_games(user_id, status);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_hl_pred_game ON high_low_predictions(game_id);`, () => {});

  // ==========================================
  // 11. Safe Standard Game Initializers
  // ==========================================
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('dot_connect', 'Dot Connect', 1000, 10.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('spin_wheel', 'Spin Wheel', 5000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('mines', 'Mines Puzzle', 5000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('color_tap', 'Color Tap Challenge', 5000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('memory_match', 'Memory Match', 5000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('memoryMatch', 'Memory Match', 5000, 1.0, 1)`, () => {});
  db.run(`INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES ('high_low', 'High or Low', 500000, 1.0, 1)`, () => {});

  // Safe General Performance Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_referral ON users(referral_code);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);`, () => {});
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_game_data_unique ON user_game_data(user_id, game_id);`, () => {});
});

module.exports = db;
