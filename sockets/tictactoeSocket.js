// backend/sockets/tictactoeSocket.js

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database');
const { joinQueue, cancelQueue, getQueueEntry } = require('../services/tictactoeMatchmaking');
const { createMatchSession, getMatchSession, findMatchByUserId } = require('../services/tictactoeEngine');
const { getSettings } = require('../database/tictactoeDatabase');

function setupTicTacToeSockets(io) {
  // Authentication Middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (!token) {
      return next(new Error('Authentication token required'));
    }

    const secret = process.env.JWT_SECRET || 'your_secret_key_change_in_production';
    jwt.verify(token, secret, (err, decoded) => {
      if (err) return next(new Error('Invalid or expired token'));

      db.get('SELECT id, username, is_banned FROM users WHERE id = ?', [decoded.id], (dbErr, user) => {
        if (dbErr || !user) return next(new Error('User not found'));
        if (user.is_banned === 1) return next(new Error('User account is banned'));

        socket.user = user;
        next();
      });
    });
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`🔌 [SOCKET CONNECTED] User: ${user.username} (ID: ${user.id})`);

    // Check ongoing active match for instant reconnect
    const existingMatch = findMatchByUserId(user.id);
    if (existingMatch) {
      existingMatch.handlePlayerReconnect(user.id, socket);
    }

    // 1. Join Matchmaking
    socket.on('tictactoe:join_queue', async () => {
      // Prevent double queuing if already in active match
      const current = findMatchByUserId(user.id);
      if (current) {
        return socket.emit('tictactoe:error', { message: 'You are already in an active match' });
      }

      const settings = await getSettings();
      const entryFee = parseInt(settings.entry_fee || '100', 10);
      const winnerReward = parseInt(settings.winner_reward || '180', 10);

      joinQueue({
        socket,
        user,
        onMatchFound: (p1Entry, p2Entry) => {
          const matchId = `TTT_${crypto.randomUUID()}`;
          const s1 = io.sockets.sockets.get(p1Entry.socketId);
          const s2 = io.sockets.sockets.get(p2Entry.socketId);

          if (s1) s1.join(`match:${matchId}`);
          if (s2) s2.join(`match:${matchId}`);

          const session = createMatchSession({
            id: matchId,
            p1: p1Entry,
            p2: p2Entry,
            isBot: false,
            entryFee,
            winnerReward,
            io
          });

          io.to(`match:${matchId}`).emit('tictactoe:match_found', {
            matchId,
            isBot: false,
            player1: { userId: p1Entry.userId, username: p1Entry.username, avatar: p1Entry.avatar },
            player2: { userId: p2Entry.userId, username: p2Entry.username, avatar: p2Entry.avatar },
            entryFee,
            winnerReward
          });
        },
        onBotFallback: (p1Entry, bot) => {
          const matchId = `TTT_BOT_${crypto.randomUUID()}`;
          socket.join(`match:${matchId}`);

          const session = createMatchSession({
            id: matchId,
            p1: p1Entry,
            p2: { userId: 'BOT', username: bot.name, avatar: bot.avatar_url },
            isBot: true,
            bot,
            entryFee,
            winnerReward,
            io
          });

          socket.emit('tictactoe:match_found', {
            matchId,
            isBot: true,
            player1: { userId: p1Entry.userId, username: p1Entry.username, avatar: p1Entry.avatar },
            player2: { userId: 'BOT', username: bot.name, avatar: bot.avatar_url },
            entryFee,
            winnerReward
          });
        },
        onTimeout: (entry) => {
          socket.emit('tictactoe:queue_timeout', {
            message: 'No players found within 30s. Your entry fee has been refunded.'
          });
        },
        onError: (err) => {
          socket.emit('tictactoe:error', { message: err.message });
        }
      });

      socket.emit('tictactoe:queue_status', { status: 'SEARCHING', countdown: 30 });
    });

    // 2. Cancel Queue
    socket.on('tictactoe:cancel_queue', async () => {
      const cancelled = await cancelQueue(user.id);
      if (cancelled) {
        socket.emit('tictactoe:queue_cancelled', { message: 'Matchmaking cancelled and coins refunded.' });
      }
    });

    // 3. Make Move
    socket.on('tictactoe:make_move', ({ matchId, cellIndex }) => {
      const session = getMatchSession(matchId);
      if (!session) {
        return socket.emit('tictactoe:error', { message: 'Match not found or expired' });
      }
      const res = session.handlePlayerMove(user.id, cellIndex);
      if (res.error) {
        socket.emit('tictactoe:error', { message: res.error });
      }
    });

    // 4. Leave / Forfeit
    socket.on('tictactoe:leave_match', ({ matchId }) => {
      const session = getMatchSession(matchId);
      if (session) {
        session.handlePlayerDisconnect(user.id);
      }
    });

    // 5. Disconnect handling
    socket.on('disconnect', () => {
      cancelQueue(user.id);
      const session = findMatchByUserId(user.id);
      if (session) {
        session.handlePlayerDisconnect(user.id);
      }
    });
  });
}

module.exports = setupTicTacToeSockets;