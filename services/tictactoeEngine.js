// backend/services/tictactoeEngine.js

const crypto = require('crypto');
const db = require('../database');
const { checkWinner, getBestMove } = require('./tictactoeBot');
const { payoutWinnerReward } = require('./tictactoeCoinService');
const { getSettings } = require('../database/tictactoeDatabase');

// Active Matches In Memory Store: matchId -> GameSession
const activeMatches = new Map();

class MatchSession {
  constructor({ id, p1, p2, isBot, bot, entryFee, winnerReward, io }) {
    this.id = id;
    this.p1 = p1; // { userId, username, avatar, socketId }
    this.p2 = p2; // { userId, username, avatar, socketId } or Bot object
    this.isBot = isBot;
    this.bot = bot || null;
    this.entryFee = entryFee;
    this.winnerReward = winnerReward;
    this.io = io;

    this.status = 'ACTIVE';
    this.currentRound = 1;
    this.p1Symbol = 'X';
    this.p2Symbol = 'O';
    this.currentTurn = p1.userId; // Player 1 starts round 1
    this.board = ['', '', '', '', '', '', '', '', ''];
    this.moveCount = 0;

    this.turnSecondsLeft = 30;
    this.turnInterval = null;
    this.botMoveTimeout = null;
    this.disconnectTimers = new Map(); // userId -> timer
  }

  start() {
    this.persistMatchCreation();
    this.startRound(1);
  }

  persistMatchCreation() {
    db.run(
      `INSERT INTO tictactoe_matches 
       (id, player1_id, player2_id, is_bot_match, bot_id, bot_name, entry_fee, winner_reward, status, total_rounds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1)`,
      [
        this.id,
        this.p1.userId,
        this.isBot ? null : this.p2.userId,
        this.isBot ? 1 : 0,
        this.isBot ? this.bot.id : null,
        this.isBot ? this.bot.name : null,
        this.entryFee,
        this.winnerReward
      ]
    );
  }

  startRound(roundNumber) {
    this.currentRound = roundNumber;
    this.board = ['', '', '', '', '', '', '', '', ''];
    this.moveCount = 0;

    // Alternate symbol assignments for fair rematches
    if (roundNumber % 2 === 1) {
      this.p1Symbol = 'X';
      this.p2Symbol = 'O';
      this.currentTurn = this.p1.userId;
    } else {
      this.p1Symbol = 'O';
      this.p2Symbol = 'X';
      this.currentTurn = this.isBot ? 'BOT' : this.p2.userId;
    }

    db.run(
      `INSERT INTO tictactoe_rounds 
       (match_id, round_number, p1_symbol, p2_symbol, board_state, status)
       VALUES (?, ?, ?, ?, ?, 'PLAYING')`,
      [this.id, this.currentRound, this.p1Symbol, this.p2Symbol, JSON.stringify(this.board)]
    );

    db.run(
      `UPDATE tictactoe_matches SET total_rounds = ? WHERE id = ?`,
      [this.currentRound, this.id]
    );

    this.io.to(`match:${this.id}`).emit('tictactoe:rematch_start', {
      matchId: this.id,
      roundNumber: this.currentRound,
      board: this.board,
      currentTurn: this.currentTurn,
      p1Symbol: this.p1Symbol,
      p2Symbol: this.p2Symbol,
      turnTimer: 30
    });

    this.resetTurnTimer();

    // Trigger bot if it starts
    if (this.isBot && this.currentTurn === 'BOT') {
      this.scheduleBotMove();
    }
  }

  resetTurnTimer() {
    clearInterval(this.turnInterval);
    this.turnSecondsLeft = 30;

    this.turnInterval = setInterval(() => {
      this.turnSecondsLeft -= 1;

      this.io.to(`match:${this.id}`).emit('tictactoe:timer_update', {
        secondsLeft: this.turnSecondsLeft,
        turnUserId: this.currentTurn
      });

      if (this.turnSecondsLeft <= 0) {
        clearInterval(this.turnInterval);
        this.handleTurnTimeout();
      }
    }, 1000);
  }

  handleTurnTimeout() {
    console.log(`[TURN TIMEOUT] Match: ${this.id}, Timed-out User: ${this.currentTurn}`);

    // If turn user timed out, opponent wins match
    if (this.currentTurn === this.p1.userId) {
      this.endMatch({
        winnerId: this.isBot ? null : this.p2.userId,
        loserId: this.p1.userId,
        isBotWin: this.isBot,
        reason: 'TURN_TIMEOUT'
      });
    } else {
      this.endMatch({
        winnerId: this.p1.userId,
        loserId: this.isBot ? null : this.p2.userId,
        isBotWin: false,
        reason: 'TURN_TIMEOUT'
      });
    }
  }

