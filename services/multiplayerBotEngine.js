// backend/services/multiplayerBotEngine.js
const crypto = require('crypto');

// --- TIC TAC TOE BOT ENGINE ---
const WINNING_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
  [0, 4, 8], [2, 4, 6]             // Diagonals
];

function evaluateTttWin(board, mark) {
  return WINNING_COMBOS.some(combo => combo.every(idx => board[idx] === mark));
}

function getBestTttMove(board, botMark, playerMark, difficulty = 'HARD') {
  const emptyCells = board.map((val, idx) => (val === null ? idx : null)).filter(v => v !== null);
  if (emptyCells.length === 0) return null;

  if (difficulty === 'EASY') {
    return emptyCells[Math.floor(Math.random() * emptyCells.length)];
  }

  // 1. Take immediate win
  for (const idx of emptyCells) {
    board[idx] = botMark;
    if (evaluateTttWin(board, botMark)) {
      board[idx] = null;
      return idx;
    }
    board[idx] = null;
  }

  // 2. Block player's immediate win
  for (const idx of emptyCells) {
    board[idx] = playerMark;
    if (evaluateTttWin(board, playerMark)) {
      board[idx] = null;
      return idx;
    }
    board[idx] = null;
  }

  // 3. Medium chooses random if not immediate win/block
  if (difficulty === 'MEDIUM') {
    return emptyCells[Math.floor(Math.random() * emptyCells.length)];
  }

  // 4. Hard / Expert: Take center if available
  if (board[4] === null) return 4;

  // 5. Take corners
  const corners = [0, 2, 6, 8].filter(idx => board[idx] === null);
  if (corners.length > 0) {
    return corners[Math.floor(Math.random() * corners.length)];
  }

  return emptyCells[Math.floor(Math.random() * emptyCells.length)];
}

// --- ROCK PAPER SCISSORS BOT ENGINE ---
function getRpsMove(difficulty = 'HARD') {
  const choices = ['ROCK', 'PAPER', 'SCISSORS'];
  const randIndex = crypto.randomInt(0, 3);
  return choices[randIndex];
}

// --- HEAD OR TAILS BOT ENGINE & FAIR GENERATOR ---
function getFairCoinFlip() {
  // Cryptographically secure flip
  return crypto.randomInt(0, 2) === 0 ? 'HEADS' : 'TAILS';
}

function getBotCoinGuess() {
  return crypto.randomInt(0, 2) === 0 ? 'HEADS' : 'TAILS';
}

module.exports = {
  getBestTttMove,
  evaluateTttWin,
  getRpsMove,
  getFairCoinFlip,
  getBotCoinGuess
};
