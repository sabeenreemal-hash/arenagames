// backend/ngDatabase.js
const db = require('./database');
const crypto = require('crypto');

// Promisified SQLite helpers
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// Mutex queue to prevent "cannot start a transaction within a transaction" in sqlite3
let txQueue = Promise.resolve();

function runInTransaction(workFn) {
  const next = txQueue.then(async () => {
    await dbRun('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = await workFn({ dbGet, dbAll, dbRun });
      await dbRun('COMMIT');
      return result;
    } catch (err) {
      try {
        await dbRun('ROLLBACK');
      } catch (_) {}
      throw err;
    }
  });

  // Keep queue alive even if one transaction fails
  txQueue = next.catch(() => {});
  return next;
}

const DEFAULT_CONFIG = {
  game_enabled: true,
  match_start_mode: 'AUTO', // 'AUTO' | 'MANUAL'
  min_players: 2,
  max_players: 10,
  entry_fees: [500, 1000, 2000],
  search_timeout_sec: 30, // 10 - 120s
  round_duration_sec: 30,
  starting_countdown_sec: 3,
  bot_filling_enabled: true,
  bot_fill_delay_sec: 10,
  bot_join_interval_sec: 2,
  bot_submit_delay_min_sec: 3,
  bot_submit_delay_max_sec: 15,
  max_available_bots: 20,
  max_bots_per_match: 9,
  allow_leave_before_lock: true,
  refund_on_no_guesses: true,
  sandbox_default_balance: 10000,
  fee_tiers: {
    '2': 10,
    '3': 20,
    '4': 22,
    '5': 25,
    '6': 28,
    '7': 30,
    '8': 35,
    '9': 38,
    '10': 40,
  },
};

const DEFAULT_BOTS = [
  { username: 'NovaBot', avatar: '🤖', strategy: 'RANDOM' },
  { username: 'ApexCalc', avatar: '🦾', strategy: 'MIDDLE' },
  { username: 'ByteRunner', avatar: '⚡', strategy: 'LOW' },
  { username: 'PixelMind', avatar: '🎯', strategy: 'HIGH' },
  { username: 'EchoZero', avatar: '🛸', strategy: 'RANDOM' },
  { username: 'CipherBot', avatar: '🔮', strategy: 'MIDDLE' },
];

let initPromise = null;

