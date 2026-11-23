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

// Serve static assets from public/ (e.g. admin.html, arena.html, spin-wheel, high-low)
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded screenshots publicly for verification
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
const leaderboardRoutes = require('./routes/leaderboard');
const spinWheelRoutes = require('./routes/spinWheelRoutes');
const tasksRoutes = require('./routes/tasks');
const watchRoutes = require('./routes/watch');
const html5Routes = require('./routes/html5Routes');
const arenaPotRoutes = require('./routes/arenaPot'); // Arena Pot Central Router
const highLowRoutes = require('./routes/highLowRoutes'); // High or Low Player Endpoints
const highLowAdminRoutes = require('./routes/highLowAdminRoutes'); // High or Low Admin & Sandbox Endpoints

// ==========================================
// 3. Mount Routes
// ==========================================
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/leaderboard', leaderboardRoutes.router);
app.use('/api/spin', spinWheelRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/watch', watchRoutes);
app.use('/api/html5', html5Routes);
app.use('/api/arena-pot', arenaPotRoutes); // Arena Pot Endpoints
app.use('/api/high-low', highLowRoutes); // High or Low Card Game Endpoints
app.use('/api/admin/high-low', highLowAdminRoutes); // High or Low Master Administration

// ==========================================
// 4. Base & Health Check Endpoints
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Direct entry point for Arena Pot Admin Panel
app.get('/arena', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'arena.html'));
});

// Direct entry point for Spin & Win Admin & Demo Panel (Section 10 & 23 PRD)
app.get('/spin-wheel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'spin-wheel', 'index.html'));
});

// Direct entry point for High or Low Admin & Sandbox Portal
app.get('/high-low', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'high-low', 'index.html'));
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
// 6. Start Server & Weekly Leaderboard Scheduler
// ==========================================
app.listen(PORT, () => {
  leaderboardRoutes.startWeeklyLeaderboardScheduler();
  console.log(`=========================================`);
  console.log(`🚀 Arena Games Server running on port ${PORT}`);
  console.log(`🏆 Weekly Leaderboard Scheduler Active`);
  console.log(`🎰 Arena Pot System Active at /api/arena-pot`);
  console.log(`🎡 Spin & Win System Active at /api/spin`);
  console.log(`🎯 Spin & Win Web Portal available at /spin-wheel`);
  console.log(`🃏 High or Low Card Game Active at /api/high-low`);
  console.log(`🎴 High or Low Web Portal available at /high-low`);
  console.log(`=========================================`);
});
