// backend/server.js

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const crypto = require('crypto'); // Built-in Node.js crypto module for MD5 & SHA256
const db = require('./database');

// Optional JWT loader with safe fallback
let jwt;
try {
  jwt = require('jsonwebtoken');
} catch (e) {
  jwt = null;
}

// Import Router Files
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const gamesRoutes = require('./routes/games');
const adminRoutes = require('./routes/admin');
const rewardsRouter = require('./routes/rewards');
const referralRoutes = require('./routes/referral');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// 1. CREDENTIALS & SECURITY KEYS
// ============================================================
const ADSWED_SECRET_KEY = 'Av9Bb6Cz2Nh2So3';
const TIMEWALL_PLACEMENT_ID = '21f38a8af19d2013';

// Official TimeWall Server IPs
const TIMEWALL_IPS = ['18.156.132.55', '51.81.120.73', '142.111.248.18'];

// ============================================================
// 2. DATABASE TABLES INITIALIZATION
// ============================================================
// AdswedMedia Deduplication Table
db.run(`
  CREATE TABLE IF NOT EXISTS adswed_transactions (
    trans_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    reward REAL NOT NULL,
    status INTEGER NOT NULL,
    payout REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// TimeWall Deduplication Table
db.run(`
  CREATE TABLE IF NOT EXISTS timewall_transactions (
    tx_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    currency REAL NOT NULL,
    revenue TEXT,
    type TEXT,
    offer_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (!err) {
    console.log('[DB SUCCESS] Offerwall deduplication tables initialized.');
  }
});

// Games Table with 500 Daily Limit per Game
db.run(`
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    max_daily_reward INTEGER DEFAULT 500,
    reward_multiplier REAL DEFAULT 1.0,
    is_enabled INTEGER DEFAULT 1
  )
`, (err) => {
  if (!err) {
    const defaultGames = [
      ['arrow_puzzle', 'Arrow Puzzle', 500],
      ['ball_sort', 'Ball Sort', 500],
      ['dot_connect', 'Dot Connect', 500],
      ['coin_sprint', 'Coin Sprint', 500],
    ];
    defaultGames.forEach(([id, name, maxReward]) => {
      db.run(
        `INSERT OR IGNORE INTO games (id, name, max_daily_reward, reward_multiplier, is_enabled) VALUES (?, ?, ?, 1.0, 1)`,
        [id, name, maxReward]
      );
    });
    console.log('[DB SUCCESS] Games table initialized with 500 coin limit.');
  }
});

// Optimize daily transactions query
db.run(`
  CREATE INDEX IF NOT EXISTS idx_transactions_daily 
  ON transactions(user_id, created_at, type)
`);

// Security: Hide Express fingerprinting
app.disable('x-powered-by');

// Gzip compression
app.use(compression());

// CORS & Body Parsers
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Serve static assets with browser caching enabled
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
}));

// ============================================================
// HELPER: EXTRACT USER ID (From Token or Query)
// ============================================================
function extractUserId(req) {
  if (req.query.userId || req.query.user_id) {
    return req.query.userId || req.query.user_id;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      if (jwt) {
        const decoded = jwt.decode(token);
        if (decoded && (decoded.id || decoded.userId || decoded.sub)) {
          return decoded.id || decoded.userId || decoded.sub;
        }
      } else {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
          return payload.id || payload.userId || payload.sub;
        }
      }
    } catch (_) {}
  }
  return null;
}

