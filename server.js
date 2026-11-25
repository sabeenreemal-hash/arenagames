// backend/server.js (Updated additions)

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Ensure core database initializes
require('./database');

// Initialize Tic Tac Toe Dedicated Database
const { initTicTacToeDatabase } = require('./database/tictactoeDatabase');
initTicTacToeDatabase();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Setup Socket.IO Event Engine
const setupTicTacToeSockets = require('./sockets/tictactoeSocket');
setupTicTacToeSockets(io);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
const tictactoeNewRoutes = require('./routes/tictactoenew');
const tictactoeAdminRoutes = require('./routes/tictactoeAdmin');

app.use('/api/tictactoe', tictactoeNewRoutes);
app.use('/api/admin/tictactoe', tictactoeAdminRoutes);

// Direct entry point for Tic Tac Toe Admin Portal
app.get('/admin/tictactoe', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'tictactoe', 'index.html'));
});

// Existing routes ...
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const walletRoutes = require('./routes/wallet');
const gamesRoutes = require('./routes/games');
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/games', gamesRoutes);

// Start server
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 Arena Games Server running on port ${PORT}`);
  console.log(`❌ Tic Tac Toe Real-Time Engine Active`);
  console.log(`🛠️ Tic Tac Toe Admin Portal at /admin/tictactoe`);
  console.log(`=========================================`);
});
