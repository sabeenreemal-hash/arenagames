// backend/services/tictactoeBot.js

const WIN_COMBINATIONS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
  [0, 4, 8], [2, 4, 6]             // Diagonals
];

function checkWinner(board) {
  for (const [a, b, c] of WIN_COMBINATIONS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  if (board.every(cell => cell !== '' && cell !== null)) {
    return { winner: 'DRAW', line: null };
  }
  return null;
}

function getAvailableMoves(board) {
  const moves = [];
  for (let i = 0; i < 9; i++) {
    if (!board[i] || board[i] === '') moves.push(i);
  }
  return moves;
}

function minimax(board, depth, isMaximizing, botSymbol, humanSymbol, alpha = -1000, beta = 1000) {
  const result = checkWinner(board);
  if (result) {
    if (result.winner === botSymbol) return 10 - depth;
    if (result.winner === humanSymbol) return depth - 10;
    if (result.winner === 'DRAW') return 0;
  }

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of getAvailableMoves(board)) {
      board[move] = botSymbol;
      const evalVal = minimax(board, depth + 1, false, botSymbol, humanSymbol, alpha, beta);
      board[move] = '';
      maxEval = Math.max(maxEval, evalVal);
      alpha = Math.max(alpha, evalVal);
      if (beta <= alpha) break;
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const move of getAvailableMoves(board)) {
      board[move] = humanSymbol;
      const evalVal = minimax(board, depth + 1, true, botSymbol, humanSymbol, alpha, beta);
      board[move] = '';
      minEval = Math.min(minEval, evalVal);
      beta = Math.min(beta, evalVal);
      if (beta <= alpha) break;
    }
    return minEval;
  }
}

function getBestMove(board, botSymbol, difficulty = 'HARD') {
  const humanSymbol = botSymbol === 'X' ? 'O' : 'X';
  const available = getAvailableMoves(board);
  if (available.length === 0) return null;

  // Easy: 60% chance of random move
  if (difficulty === 'EASY' && Math.random() < 0.6) {
    return available[Math.floor(Math.random() * available.length)];
  }

  // Medium: 30% chance of random move
  if (difficulty === 'MEDIUM' && Math.random() < 0.3) {
    return available[Math.floor(Math.random() * available.length)];
  }

  // Strategic Rules:
  // 1. Take Immediate Win
  for (const move of available) {
    board[move] = botSymbol;
    const res = checkWinner(board);
    board[move] = '';
    if (res && res.winner === botSymbol) return move;
  }

  // 2. Block Opponent Win
  for (const move of available) {
    board[move] = humanSymbol;
    const res = checkWinner(board);
    board[move] = '';
    if (res && res.winner === humanSymbol) return move;
  }

  // 3. Take Center if free
  if (available.includes(4)) return 4;

  // 4. Minimax optimal move calculation
  let bestScore = -Infinity;
  let bestMove = available[0];

  for (const move of available) {
    board[move] = botSymbol;
    const score = minimax(board, 0, false, botSymbol, humanSymbol);
    board[move] = '';
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}

module.exports = {
  checkWinner,
  getAvailableMoves,
  getBestMove,
  WIN_COMBINATIONS
};