// ============================================================
// 3. DAILY GAME COINS STATUS ENDPOINT (Max 500 for Games Only)
// ============================================================
const getDailyGameCoinsHandler = (req, res) => {
  const userId = extractUserId(req);

  if (!userId) {
    return res.status(400).json({ error: 'Missing user identification (token or userId)' });
  }

  // Calculate exact seconds remaining until midnight
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const secondsUntilReset = Math.max(0, Math.floor((tomorrow - now) / 1000));

  // Sum up all coins earned today where type is NOT an Offerwall
  const query = `
    SELECT COALESCE(SUM(amount), 0) AS total_game_coins
    FROM transactions
    WHERE user_id = ?
      AND amount > 0
      AND type NOT IN ('OFFERWALL', 'TIMEWALL', 'OFFERWALL_REVERSAL', 'TIMEWALL_REVERSAL', 'REFERRAL', 'CHECKIN')
      AND DATE(created_at) = DATE('now')
  `;

  db.get(query, [userId], (err, row) => {
    if (err) {
      console.error('[DAILY GAME LIMIT DB ERROR]:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve daily game coins' });
    }

    const dailyGameCoins = row ? (parseInt(row.total_game_coins, 10) || 0) : 0;
    const maxDailyGameCoins = 500;
    const isLimitReached = dailyGameCoins >= maxDailyGameCoins;

    res.json({
      success: true,
      userId: String(userId),
      dailyGameCoins,
      maxDailyGameCoins,
      remainingCoins: Math.max(0, maxDailyGameCoins - dailyGameCoins),
      isLimitReached,
      secondsUntilReset,
      resetsAt: tomorrow.toISOString(),
    });
  });
};

// Registered on both paths so client calls work seamlessly
app.get('/api/wallet/daily-game-coins', getDailyGameCoinsHandler);
app.get('/api/games/daily-game-coins', getDailyGameCoinsHandler);

// ============================================================
// 4. BACKEND SCORE SUBMISSION INTERCEPTOR (Enforces 500 Game Limit)
// ============================================================
const enforceGameDailyLimitMiddleware = (req, res, next) => {
  // Only check POST requests attempting to submit game score/rewards
  const isScoreSubmission = req.method === 'POST' && (
    req.path.includes('score') ||
    req.path.includes('submit') ||
    req.path.includes('claim')
  );

  if (isScoreSubmission) {
    const userId = extractUserId(req) || req.body.userId || req.body.user_id;

    if (userId) {
      const query = `
        SELECT COALESCE(SUM(amount), 0) AS total_game_coins
        FROM transactions
        WHERE user_id = ?
          AND amount > 0
          AND type NOT IN ('OFFERWALL', 'TIMEWALL', 'OFFERWALL_REVERSAL', 'TIMEWALL_REVERSAL', 'REFERRAL', 'CHECKIN')
          AND DATE(created_at) = DATE('now')
      `;

      db.get(query, [userId], (err, row) => {
        if (!err && row && row.total_game_coins >= 500) {
          const now = new Date();
          const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
          const secondsUntilReset = Math.max(0, Math.floor((tomorrow - now) / 1000));

          console.warn(`[GAME LIMIT BLOCKED] User #${userId} reached 500 game coins for today.`);
          return res.status(403).json({
            success: false,
            limitReached: true,
            error: 'Daily game limit of 500 coins reached! You can still earn unlimited coins from Offerwalls.',
            dailyGameCoins: row.total_game_coins,
            maxDailyGameCoins: 500,
            secondsUntilReset,
          });
        }
        next();
      });
      return;
    }
  }
  next();
};

// Mount Platform API Routing
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/games', enforceGameDailyLimitMiddleware, gamesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rewards', rewardsRouter);
app.use('/api/referral', referralRoutes);

