// backend/routes/highLowRoutes.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const authenticateToken = require('../middleware/auth');

// Standard 52-Card Suits and Ranks
const SUITS = ['HEARTS', 'DIAMONDS', 'CLUBS', 'SPADES'];
const SUIT_ICONS = { HEARTS: '♥', DIAMONDS: '♦', CLUBS: '♣', SPADES: '♠' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Cryptographically secure Fisher-Yates deck shuffle
function generateFreshShuffledDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        rank,
        suit,
        display: `${rank} ${SUIT_ICONS[suit]}`
      });
    }
  }

  // Fisher-Yates with crypto.randomBytes
  for (let i = deck.length - 1; i > 0; i--) {
    const randomBuffer = crypto.randomBytes(4);
    const randomIndex = randomBuffer.readUInt32BE(0) % (i + 1);
    [deck[i], deck[randomIndex]] = [deck[randomIndex], deck[i]];
  }

  return deck;
}

// Compare card ranks based on game configuration
function getRankValue(rank, aceRule = 'HIGHEST') {
  if (rank === 'A') return aceRule === 'HIGHEST' ? 14 : 1;
  if (rank === 'K') return 13;
  if (rank === 'Q') return 12;
  if (rank === 'J') return 11;
  return parseInt(rank, 10);
}

// Helper: Fetch High Low System Configuration
function getHighLowConfig(callback) {
  db.get("SELECT value FROM app_config WHERE key = 'high_low_config'", (err, row) => {
    if (err || !row || !row.value) {
      const defaultConfig = {
        entryCost: 500,
        startingReward: 500,
        multiplier: 2.0,
        minWinsForClaim: 3,
        aceRule: 'HIGHEST', // 'HIGHEST' or 'LOWEST'
        tieRule: 'LOSE',    // 'LOSE', 'PUSH', or 'WIN'
        isEnabled: true,
        version: 1
      };
      return callback(null, defaultConfig);
    }
    try {
      callback(null, JSON.parse(row.value));
    } catch (e) {
      callback(e, null);
    }
  });
}