function initNumberGuessDb() {
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        await dbRun(`
          INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled)
          VALUES ('number_guess', 'Number Guess Battle', 100000, 1.0, 1)
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS ng_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS ng_bots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            avatar TEXT NOT NULL DEFAULT '🤖',
            is_enabled INTEGER NOT NULL DEFAULT 1,
            strategy TEXT NOT NULL CHECK(strategy IN ('RANDOM','LOW','HIGH','MIDDLE')) DEFAULT 'RANDOM',
            virtual_balance INTEGER NOT NULL DEFAULT 100000,
            matches_played INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS ng_matches (
            id TEXT PRIMARY KEY,
            room_code TEXT NOT NULL,
            is_sandbox INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK(status IN (
              'WAITING','FILLING_BOTS','STARTING','ACTIVE','COMPLETED','CANCELLED','REFUNDED'
            )) DEFAULT 'WAITING',
            entry_fee INTEGER NOT NULL,
            min_players INTEGER NOT NULL DEFAULT 2,
            max_players INTEGER NOT NULL DEFAULT 10,
            secret_number INTEGER DEFAULT NULL,
            secret_generated_at TEXT DEFAULT NULL,
            secret_mode TEXT NOT NULL DEFAULT 'AUTO',
            fee_percent INTEGER NOT NULL DEFAULT 0,
            winner_share_percent INTEGER NOT NULL DEFAULT 0,
            total_pool INTEGER NOT NULL DEFAULT 0,
            platform_fee_coins INTEGER NOT NULL DEFAULT 0,
            prize_pool_coins INTEGER NOT NULL DEFAULT 0,
            real_entry_coins INTEGER NOT NULL DEFAULT 0,
            real_prize_coins INTEGER NOT NULL DEFAULT 0,
            real_refund_coins INTEGER NOT NULL DEFAULT 0,
            bot_fill_at TEXT DEFAULT NULL,
            next_bot_at TEXT DEFAULT NULL,
            search_deadline_at TEXT NOT NULL,
            starting_at TEXT DEFAULT NULL,
            round_deadline_at TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            started_at TEXT DEFAULT NULL,
            ended_at TEXT DEFAULT NULL,
            cancel_reason TEXT DEFAULT NULL
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS ng_match_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id TEXT NOT NULL,
            participant_type TEXT NOT NULL CHECK(participant_type IN ('HUMAN','BOT','SANDBOX_SIM')),
            user_id INTEGER DEFAULT NULL,
            bot_id INTEGER DEFAULT NULL,
            sandbox_account_id INTEGER DEFAULT NULL,
            username TEXT NOT NULL,
            avatar TEXT NOT NULL DEFAULT '👤',
            entry_paid INTEGER NOT NULL DEFAULT 0,
            guess INTEGER DEFAULT NULL,
            guess_submitted_at TEXT DEFAULT NULL,
            scheduled_bot_submit_at TEXT DEFAULT NULL,
            diff INTEGER DEFAULT NULL,
            is_winner INTEGER NOT NULL DEFAULT 0,
            payout_coins INTEGER NOT NULL DEFAULT 0,
            refunded INTEGER NOT NULL DEFAULT 0,
            joined_at TEXT NOT NULL,
            FOREIGN KEY(match_id) REFERENCES ng_matches(id) ON DELETE CASCADE
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS ng_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            idempotency_key TEXT UNIQUE NOT NULL,
            match_id TEXT DEFAULT NULL,
            is_sandbox INTEGER NOT NULL DEFAULT 0,
            participant_type TEXT NOT NULL DEFAULT 'SYSTEM',
            user_id INTEGER DEFAULT NULL,
            bot_id INTEGER DEFAULT NULL,
            sandbox_account_id INTEGER DEFAULT NULL,
            tx_type TEXT NOT NULL CHECK(tx_type IN (
              'MATCH_ENTRY','MATCH_WIN','MATCH_REFUND','PLATFORM_FEE',
              'BOT_VIRTUAL_REWARD','TEST_COIN_ADD','TEST_COIN_DEDUCT'
            )),
            amount INTEGER NOT NULL,
            balance_after INTEGER DEFAULT NULL,
            note TEXT DEFAULT '',
            created_at TEXT NOT NULL
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS ng_player_flags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            flag_type TEXT NOT NULL DEFAULT 'SUSPICIOUS',
            is_restricted INTEGER NOT NULL DEFAULT 0,
            reason TEXT NOT NULL,
            admin_username TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            resolved_at TEXT DEFAULT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS ng_sandbox_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            avatar TEXT NOT NULL DEFAULT '🧪',
            balance INTEGER NOT NULL DEFAULT 10000,
            matches_played INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          )
        `);

        await dbRun(`
          CREATE TABLE IF NOT EXISTS ng_admin_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER DEFAULT NULL,
            admin_username TEXT NOT NULL,
            action_type TEXT NOT NULL,
            target_type TEXT DEFAULT '',
            target_id TEXT DEFAULT '',
            details TEXT DEFAULT '',
            created_at TEXT NOT NULL
          )
        `);

        await dbRun(`CREATE INDEX IF NOT EXISTS idx_ng_matches_status ON ng_matches(status, is_sandbox, entry_fee);`);
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_ng_matches_created ON ng_matches(created_at DESC);`);
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_ng_part_match ON ng_match_participants(match_id);`);
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_ng_part_user ON ng_match_participants(user_id, match_id);`);
        await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ng_part_unique_human ON ng_match_participants(match_id, user_id) WHERE user_id IS NOT NULL;`);
        await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ng_part_unique_bot ON ng_match_participants(match_id, bot_id) WHERE bot_id IS NOT NULL;`);
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_ng_ledger_created ON ng_ledger(created_at DESC);`);
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_ng_ledger_user ON ng_ledger(user_id, created_at DESC);`);
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_ng_flags_user ON ng_player_flags(user_id, is_active);`);

        const nowIso = new Date().toISOString();
        for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
          await dbRun(
            `INSERT OR IGNORE INTO ng_config (key, value, updated_at) VALUES (?, ?, ?)`,
            [k, JSON.stringify(v), nowIso]
          );
        }

        const botCountRow = await dbGet(`SELECT COUNT(*) AS cnt FROM ng_bots`);
        if (!botCountRow || botCountRow.cnt === 0) {
          for (const b of DEFAULT_BOTS) {
            await dbRun(
              `INSERT OR IGNORE INTO ng_bots (username, avatar, is_enabled, strategy, virtual_balance, created_at)
               VALUES (?, ?, 1, ?, 100000, ?)`,
              [b.username, b.avatar, b.strategy, nowIso]
            );
          }
        }

        const sbCountRow = await dbGet(`SELECT COUNT(*) AS cnt FROM ng_sandbox_accounts`);
        if (!sbCountRow || sbCountRow.cnt === 0) {
          for (let i = 1; i <= 4; i++) {
            await dbRun(
              `INSERT OR IGNORE INTO ng_sandbox_accounts (username, avatar, balance, created_at)
               VALUES (?, '🧪', 10000, ?)`,
              [`TestPlayer_${i}`, nowIso]
            );
          }
        }

        console.log('[NG DB] Number Guess Battle schema ready.');
        resolve();
      } catch (err) {
        console.error('[NG DB INIT ERROR]:', err);
        reject(err);
      }
    });
  });

  return initPromise;
}