// ============================================================
// ADSWEDMEDIA S2S POSTBACK ENDPOINT (Unlimited - No 500 Limit)
// Postback URL: https://api.rubylune.com/api/adswed/postback
// ============================================================
app.get('/api/adswed/postback', (req, res) => {
  const subId = req.query.subId || req.query['amp;subId'] || req.query.user_id || req.query['amp;user_id'];
  const transId = req.query.transId || req.query['amp;transId'] || req.query.transid || req.query['amp;transid'];
  const reward = req.query.reward !== undefined ? (req.query.reward || req.query['amp;reward']) : req.query.amount;
  const status = req.query.status !== undefined ? (req.query.status || req.query['amp;status']) : 1;
  const signature = req.query.signature || req.query['amp;signature'];
  const payout = req.query.payout || req.query['amp;payout'] || 0;

  // Handle Dashboard Test Call
  const isTest = req.query.type === 'test' || 
                 req.query['amp;type'] === 'test' ||
                 (subId && String(subId).includes('subId')) || 
                 (transId && String(transId).includes('auto-id'));

  if (isTest) {
    console.log('[ADSWED TEST] Received test ping. Responding OK.');
    return res.status(200).send('OK');
  }

  if (!subId || !transId || reward === undefined) {
    console.error('[ADSWED ERROR] Missing required parameters:', req.query);
    return res.status(400).send('ERROR: Missing parameters');
  }

  // MD5 Signature check
  if (signature) {
    const expectedSignature = crypto
      .createHash('md5')
      .update(`${subId}${transId}${reward}${ADSWED_SECRET_KEY}`)
      .digest('hex');

    if (signature.toLowerCase() !== expectedSignature.toLowerCase()) {
      console.error(`[ADSWED ERROR] Invalid signature! Received: ${signature}`);
      return res.status(400).send("ERROR: Signature doesn't match");
    }
  }

  // Idempotency: Prevent duplicate credits
  db.get('SELECT trans_id FROM adswed_transactions WHERE trans_id = ?', [transId], (err, row) => {
    if (err) return res.status(500).send('DB_ERROR');
    if (row) return res.send('DUP');

    const numReward = parseInt(reward, 10) || Math.round(parseFloat(reward));
    const postbackStatus = parseInt(status, 10);

    db.get('SELECT id, balance FROM users WHERE id = ?', [subId], (userErr, user) => {
      if (userErr || !user) return res.status(404).send('USER_NOT_FOUND');

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        if (postbackStatus === 1) {
          db.run(
            `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
            [numReward, numReward, subId]
          );
          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'OFFERWALL', ?, ?)`,
            [subId, numReward, transId]
          );
        } else {
          db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [numReward, subId]);
          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'OFFERWALL_REVERSAL', ?, ?)`,
            [subId, -numReward, transId]
          );
        }

        db.run(
          `INSERT INTO adswed_transactions (trans_id, user_id, reward, status, payout) VALUES (?, ?, ?, ?, ?)`,
          [transId, subId, numReward, postbackStatus, parseFloat(payout) || 0],
          (txErr) => {
            if (txErr) {
              db.run('ROLLBACK');
              return res.status(500).send('DB_LOG_FAILED');
            }
            db.run('COMMIT');
            console.log(`[ADSWED SUCCESS] Credited ${numReward} coins to User #${subId} (Tx: ${transId})`);
            return res.send('OK');
          }
        );
      });
    });
  });
});

