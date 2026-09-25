// backend/server.js

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
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
const server = app.listen(PORT, () => {
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