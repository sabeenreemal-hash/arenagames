// backend/server.js

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const crypto = require('crypto'); // Built-in Node.js crypto module for MD5
const db = require('./database');

// Import Router Files
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const gamesRoutes = require('./routes/games');
const adminRoutes = require('./routes/admin');
const rewardsRouter = require('./routes/rewards');
const referralRoutes = require('./routes/referral');

const app = express();
const PORT = process.env.PORT || 3000;

// AdswedMedia Credentials
const ADSWED_SECRET_KEY = 'Av9Bb6Cz2Nh2So3';

// Ensure Adswed transaction tracking table exists (prevents duplicate rewards)
db.run(`
  CREATE TABLE IF NOT EXISTS adswed_transactions (
    trans_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    reward REAL NOT NULL,
    status INTEGER NOT NULL,
    payout REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) {
    console.error('[DB ERROR] Failed to create adswed_transactions table:', err.message);
  } else {
    console.log('[DB SUCCESS] adswed_transactions table ready.');
  }
});

// Security: Hide Express fingerprinting
app.disable('x-powered-by');

// 1. Enable Gzip compression (massive bandwidth & latency reduction)
app.use(compression());

// 2. CORS & Body Parsers with payload limits
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// 3. Serve static assets with browser caching enabled (1 day cache)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
}));

// Mount Platform API Routing
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rewards', rewardsRouter);
app.use('/api/referral', referralRoutes);

// ============================================================
// ADSWEDMEDIA S2S POSTBACK ENDPOINT
// Postback URL: https://api.rubylune.com/api/adswed/postback
// ============================================================
app.get('/api/adswed/postback', (req, res) => {
  // Support standard params and escaped HTML entities (&amp;)
  const subId = req.query.subId || req.query['amp;subId'] || req.query.user_id || req.query['amp;user_id'];
  const transId = req.query.transId || req.query['amp;transId'] || req.query.transid || req.query['amp;transid'];
  const reward = req.query.reward !== undefined ? (req.query.reward || req.query['amp;reward']) : req.query.amount;
  const status = req.query.status !== undefined ? (req.query.status || req.query['amp;status']) : 1;
  const signature = req.query.signature || req.query['amp;signature'];
  const payout = req.query.payout || req.query['amp;payout'] || 0;

  // 1. Dashboard Test Call Handler
  const isTest = req.query.type === 'test' || 
                 req.query['amp;type'] === 'test' ||
                 (subId && String(subId).includes('subId')) || 
                 (transId && String(transId).includes('auto-id'));

  if (isTest) {
    console.log('[ADSWED TEST] Received test ping from dashboard. Responding OK.');
    return res.status(200).send('OK');
  }

  // 2. Validate Required Parameters
  if (!subId || !transId || reward === undefined) {
    console.error('[ADSWED ERROR] Missing required parameters:', req.query);
    return res.status(400).send('ERROR: Missing parameters');
  }

  // 3. Verify MD5 Signature: md5(subId + transId + reward + SECRET_KEY)
  if (signature) {
    const expectedSignature = crypto
      .createHash('md5')
      .update(`${subId}${transId}${reward}${ADSWED_SECRET_KEY}`)
      .digest('hex');

    if (signature.toLowerCase() !== expectedSignature.toLowerCase()) {
      console.error(`[ADSWED ERROR] Invalid signature! Received: ${signature}, Expected: ${expectedSignature}`);
      return res.status(400).send("ERROR: Signature doesn't match");
    }
  }

  // 4. Prevent Duplicate Credit (Idempotency)
  db.get('SELECT trans_id FROM adswed_transactions WHERE trans_id = ?', [transId], (err, row) => {
    if (err) {
      console.error('[ADSWED DB ERROR]', err.message);
      return res.status(500).send('DB_ERROR');
    }

    if (row) {
      console.log(`[ADSWED DUP] Transaction ${transId} already processed.`);
      return res.send('DUP');
    }

    const numReward = parseInt(reward, 10) || Math.round(parseFloat(reward));
    const postbackStatus = parseInt(status, 10); // 1 = Credit, 2 = Reversal

    // 5. Verify User Exists
    db.get('SELECT id, balance FROM users WHERE id = ?', [subId], (userErr, user) => {
      if (userErr || !user) {
        console.error(`[ADSWED ERROR] User ID ${subId} does not exist in users table.`);
        return res.status(404).send('USER_NOT_FOUND');
      }

      // 6. Execute atomic update to user balance & transaction history
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        if (postbackStatus === 1) {
          // Add reward to current balance and total earned
          db.run(
            `UPDATE users SET balance = balance + ?, total_coins_earned = total_coins_earned + ? WHERE id = ?`,
            [numReward, numReward, subId]
          );

          // Add to wallet transaction history (visible in app's history screen)
          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'OFFERWALL', ?, ?)`,
            [subId, numReward, transId]
          );
        } else {
          // Reversal / Chargeback: deduct balance
          db.run(
            `UPDATE users SET balance = balance - ? WHERE id = ?`,
            [numReward, subId]
          );

          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'OFFERWALL_REVERSAL', ?, ?)`,
            [subId, -numReward, transId]
          );
        }

        // Record in adswed_transactions to prevent replay attacks
        db.run(
          `INSERT INTO adswed_transactions (trans_id, user_id, reward, status, payout) VALUES (?, ?, ?, ?, ?)`,
          [transId, subId, numReward, postbackStatus, parseFloat(payout) || 0],
          function (txErr) {
            if (txErr) {
              db.run('ROLLBACK');
              console.error('[ADSWED DB ERROR]', txErr.message);
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

// --- In-Memory Cache for Version Check ---
let versionCache = null;
let lastVersionFetch = 0;
const VERSION_CACHE_TTL = 60 * 1000; // Cache for 60 seconds

// Version verification endpoint (optimized for heavy mobile app launches)
app.get('/api/config/version', (req, res) => {
  const now = Date.now();

  // Return cached result if fresh
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

// Global Centralized Error Handler (Catches unhandled route errors)
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

// --- Graceful Shutdown Handler (Prevents SQLite database corruption) ---
const handleShutdown = (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  server.close(() => {
    console.log('HTTP server closed.');
    // Close SQLite database properly
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

  // Force exit if hanging after 5 seconds
  setTimeout(() => {
    console.error('Forcefully terminating process.');
    process.exit(1);
  }, 5000);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