// ============================================================
// TIMEWALL S2S POSTBACK ENDPOINT (Unlimited - No 500 Limit)
// Postback URL: https://api.rubylune.com/api/timewall/postback
// ============================================================
app.get('/api/timewall/postback', (req, res) => {
  const clientIp = (
    req.headers['x-forwarded-for'] || 
    req.headers['x-real-ip'] || 
    req.socket.remoteAddress || 
    ''
  ).split(',')[0].trim();

  // 1. IP Whitelist Validation
  const isWhitelisted = TIMEWALL_IPS.some(ip => clientIp.includes(ip)) || 
                        clientIp === '127.0.0.1' || 
                        clientIp === '::1';

  if (!isWhitelisted) {
    console.warn(`[TIMEWALL BLOCKED] Unauthorized IP access attempt: ${clientIp}`);
    return res.status(403).send('FORBIDDEN_IP');
  }

  const {
    userid,
    txid,
    revenue,
    currency,
    hash,
    type = 'credit',
    offername = ''
  } = req.query;

  // 2. Validate Parameters
  if (!userid || !txid || !currency) {
    console.error('[TIMEWALL ERROR] Missing required parameters:', req.query);
    return res.status(400).send('MISSING_PARAMS');
  }

  // 3. Hash Validation using Placement ID
  if (hash && revenue !== undefined) {
    const expectedHash = crypto
      .createHash('sha256')
      .update(`${userid}${revenue}${TIMEWALL_PLACEMENT_ID}`)
      .digest('hex');

    if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
      console.warn(`[TIMEWALL HASH NOTE] Hash mismatch. Allowed via Whitelisted IP (${clientIp}).`);
    }
  }

  // 4. Idempotency Check
  db.get('SELECT tx_id FROM timewall_transactions WHERE tx_id = ?', [txid], (err, row) => {
    if (err) {
      console.error('[TIMEWALL DB ERROR]', err.message);
      return res.status(500).send('DB_ERROR');
    }

    if (row) {
      console.log(`[TIMEWALL DUP] Transaction ${txid} has already been credited.`);
      return res.status(200).send('OK');
    }

    const numCurrency = parseInt(currency, 10) || Math.round(parseFloat(currency));
    const isCredit = type.toLowerCase() !== 'chargeback' && type.toLowerCase() !== 'reversal';
    const balanceDelta = isCredit ? numCurrency : -numCurrency;

    // 5. Verify User Exists
    db.get('SELECT id, balance FROM users WHERE id = ?', [userid], (userErr, user) => {
      if (userErr || !user) {
        console.error(`[TIMEWALL ERROR] User ID ${userid} not found in database.`);
        return res.status(404).send('USER_NOT_FOUND');
      }

      // 6. Update user balance & log in transactions
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        if (isCredit) {
          db.run(
            `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
            [numCurrency, numCurrency, userid]
          );

          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TIMEWALL', ?, ?)`,
            [userid, numCurrency, txid]
          );
        } else {
          db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [numCurrency, userid]);

          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TIMEWALL_REVERSAL', ?, ?)`,
            [userid, -numCurrency, txid]
          );
        }

        // Record in timewall_transactions
        db.run(
          `INSERT INTO timewall_transactions (tx_id, user_id, currency, revenue, type, offer_name) VALUES (?, ?, ?, ?, ?, ?)`,
          [txid, userid, numCurrency, revenue ? String(revenue) : '0', type, offername],
          (txErr) => {
            if (txErr) {
              db.run('ROLLBACK');
              console.error('[TIMEWALL DB ERROR]', txErr.message);
              return res.status(500).send('DB_LOG_ERROR');
            }

            db.run('COMMIT');
            console.log(`[TIMEWALL SUCCESS] Credited ${balanceDelta} coins to User #${userid} (Tx: ${txid})`);
            return res.status(200).send('OK');
          }
        );
      });
    });
  });
});

// --- In-Memory Cache for Version Check ---
let versionCache = null;
let lastVersionFetch = 0;
const VERSION_CACHE_TTL = 60 * 1000;

app.get('/api/config/version', (req, res) => {
  const now = Date.now();
  if (versionCache && (now - lastVersionFetch < VERSION_CACHE_TTL)) {
    return res.json(versionCache);
  }

  db.all(
    'SELECT key, value FROM app_config WHERE key IN ("min_version", "latest_version", "update_url", "force_update")',
    (err, rows) => {
      if (err || !rows) {
        return res.status(500).json({ error: 'Database configurations are currently offline.' });
      }

      const results = {};
      rows.forEach(r => { results[r.key] = r.value; });

      versionCache = {
        minVersion: results['min_version'] || '1.0.0',
        latestVersion: results['latest_version'] || '1.0.0',
        updateUrl: results['update_url'] || '',
        forceUpdate: results['force_update'] === 'true'
      };
      lastVersionFetch = now;

      res.json(versionCache);
    }
  );
});

// Fallback 404 handler for undefined API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// Global Centralized Error Handler
app.use((err, req, res, next) => {
  console.error('[Server Error]:', err.message || err);
  res.status(err.status || 500).json({
    error: 'An internal server error occurred'
  });
});

// Start Server
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n======================================================`);
  console.log(`  Arena Games API Server is running on port: ${PORT}  `);
  console.log(`  Admin Panel URL: http://localhost:${PORT}/admin.html `);
  console.log(`======================================================\n`);
});

// Graceful Shutdown
const handleShutdown = (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    if (db && typeof db.close === 'function') {
      db.close((err) => {
        if (err) {
          console.error('Error closing SQLite database:', err.message);
        } else {
          console.log('SQLite database connection closed successfully.');
        }
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });

  setTimeout(() => {
    console.error('Forcefully terminating process.');
    process.exit(1);
  }, 5000);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