async function getConfigMap() {
  const rows = await dbAll(`SELECT key, value FROM ng_config`);
  const cfg = { ...DEFAULT_CONFIG };
  for (const row of rows) {
    try {
      cfg[row.key] = JSON.parse(row.value);
    } catch (_) {
      cfg[row.key] = row.value;
    }
  }
  return cfg;
}

async function saveConfigKeys(updates) {
  const nowIso = new Date().toISOString();
  await runInTransaction(async ({ dbRun: txRun }) => {
    for (const [k, v] of Object.entries(updates)) {
      if (!(k in DEFAULT_CONFIG)) continue;
      await txRun(
        `INSERT INTO ng_config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [k, JSON.stringify(v), nowIso]
      );
    }
  });
  return getConfigMap();
}

async function logNgAdminAction(admin, actionType, targetType = '', targetId = '', details = '') {
  const nowIso = new Date().toISOString();
  const adminId = admin?.id || null;
  const adminUsername = admin?.username || 'admin';
  const detailStr = typeof details === 'string' ? details : JSON.stringify(details);

  try {
    await dbRun(
      `INSERT INTO ng_admin_logs (admin_id, admin_username, action_type, target_type, target_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [adminId, adminUsername, actionType, targetType, String(targetId || ''), detailStr, nowIso]
    );
    await dbRun(
      `INSERT INTO admin_activity_logs (admin_id, admin_username, action_type, target_type, target_id, target_label, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [adminId, adminUsername, `NG_${actionType}`, targetType, String(targetId || ''), 'Number Guess', detailStr]
    ).catch(() => {});
  } catch (err) {
    console.error('[NG ADMIN LOG ERROR]:', err.message);
  }
}

function generateRoomCode() {
  return 'NG-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = {
  db,
  dbGet,
  dbAll,
  dbRun,
  runInTransaction,
  initNumberGuessDb,
  getConfigMap,
  saveConfigKeys,
  logNgAdminAction,
  generateRoomCode,
  DEFAULT_CONFIG,
};
