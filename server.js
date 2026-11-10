// backend/server.js

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const taskRoutes = require('./routes/tasks');
const tictactoeRoutes = require('./routes/tictactoe');
const rpsRoutes = require('./routes/rps');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable reading client IP from reverse proxies (Nginx / Cloudflare / Load Balancers)
app.set('trust proxy', true);

// Security Keys
const ADSWED_SECRET_KEY = 'Av9Bb6Cz2Nh2So3';
const TIMEWALL_PLACEMENT_ID = '21f38a8af19d2013';
const TIMEWALL_IPS = ['18.156.132.55', '51.81.120.73', '142.111.248.18'];

// Ensure deduplication tables exist
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
`);

app.disable('x-powered-by');
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Ensure upload folders exist
const taskProofsDir = path.join(__dirname, 'uploads/task_proofs');
if (!fs.existsSync(taskProofsDir)) {
  fs.mkdirSync(taskProofsDir, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Safe user ID extraction helper
function extractUserId(req) {
  try {
    if (req.query && (req.query.userId || req.query.user_id)) {
      return req.query.userId || req.query.user_id;
    }
    const authHeader = req.headers && req.headers['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      if (!token) return null;
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
    }
  } catch (_) {}
  return null;
}

// User activity tracker
const userActivityThrottle = new Map();

app.use((req, res, next) => {
  try {
    if (req.path && (req.path.startsWith('/api/admin') || req.path.startsWith('/uploads'))) {
      return next();
    }
    const userId = extractUserId(req) || (req.body && (req.body.userId || req.body.user_id));
    if (userId) {
      const now = Date.now();
      const lastUpdated = userActivityThrottle.get(String(userId)) || 0;
      if (now - lastUpdated > 60000) {
        userActivityThrottle.set(String(userId), now);
        if (userActivityThrottle.size > 10000) userActivityThrottle.clear();
        db.run(`UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?`, [userId], () => {});
      }
    }
  } catch (err) {
    console.error('[Activity Middleware Error]:', err.message);
  }
  next();
});

// Daily game limit status
const getDailyGameCoinsHandler = (req, res) => {
  const userId = extractUserId(req);
  if (!userId) {
    return res.status(400).json({ error: 'Missing user identification (token or userId)' });
  }

  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const secondsUntilReset = Math.max(0, Math.floor((tomorrow - now) / 1000));

  const query = `
    SELECT COALESCE(SUM(amount), 0) AS total_game_coins
    FROM transactions
    WHERE user_id = ?
      AND amount > 0
      AND type NOT IN (
        'OFFERWALL', 'TIMEWALL', 'OFFERWALL_REVERSAL', 'TIMEWALL_REVERSAL', 
        'REFERRAL', 'CHECKIN', 'TASK_REWARD',
        'TICTACTOE_WIN', 'TICTACTOE_REFUND', 'TICTACTOE_ENTRY',
        'RPS_WIN', 'RPS_REFUND', 'RPS_ENTRY'
      )
      AND DATE(created_at) = DATE('now')
  `;

  db.get(query, [userId], (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to retrieve daily game coins' });
    const dailyGameCoins = row ? (parseInt(row.total_game_coins, 10) || 0) : 0;
    const maxDailyGameCoins = 500;

    res.json({
      success: true,
      userId: String(userId),
      dailyGameCoins,
      maxDailyGameCoins,
      remainingCoins: Math.max(0, maxDailyGameCoins - dailyGameCoins),
      isLimitReached: dailyGameCoins >= maxDailyGameCoins,
      secondsUntilReset,
      resetsAt: tomorrow.toISOString(),
    });
  });
};

app.get('/api/wallet/daily-game-coins', getDailyGameCoinsHandler);
app.get('/api/games/daily-game-coins', getDailyGameCoinsHandler);

// Enforce Game Limits Middleware
const enforceGameDailyLimitMiddleware = (req, res, next) => {
  const isScoreSubmission = req.method === 'POST' && (
    req.path.includes('score') || req.path.includes('submit') || req.path.includes('claim')
  );

  if (isScoreSubmission) {
    const userId = extractUserId(req) || req.body.userId || req.body.user_id;
    if (userId) {
      const query = `
        SELECT COALESCE(SUM(amount), 0) AS total_game_coins
        FROM transactions
        WHERE user_id = ?
          AND amount > 0
          AND type NOT IN (
            'OFFERWALL', 'TIMEWALL', 'OFFERWALL_REVERSAL', 'TIMEWALL_REVERSAL', 
            'REFERRAL', 'CHECKIN', 'TASK_REWARD',
            'TICTACTOE_WIN', 'TICTACTOE_REFUND', 'TICTACTOE_ENTRY',
            'RPS_WIN', 'RPS_REFUND', 'RPS_ENTRY'
          )
          AND DATE(created_at) = DATE('now')
      `;

      db.get(query, [userId], (err, row) => {
        if (!err && row && row.total_game_coins >= 500) {
          return res.status(403).json({
            success: false,
            limitReached: true,
            error: 'Daily game limit reached!',
          });
        }
        next();
      });
      return;
    }
  }
  next();
};

// Route Mounts
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/games', enforceGameDailyLimitMiddleware, gamesRoutes);
app.use('/api/tictactoe', tictactoeRoutes);
app.use('/api/rps', rpsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rewards', rewardsRouter);
app.use('/api/referral', referralRoutes);
app.use('/api', taskRoutes);

// Postback Endpoints
app.get('/api/adswed/postback', (req, res) => {
  const subId = req.query.subId || req.query['amp;subId'] || req.query.user_id;
  const transId = req.query.transId || req.query['amp;transId'] || req.query.transid;
  const reward = req.query.reward !== undefined ? (req.query.reward || req.query['amp;reward']) : req.query.amount;
  const status = req.query.status !== undefined ? (req.query.status || req.query['amp;status']) : 1;
  const signature = req.query.signature || req.query['amp;signature'];
  const payout = req.query.payout || req.query['amp;payout'] || 0;

  if (req.query.type === 'test') return res.status(200).send('OK');
  if (!subId || !transId || reward === undefined) return res.status(400).send('ERROR: Missing parameters');

  if (signature) {
    const expected = crypto.createHash('md5').update(`${subId}${transId}${reward}${ADSWED_SECRET_KEY}`).digest('hex');
    if (signature.toLowerCase() !== expected.toLowerCase()) return res.status(400).send("ERROR: Signature mismatch");
  }

  db.get('SELECT trans_id FROM adswed_transactions WHERE trans_id = ?', [transId], (err, row) => {
    if (err) return res.status(500).send('DB_ERROR');
    if (row) return res.send('DUP');

    const numReward = parseInt(reward, 10) || Math.round(parseFloat(reward));
    const postbackStatus = parseInt(status, 10);

    db.get('SELECT id FROM users WHERE id = ?', [subId], (userErr, user) => {
      if (userErr || !user) return res.status(404).send('USER_NOT_FOUND');

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        if (postbackStatus === 1) {
          db.run(`UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`, [numReward, numReward, subId]);
          db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'OFFERWALL', ?, ?)`, [subId, numReward, transId]);
        } else {
          db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [numReward, subId]);
          db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'OFFERWALL_REVERSAL', ?, ?)`, [subId, -numReward, transId]);
        }
        db.run(`INSERT INTO adswed_transactions (trans_id, user_id, reward, status, payout) VALUES (?, ?, ?, ?, ?)`, [transId, subId, numReward, postbackStatus, parseFloat(payout) || 0]);
        db.run('COMMIT', () => res.send('OK'));
      });
    });
  });
});

app.get('/api/timewall/postback', (req, res) => {
  const { userid, txid, currency, type = 'credit', offername = '', revenue } = req.query;
  if (!userid || !txid || !currency) return res.status(400).send('MISSING_PARAMS');

  db.get('SELECT tx_id FROM timewall_transactions WHERE tx_id = ?', [txid], (err, row) => {
    if (err) return res.status(500).send('DB_ERROR');
    if (row) return res.status(200).send('OK');

    const numCurrency = parseInt(currency, 10) || Math.round(parseFloat(currency));
    const isCredit = type.toLowerCase() !== 'chargeback' && type.toLowerCase() !== 'reversal';

    db.get('SELECT id FROM users WHERE id = ?', [userid], (userErr, user) => {
      if (userErr || !user) return res.status(404).send('USER_NOT_FOUND');

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        if (isCredit) {
          db.run(`UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`, [numCurrency, numCurrency, userid]);
          db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TIMEWALL', ?, ?)`, [userid, numCurrency, txid]);
        } else {
          db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [numCurrency, userid]);
          db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'TIMEWALL_REVERSAL', ?, ?)`, [userid, -numCurrency, txid]);
        }
        db.run(`INSERT INTO timewall_transactions (tx_id, user_id, currency, revenue, type, offer_name) VALUES (?, ?, ?, ?, ?, ?)`, [txid, userid, numCurrency, revenue ? String(revenue) : '0', type, offername]);
        db.run('COMMIT', () => res.status(200).send('OK'));
      });
    });
  });
});

// Version Check
app.get('/api/config/version', (req, res) => {
  db.all('SELECT key, value FROM app_config WHERE key IN ("min_version", "latest_version", "update_url", "force_update")', (err, rows) => {
    if (err || !rows) return res.status(500).json({ error: 'Database configurations offline.' });
    const results = {};
    rows.forEach(r => { results[r.key] = r.value; });
    res.json({
      minVersion: results['min_version'] || '1.0.0',
      latestVersion: results['latest_version'] || '1.0.0',
      updateUrl: results['update_url'] || '',
      forceUpdate: results['force_update'] === 'true'
    });
  });
});

// Fallback 404
app.use('/api/*', (req, res) => res.status(404).json({ error: 'API route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]:', err.message || err);
  res.status(err.status || 500).json({ error: 'An internal server error occurred' });
});

// Listen on all network interfaces
const server = app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  Arena Games API Server is running on port: ${PORT}  `);
  console.log(`  Task Proof Storage: ${taskProofsDir}`);
  console.log(`  Admin Panel URL: http://localhost:${PORT}/admin.html `);
  console.log(`======================================================\n`);
});

const handleShutdown = () => {
  server.close(() => {
    if (db && typeof db.close === 'function') db.close(() => process.exit(0));
    else process.exit(0);
  });
};

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);
