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
  const { subId, transId, reward, signature, status = 1, payout } = req.query;

  // 1. Check for required parameters
  if (!subId || !transId || reward === undefined || !signature) {
    console.error('[ADSWED ERROR] Missing required parameters:', req.query);
    return res.status(400).send('ERROR: Missing parameters');
  }

  // 2. MD5 Signature check: md5(subId + transId + reward + SECRET_KEY)
  const expectedSignature = crypto
    .createHash('md5')
    .update(`${subId}${transId}${reward}${ADSWED_SECRET_KEY}`)
    .digest('hex');

  if (signature.toLowerCase() !== expectedSignature.toLowerCase()) {
    console.error(`[ADSWED ERROR] Invalid signature! Received: ${signature}, Expected: ${expectedSignature}`);
    return res.status(400).send("ERROR: Signature doesn't match");
  }

  // 3. Check for Duplicate Transactions (Idempotency)
  db.get('SELECT trans_id FROM adswed_transactions WHERE trans_id = ?', [transId], (err, row) => {
    if (err) {
      console.error('[ADSWED DB ERROR]', err.message);
      return res.status(500).send('DB_ERROR');
    }

    // Return DUP if transaction was already credited
    if (row) {
      console.log(`[ADSWED DUP] Transaction ${transId} has already been processed.`);
      return res.send('DUP');
    }

    const numReward = parseFloat(reward);
    const postbackStatus = parseInt(status, 10); // 1 = Credit, 2 = Chargeback/Revoke

    // Calculate balance change: Add if 1, subtract if 2
    const balanceDelta = postbackStatus === 1 ? numReward : -numReward;

    // 4. Update the user's coins in the SQLite users table
    // (Ensure your column name in 'users' is 'coins'; change if named 'balance')
    db.run(
      `UPDATE users SET coins = COALESCE(coins, 0) + ? WHERE id = ?`,
      [balanceDelta, subId],
      function (updateErr) {
        if (updateErr) {
          console.error('[ADSWED UPDATE FAILED]', updateErr.message);
          return res.status(500).send('DB_UPDATE_ERROR');
        }

        // 5. Store transaction record
        db.run(
          `INSERT INTO adswed_transactions (trans_id, user_id, reward, status, payout) VALUES (?, ?, ?, ?, ?)`,
          [transId, subId, numReward, postbackStatus, payout ? parseFloat(payout) : 0],
          (insertErr) => {
            if (insertErr) {
              console.error('[ADSWED RECORD FAILED]', insertErr.message);
            }
            console.log(`[ADSWED SUCCESS] Credited ${balanceDelta} coins to User: ${subId} (Tx: ${transId})`);
            // AdswedMedia expects "OK" on success
            return res.send('OK');
          }
        );
      }
    );
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
