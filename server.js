// backend/server.js

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Ensure database initializes immediately
require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. Global Middleware
// ==========================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static assets from public/ (e.g. admin.html)
app.use(express.static(path.join(__dirname, 'public')));

// FIX: Serve uploaded screenshots publicly so admin panel can open them
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Request logger for debugging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/uploads')) {
      console.log(`[${req.method}] ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// ==========================================
// 2. Route Imports
// ==========================================
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const walletRoutes = require('./routes/wallet');
const gamesRoutes = require('./routes/games');
const referralRoutes = require('./routes/referral');
const rewardsRoutes = require('./routes/rewards');
const rpsRoutes = require('./routes/rps');
const spinWheelRoutes = require('./routes/spinWheelRoutes');
const tasksRoutes = require('./routes/tasks');
const tictactoeRoutes = require('./routes/tictactoe');

// ==========================================
// 3. Mount Routes
// ==========================================
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/rps', rpsRoutes);
app.use('/api/spin', spinWheelRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/tictactoe', tictactoeRoutes);

// ==========================================
// 4. Base & Health Check Endpoints
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'Arena Games API',
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// 5. Global 404 & Error Handling
// ==========================================
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('[Global Server Error]:', err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// ==========================================
// 6. Start Server
// ==========================================
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 Arena Games Server running on port ${PORT}`);
  console.log(`=========================================`);
});