// ---------------------------------------------------------------------------
// 1. GET CONFIG & USER STATUS (GET /api/high-low/status)
// ---------------------------------------------------------------------------
router.get('/status', authenticateToken, (req, res) => {
  const userId = req.user.id;

  getHighLowConfig((cfgErr, config) => {
    if (cfgErr) return res.status(500).json({ error: 'Config read failure' });

    db.get('SELECT balance FROM users WHERE id = ?', [userId], (uErr, user) => {
      if (uErr || !user) return res.status(404).json({ error: 'User not found' });

      // Check for active unfinished session
      db.get(
        `SELECT * FROM high_low_games 
         WHERE user_id = ? AND status = 'ACTIVE' 
         ORDER BY id DESC LIMIT 1`,
        [userId],
        (sErr, activeGame) => {
          if (sErr) return res.status(500).json({ error: 'Game lookup error' });

          let currentGameState = null;
          if (activeGame) {
            let deck = [];
            try { deck = JSON.parse(activeGame.remaining_deck || '[]'); } catch (_) {}

            currentGameState = {
              gameId: activeGame.id,
              currentCard: JSON.parse(activeGame.current_card),
              consecutiveWins: activeGame.consecutive_wins,
              potentialReward: activeGame.potential_reward,
              cardsRemaining: deck.length,
              canClaim: activeGame.consecutive_wins >= config.minWinsForClaim
            };
          }

          res.json({
            config,
            userBalance: user.balance,
            activeGame: currentGameState
          });
        }
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 2. START A NEW GAME SESSION (POST /api/high-low/start)
// ---------------------------------------------------------------------------
router.post('/start', authenticateToken, (req, res) => {
  const userId = req.user.id;

  getHighLowConfig((cfgErr, config) => {
    if (cfgErr) return res.status(500).json({ error: 'Config read error' });
    if (!config.isEnabled) {
      return res.status(403).json({ error: 'High or Low is currently in maintenance mode' });
    }

    const entryFee = config.entryCost || 500;

    // Check user balance and active games
    db.get('SELECT balance, username FROM users WHERE id = ?', [userId], (uErr, user) => {
      if (uErr || !user) return res.status(404).json({ error: 'User profile not found' });
      if (user.balance < entryFee) {
        return res.status(400).json({
          error: `Insufficient coins. You have ${user.balance} coins, but entry requires ${entryFee} coins.`
        });
      }

      // Check for existing active game
      db.get("SELECT id FROM high_low_games WHERE user_id = ? AND status = 'ACTIVE'", [userId], (gErr, existing) => {
        if (existing) {
          return res.status(400).json({
            error: 'You already have an active game in progress. Please complete or forfeit it before starting a new one.',
            activeGameId: existing.id
          });
        }

        // Generate and shuffle fresh 52-card deck
        const deck = generateFreshShuffledDeck();
        const startingCard = deck.shift(); // Draw the first card
        const gameSessionId = `HL_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

          // 1. Deduct entry cost
          db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [entryFee, userId]);

          // 2. Insert transaction ledger entry
          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) 
             VALUES (?, 'HIGH_LOW_ENTRY', ?, ?)`,
            [userId, -entryFee, gameSessionId]
          );

          // 3. Create High-Low game record
          db.run(
            `INSERT INTO high_low_games (
              id, user_id, entry_cost, starting_card, current_card, 
              remaining_deck, consecutive_wins, potential_reward, status, config_version
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'ACTIVE', ?)`,
            [
              gameSessionId,
              userId,
              entryFee,
              JSON.stringify(startingCard),
              JSON.stringify(startingCard),
              JSON.stringify(deck),
              config.startingReward || 500,
              config.version || 1
            ],
            function (insErr) {
              if (insErr) {
                db.run('ROLLBACK');
                console.error('[HL START ERROR]', insErr);
                return res.status(500).json({ error: 'Failed to initialize game run' });
              }

              // Update user stats
              db.run(
                `INSERT INTO high_low_user_stats (user_id, total_games, total_coins_spent)
                 VALUES (?, 1, ?)
                 ON CONFLICT(user_id) DO UPDATE SET
                   total_games = total_games + 1,
                   total_coins_spent = total_coins_spent + excluded.total_coins_spent`,
                [userId, entryFee]
              );

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Commit failed on game initialization' });
                }

                console.log(`[HL START] Game ${gameSessionId} initialized for User ${userId}. Starting Card: ${startingCard.display}`);

                res.json({
                  success: true,
                  gameId: gameSessionId,
                  entryCost: entryFee,
                  currentCard: startingCard,
                  cardsRemaining: deck.length,
                  consecutiveWins: 0,
                  potentialReward: config.startingReward || 500,
                  minWinsForClaim: config.minWinsForClaim
                });
              });
            }
          );
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. SUBMIT CARD PREDICTION (POST /api/high-low/predict)
// ---------------------------------------------------------------------------
router.post('/predict', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { gameId, prediction } = req.body; // prediction: 'HIGHER' | 'LOWER'

  if (!gameId || !prediction || !['HIGHER', 'LOWER'].includes(prediction.toUpperCase())) {
    return res.status(400).json({ error: 'Valid gameId and prediction (HIGHER or LOWER) required' });
  }

  const chosenPrediction = prediction.toUpperCase();

  db.get(
    `SELECT * FROM high_low_games WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`,
    [gameId, userId],
    (err, game) => {
      if (err || !game) {
        return res.status(400).json({ error: 'Active game run not found or already concluded' });
      }

      getHighLowConfig((cfgErr, config) => {
        if (cfgErr) return res.status(500).json({ error: 'Configuration lookup error' });

        let currentCard;
        let remainingDeck = [];
        try {
          currentCard = JSON.parse(game.current_card);
          remainingDeck = JSON.parse(game.remaining_deck || '[]');
        } catch (e) {
          return res.status(500).json({ error: 'Corrupt game deck state' });
        }

        if (remainingDeck.length === 0) {
          return res.status(400).json({ error: 'No remaining cards in this 52-card deck' });
        }

        // Draw next card purely server-side
        const revealedCard = remainingDeck.shift();

        const curVal = getRankValue(currentCard.rank, config.aceRule);
        const revVal = getRankValue(revealedCard.rank, config.aceRule);

        let isCorrect = false;
        let isTie = (curVal === revVal);

        if (isTie) {
          if (config.tieRule === 'WIN') isCorrect = true;
          else if (config.tieRule === 'PUSH') isCorrect = null; // Stays on same card
          else isCorrect = false; // Default LOSE
        } else if (chosenPrediction === 'HIGHER') {
          isCorrect = revVal > curVal;
        } else if (chosenPrediction === 'LOWER') {
          isCorrect = revVal < curVal;
        }

        const currentStreak = game.consecutive_wins;
        const newStreak = isCorrect === true ? currentStreak + 1 : currentStreak;
        const rewardMultiplier = config.multiplier || 2.0;
        const potentialRewardBefore = game.potential_reward;
        const potentialRewardAfter = isCorrect === true 
          ? Math.floor(potentialRewardBefore * rewardMultiplier)
          : (isCorrect === null ? potentialRewardBefore : 0);

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

          // Record action in high_low_predictions
          db.run(
            `INSERT INTO high_low_predictions (
              game_id, user_id, current_card, prediction, revealed_card, 
              result, reward_before, reward_after
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              gameId,
              userId,
              JSON.stringify(currentCard),
              chosenPrediction,
              JSON.stringify(revealedCard),
              isCorrect === true ? 'WIN' : (isCorrect === null ? 'PUSH' : 'LOSS'),
              potentialRewardBefore,
              potentialRewardAfter
            ]
          );

          if (isCorrect === true) {
            // Player guessed correctly; game continues
            db.run(
              `UPDATE high_low_games 
               SET current_card = ?, remaining_deck = ?, consecutive_wins = ?, 
                   potential_reward = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [
                JSON.stringify(revealedCard),
                JSON.stringify(remainingDeck),
                newStreak,
                potentialRewardAfter,
                gameId
              ]
            );

            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Database update failed' });
              }

              console.log(`[HL WIN] Game ${gameId}: ${revealedCard.display} (${chosenPrediction}) -> Won! Streak: ${newStreak}, Potential: ${potentialRewardAfter}`);

              return res.json({
                success: true,
                result: 'WIN',
                revealedCard,
                consecutiveWins: newStreak,
                potentialReward: potentialRewardAfter,
                cardsRemaining: remainingDeck.length,
                canClaim: newStreak >= config.minWinsForClaim,
                message: `Correct prediction! Potential reward doubled to ${potentialRewardAfter} coins.`
              });
            });
          } else if (isCorrect === null) {
            // Tie push
            db.run(
              `UPDATE high_low_games 
               SET remaining_deck = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [JSON.stringify(remainingDeck), gameId]
            );

            db.run('COMMIT', () => {
              return res.json({
                success: true,
                result: 'PUSH',
                revealedCard,
                consecutiveWins: currentStreak,
                potentialReward: potentialRewardBefore,
                cardsRemaining: remainingDeck.length,
                canClaim: currentStreak >= config.minWinsForClaim,
                message: 'Tie! Card ranks were equal. Potential reward stays the same.'
              });
            });
          } else {
            // Player lost: Run ends and potential reward is forfeited
            db.run(
              `UPDATE high_low_games 
               SET current_card = ?, remaining_deck = ?, status = 'LOST', 
                   potential_reward = 0, completed_at = CURRENT_TIMESTAMP 
               WHERE id = ?`,
              [JSON.stringify(revealedCard), JSON.stringify(remainingDeck), gameId]
            );

            // Update user stats
            db.run(
              `UPDATE high_low_user_stats 
               SET total_losses = total_losses + 1,
                   highest_streak = MAX(highest_streak, ?),
                   total_potential_lost = total_potential_lost + ?
               WHERE user_id = ?`,
              [currentStreak, potentialRewardBefore, userId]
            );

            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Database update failed on loss' });
              }

              console.log(`[HL LOSS] Game ${gameId}: ${revealedCard.display} (${chosenPrediction}) -> Lost ${potentialRewardBefore} coins.`);

              return res.json({
                success: true,
                result: 'LOSS',
                revealedCard,
                consecutiveWins: currentStreak,
                lostReward: potentialRewardBefore,
                potentialReward: 0,
                cardsRemaining: remainingDeck.length,
                canClaim: false,
                message: `Incorrect prediction. You lost the potential reward of ${potentialRewardBefore} coins.`
              });
            });
          }
        });
      });
    }
  );
});

// ---------------------------------------------------------------------------
// 4. CLAIM ACCUMULATED REWARD (POST /api/high-low/claim)
// ---------------------------------------------------------------------------
router.post('/claim', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { gameId } = req.body;

  if (!gameId) {
    return res.status(400).json({ error: 'gameId is required' });
  }

  getHighLowConfig((cfgErr, config) => {
    if (cfgErr) return res.status(500).json({ error: 'Config fetch error' });

    db.get(
      `SELECT * FROM high_low_games WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`,
      [gameId, userId],
      (err, game) => {
        if (err || !game) {
          return res.status(400).json({ error: 'No active session eligible for claim' });
        }

        const minWins = config.minWinsForClaim || 3;
        if (game.consecutive_wins < minWins) {
          return res.status(400).json({
            error: `Minimum ${minWins} consecutive wins required to claim. Current wins: ${game.consecutive_wins}`
          });
        }

        const rewardCoins = game.potential_reward;
        if (rewardCoins <= 0) {
          return res.status(400).json({ error: 'No potential reward to claim' });
        }

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

          // 1. Mark game completed
          db.run(
            `UPDATE high_low_games 
             SET status = 'CLAIMED', claimed_reward = ?, completed_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [rewardCoins, gameId]
          );

          // 2. Credit coins to player wallet
          db.run(
            `UPDATE users 
             SET balance = balance + ?, 
                 total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
             WHERE id = ?`,
            [rewardCoins, rewardCoins, userId]
          );

          // 3. Insert transaction record
          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) 
             VALUES (?, 'HIGH_LOW_CLAIM', ?, ?)`,
            [userId, rewardCoins, gameId]
          );

          // 4. Update user statistics
          db.run(
            `UPDATE high_low_user_stats 
             SET total_wins = total_wins + 1,
                 highest_streak = MAX(highest_streak, ?),
                 total_coins_rewarded = total_coins_rewarded + ?,
                 highest_reward_claimed = MAX(highest_reward_claimed, ?)
             WHERE user_id = ?`,
            [game.consecutive_wins, rewardCoins, rewardCoins, userId]
          );

          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: 'Failed to credit claimed coins' });
            }

            console.log(`[HL CLAIMED] User ${userId} successfully claimed +${rewardCoins} coins from Game ${gameId}!`);

            res.json({
              success: true,
              claimedCoins: rewardCoins,
              consecutiveWins: game.consecutive_wins,
              message: `🎉 Successfully claimed ${rewardCoins.toLocaleString()} coins!`
            });
          });
        });
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 5. USER GAME HISTORY (GET /api/high-low/my-history)
// ---------------------------------------------------------------------------
router.get('/my-history', authenticateToken, (req, res) => {
  const userId = req.user.id;

  const sql = `
    SELECT 
      g.id,
      g.entry_cost,
      g.starting_card,
      g.current_card,
      g.consecutive_wins,
      g.potential_reward,
      g.claimed_reward,
      g.status,
      g.started_at,
      g.completed_at,
      COUNT(p.id) as total_predictions
    FROM high_low_games g
    LEFT JOIN high_low_predictions p ON g.id = p.game_id
    WHERE g.user_id = ?
    GROUP BY g.id
    ORDER BY g.started_at DESC
    LIMIT 50
  `;

  db.all(sql, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to retrieve match history' });
    res.json({ history: rows || [] });
  });
});

// ---------------------------------------------------------------------------
// 6. DETAILED GAME RUN INSPECTION (GET /api/high-low/game/:gameId)
// ---------------------------------------------------------------------------
router.get('/game/:gameId', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const gameId = req.params.gameId;

  db.get('SELECT * FROM high_low_games WHERE id = ? AND user_id = ?', [gameId, userId], (gErr, game) => {
    if (gErr || !game) return res.status(404).json({ error: 'Match record not found' });

    db.all(
      'SELECT * FROM high_low_predictions WHERE game_id = ? ORDER BY id ASC',
      [gameId],
      (pErr, predictions) => {
        if (pErr) return res.status(500).json({ error: 'Failed to retrieve moves' });

        res.json({
          game,
          predictions: predictions || []
        });
      }
    );
  });
});

module.exports = router;