  handlePlayerMove(userId, cellIndex) {
    if (this.status !== 'ACTIVE') return { error: 'Match is no longer active' };
    if (this.currentTurn !== userId) return { error: 'Not your turn' };
    if (cellIndex < 0 || cellIndex > 8) return { error: 'Invalid cell index' };
    if (this.board[cellIndex] !== '') return { error: 'Cell already occupied' };

    const symbol = userId === this.p1.userId ? this.p1Symbol : this.p2Symbol;
    this.board[cellIndex] = symbol;
    this.moveCount++;

    // Persist move
    db.run(
      `INSERT INTO tictactoe_moves (match_id, round_number, move_number, player_id, symbol, cell_index)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [this.id, this.currentRound, this.moveCount, userId, symbol, cellIndex]
    );

    // Broadcast move
    this.io.to(`match:${this.id}`).emit('tictactoe:move_update', {
      cellIndex,
      symbol,
      board: this.board,
      playedBy: userId
    });

    // Check round outcome
    const winResult = checkWinner(this.board);
    if (winResult) {
      return this.handleRoundEnd(winResult, userId);
    }

    // Switch turn
    this.currentTurn = this.isBot
      ? 'BOT'
      : (userId === this.p1.userId ? this.p2.userId : this.p1.userId);

    this.io.to(`match:${this.id}`).emit('tictactoe:turn_update', {
      currentTurn: this.currentTurn,
      board: this.board
    });

    this.resetTurnTimer();

    if (this.isBot && this.currentTurn === 'BOT') {
      this.scheduleBotMove();
    }

    return { success: true };
  }

  scheduleBotMove() {
    clearTimeout(this.botMoveTimeout);
    const delaySec = this.bot.move_delay_sec || 2;

    this.botMoveTimeout = setTimeout(() => {
      if (this.status !== 'ACTIVE' || this.currentTurn !== 'BOT') return;

      const botSymbol = this.p2Symbol;
      const move = getBestMove(this.board, botSymbol, this.bot.difficulty || 'HARD');
      if (move === null || move === undefined) return;

      this.board[move] = botSymbol;
      this.moveCount++;

      db.run(
        `INSERT INTO tictactoe_moves (match_id, round_number, move_number, is_bot_move, symbol, cell_index)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [this.id, this.currentRound, this.moveCount, botSymbol, move]
      );

      this.io.to(`match:${this.id}`).emit('tictactoe:move_update', {
        cellIndex: move,
        symbol: botSymbol,
        board: this.board,
        playedBy: 'BOT'
      });

      const winResult = checkWinner(this.board);
      if (winResult) {
        return this.handleRoundEnd(winResult, 'BOT');
      }

      // Switch turn to Player 1
      this.currentTurn = this.p1.userId;
      this.io.to(`match:${this.id}`).emit('tictactoe:turn_update', {
        currentTurn: this.currentTurn,
        board: this.board
      });

      this.resetTurnTimer();
    }, delaySec * 1000);
  }

  handleRoundEnd(winResult, lastActor) {
    clearInterval(this.turnInterval);
    clearTimeout(this.botMoveTimeout);

    // ==========================================
    // CASE A: ROUND ENDS IN A DRAW -> REMATCH
    // ==========================================
    if (winResult.winner === 'DRAW') {
      console.log(`🤝 [ROUND DRAW] Match ${this.id}, Round ${this.currentRound}. Triggering auto-rematch.`);

      db.run(
        `UPDATE tictactoe_rounds 
         SET status = 'DRAW', is_draw = 1, final_board = ?, completed_at = CURRENT_TIMESTAMP
         WHERE match_id = ? AND round_number = ?`,
        [JSON.stringify(this.board), this.id, this.currentRound]
      );

      // Increment stats draw counter
      db.run(
        `UPDATE tictactoe_player_stats 
         SET draw_rounds = draw_rounds + 1, total_rounds = total_rounds + 1 
         WHERE user_id = ?`,
        [this.p1.userId]
      );
      if (!this.isBot) {
        db.run(
          `UPDATE tictactoe_player_stats 
           SET draw_rounds = draw_rounds + 1, total_rounds = total_rounds + 1 
           WHERE user_id = ?`,
          [this.p2.userId]
        );
      }

      this.io.to(`match:${this.id}`).emit('tictactoe:round_draw', {
        matchId: this.id,
        roundNumber: this.currentRound,
        board: this.board,
        message: 'Round ended in a Draw! Rematch starting...'
      });

      // Automatically launch next round after short 3-second celebration transition
      setTimeout(() => {
        if (this.status === 'ACTIVE') {
          this.startRound(this.currentRound + 1);
        }
      }, 3000);

      return;
    }

    // ==========================================
    // CASE B: ROUND WON -> FINAL MATCH WINNER
    // ==========================================
    db.run(
      `UPDATE tictactoe_rounds 
       SET status = 'COMPLETED', round_winner_id = ?, final_board = ?, winning_line = ?, completed_at = CURRENT_TIMESTAMP
       WHERE match_id = ? AND round_number = ?`,
      [
        lastActor === 'BOT' ? null : lastActor,
        JSON.stringify(this.board),
        JSON.stringify(winResult.line),
        this.id,
        this.currentRound
      ]
    );

    if (lastActor === 'BOT') {
      this.endMatch({
        winnerId: null,
        loserId: this.p1.userId,
        isBotWin: true,
        winningLine: winResult.line,
        reason: 'NORMAL'
      });
    } else if (lastActor === this.p1.userId) {
      this.endMatch({
        winnerId: this.p1.userId,
        loserId: this.isBot ? null : this.p2.userId,
        isBotWin: false,
        winningLine: winResult.line,
        reason: 'NORMAL'
      });
    } else {
      this.endMatch({
        winnerId: this.p2.userId,
        loserId: this.p1.userId,
        isBotWin: false,
        winningLine: winResult.line,
        reason: 'NORMAL'
      });
    }
  }

  async endMatch({ winnerId, loserId, isBotWin, winningLine = null, reason = 'NORMAL' }) {
    if (this.status !== 'ACTIVE') return;
    this.status = 'COMPLETED';

    clearInterval(this.turnInterval);
    clearTimeout(this.botMoveTimeout);

    // 1. Credit winner reward once
    if (winnerId) {
      await payoutWinnerReward(winnerId, this.winnerReward, this.id);
    }

    // 2. Persist database match completion
    db.run(
      `UPDATE tictactoe_matches 
       SET status = 'COMPLETED', winner_id = ?, loser_id = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [winnerId, loserId, this.id]
    );

    // 3. Update player aggregate statistics & consecutive bot matches / cooldown
    this.updatePlayerStats(winnerId, loserId, isBotWin);

    // 4. Broadcast final game over event
    this.io.to(`match:${this.id}`).emit('tictactoe:game_over', {
      matchId: this.id,
      winnerId,
      loserId,
      isBotWin,
      winningLine,
      winnerReward: this.winnerReward,
      entryFee: this.entryFee,
      totalRounds: this.currentRound,
      reason
    });

    console.log(`🏆 [MATCH COMPLETED] ID: ${this.id}, Winner: ${winnerId || 'BOT'}, Rounds: ${this.currentRound}`);

    // Clean up memory
    activeMatches.delete(this.id);
  }

  updatePlayerStats(winnerId, loserId, isBotWin) {
    const p1Id = this.p1.userId;
    const isP1Winner = winnerId === p1Id;

    if (this.isBot) {
      // Completed bot match -> Update consecutive counter
      db.get(
        'SELECT consecutive_bot_matches FROM tictactoe_player_stats WHERE user_id = ?',
        [p1Id],
        (err, row) => {
          const prev = (row && row.consecutive_bot_matches) || 0;
          const nextCount = prev + 1;
          let cooldownUntil = null;

          if (nextCount >= 3) {
            // Apply 10-minute cooldown
            const tenMinMs = 10 * 60 * 1000;
            cooldownUntil = new Date(Date.now() + tenMinMs).toISOString();
          }

          db.run(
            `INSERT INTO tictactoe_player_stats 
              (user_id, total_matches, bot_matches, wins, losses, total_rounds, coins_spent, coins_won, consecutive_bot_matches, bot_cooldown_until, last_match_at)
             VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET 
               total_matches = total_matches + 1,
               bot_matches = bot_matches + 1,
               wins = wins + excluded.wins,
               losses = losses + excluded.losses,
               total_rounds = total_rounds + excluded.total_rounds,
               coins_spent = coins_spent + excluded.coins_spent,
               coins_won = coins_won + excluded.coins_won,
               consecutive_bot_matches = ?,
               bot_cooldown_until = COALESCE(?, bot_cooldown_until),
               last_match_at = CURRENT_TIMESTAMP`,
            [
              p1Id,
              isP1Winner ? 1 : 0,
              isP1Winner ? 0 : 1,
              this.currentRound,
              this.entryFee,
              isP1Winner ? this.winnerReward : 0,
              nextCount >= 3 ? 3 : nextCount,
              cooldownUntil,
              nextCount >= 3 ? 3 : nextCount,
              cooldownUntil
            ]
          );
        }
      );
    } else {
      // Completed Real Player Match -> Resets consecutive bot match counter to 0!
      const p2Id = this.p2.userId;

      // Player 1 Stats
      db.run(
        `INSERT INTO tictactoe_player_stats 
          (user_id, total_matches, real_matches, wins, losses, total_rounds, coins_spent, coins_won, consecutive_bot_matches, last_match_at)
         VALUES (?, 1, 1, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET 
           total_matches = total_matches + 1,
           real_matches = real_matches + 1,
           wins = wins + excluded.wins,
           losses = losses + excluded.losses,
           total_rounds = total_rounds + excluded.total_rounds,
           coins_spent = coins_spent + excluded.coins_spent,
           coins_won = coins_won + excluded.coins_won,
           consecutive_bot_matches = 0,
           last_match_at = CURRENT_TIMESTAMP`,
        [p1Id, isP1Winner ? 1 : 0, isP1Winner ? 0 : 1, this.currentRound, this.entryFee, isP1Winner ? this.winnerReward : 0]
      );

      // Player 2 Stats
      const isP2Winner = winnerId === p2Id;
      db.run(
        `INSERT INTO tictactoe_player_stats 
          (user_id, total_matches, real_matches, wins, losses, total_rounds, coins_spent, coins_won, consecutive_bot_matches, last_match_at)
         VALUES (?, 1, 1, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET 
           total_matches = total_matches + 1,
           real_matches = real_matches + 1,
           wins = wins + excluded.wins,
           losses = losses + excluded.losses,
           total_rounds = total_rounds + excluded.total_rounds,
           coins_spent = coins_spent + excluded.coins_spent,
           coins_won = coins_won + excluded.coins_won,
           consecutive_bot_matches = 0,
           last_match_at = CURRENT_TIMESTAMP`,
        [p2Id, isP2Winner ? 1 : 0, isP2Winner ? 0 : 1, this.currentRound, this.entryFee, isP2Winner ? this.winnerReward : 0]
      );
    }
  }

  handlePlayerDisconnect(userId) {
    if (this.status !== 'ACTIVE') return;

    this.io.to(`match:${this.id}`).emit('tictactoe:player_disconnected', {
      userId,
      reconnectTimeoutSec: 30
    });

    const timer = setTimeout(() => {
      if (this.status !== 'ACTIVE') return;

      console.log(`[FORFEIT] User ${userId} failed to reconnect within 30s. Forfeited match ${this.id}`);
      if (userId === this.p1.userId) {
        this.endMatch({
          winnerId: this.isBot ? null : this.p2.userId,
          loserId: this.p1.userId,
          isBotWin: this.isBot,
          reason: 'FORFEIT_DISCONNECT'
        });
      } else {
        this.endMatch({
          winnerId: this.p1.userId,
          loserId: this.p2.userId,
          isBotWin: false,
          reason: 'FORFEIT_DISCONNECT'
        });
      }
    }, 30 * 1000);

    this.disconnectTimers.set(userId, timer);
  }

  handlePlayerReconnect(userId, newSocket) {
    if (this.disconnectTimers.has(userId)) {
      clearTimeout(this.disconnectTimers.get(userId));
      this.disconnectTimers.delete(userId);
    }

    if (userId === this.p1.userId) this.p1.socketId = newSocket.id;
    if (!this.isBot && userId === this.p2.userId) this.p2.socketId = newSocket.id;

    newSocket.join(`match:${this.id}`);

    newSocket.emit('tictactoe:reconnect_success', {
      matchId: this.id,
      roundNumber: this.currentRound,
      board: this.board,
      currentTurn: this.currentTurn,
      p1Symbol: this.p1Symbol,
      p2Symbol: this.p2Symbol,
      p1: { userId: this.p1.userId, username: this.p1.username, avatar: this.p1.avatar },
      p2: this.isBot
        ? { userId: 'BOT', username: this.bot.name, avatar: this.bot.avatar_url }
        : { userId: this.p2.userId, username: this.p2.username, avatar: this.p2.avatar },
      secondsLeft: this.turnSecondsLeft
    });

    this.io.to(`match:${this.id}`).emit('tictactoe:player_reconnected', { userId });
  }
}

function createMatchSession(params) {
  const session = new MatchSession(params);
  activeMatches.set(session.id, session);
  session.start();
  return session;
}

function getMatchSession(matchId) {
  return activeMatches.get(matchId);
}

function findMatchByUserId(userId) {
  for (const session of activeMatches.values()) {
    if (session.status === 'ACTIVE') {
      if (session.p1.userId === userId || (!session.isBot && session.p2.userId === userId)) {
        return session;
      }
    }
  }
  return null;
}

module.exports = {
  createMatchSession,
  getMatchSession,
  findMatchByUserId
};
