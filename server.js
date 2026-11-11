// backend/server.js

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Ensure database initializes immediately
require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Global Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Standard Arena Games Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/games', require('./routes/games'));
app.use('/api/mining', require('./routes/mining'));
app.use('/api/offerwall', require('./routes/offerwall'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/rewards', require('./routes/rewards'));
app.use('/api/rps', require('./routes/rps'));
app.use('/api/spin', require('./routes/spinWheelRoutes'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/tictactoe', require('./routes/tictactoe'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ONLINE', service: 'Arena Games API' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('[Global Server Error]:', err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Arena Games Server running on port ${PORT}`);
});
