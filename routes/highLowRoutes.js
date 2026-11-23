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

// Helper: Fetch High Low System Configuration always live
function getHighLowConfig(callback) {
  db.get("SELECT value FROM app_config WHERE key = 'high_low_config'", (err, row) => {
    const defaultConfig = {
      entryCost: 500,
      startingReward: 500,
      multiplier: 2.0,
      minWinsForClaim: 3,
      aceRule: 'HIGHEST',
      tieRule: 'LOSE',
      isEnabled: true,
      version: 1
    };

    if (err || !row || !row.value) {
      return callback(null, defaultConfig);
    }

    try {
      const parsed = JSON.parse(row.value);
      const cleanConfig = {
        entryCost: parseInt(parsed.entryCost, 10) || 500,
        startingReward: parseInt(parsed.startingReward ?? parsed.entryCost, 10) || 500,
        multiplier: parseFloat(parsed.multiplier) || 2.0,
        minWinsForClaim: parseInt(parsed.minWinsForClaim, 10) || 3,
        aceRule: parsed.aceRule === 'LOWEST' ? 'LOWEST' : 'HIGHEST',
        tieRule: ['WIN', 'PUSH', 'LOSE'].includes(parsed.tieRule) ? parsed.tieRule : 'LOSE',
        isEnabled: parsed.isEnabled !== false,
        version: parsed.version || 1
      };
      callback(null, cleanConfig);
    } catch (e) {
      callback(null, defaultConfig);
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

    const entryFee = config.entryCost;
    const startPrize = config.startingReward;

    db.get('SELECT balance, username FROM users WHERE id = ?', [userId], (uErr, user) => {
      if (uErr || !user) return res.status(404).json({ error: 'User profile not found' });
      if (user.balance < entryFee) {
        return res.status(400).json({
          error: `Insufficient coins. You have ${user.balance} coins, but entry requires ${entryFee} coins.`
        });
      }

      db.get("SELECT id FROM high_low_games WHERE user_id = ? AND status = 'ACTIVE'", [userId], (gErr, existing) => {
        if (existing) {
          return res.status(400).json({
            error: 'You already have an active game in progress. Finish it or wait until resolved.',
            activeGameId: existing.id
          });
        }

        const deck = generateFreshShuffledDeck();
        const startingCard = deck.shift();
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

          // 3. Create game session
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
              startPrize,
              config.version || 1
            ],
            function (insErr) {
              if (insErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Failed to initialize game run' });
              }

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

                res.json({
                  success: true,
                  gameId: gameSessionId,
                  entryCost: entryFee,
                  currentCard: startingCard,
                  cardsRemaining: deck.length,
                  consecutiveWins: 0,
                  potentialReward: startPrize,
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
  const { gameId, prediction } = req.body;

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
          return res.status(400).json({ error: 'No remaining cards in this deck' });
        }

        // Draw next card from the deck
        const revealedCard = remainingDeck.shift();

        const curVal = getRankValue(currentCard.rank, config.aceRule);
        const revVal = getRankValue(revealedCard.rank, config.aceRule);

        let isCorrect = false;
        let isTie = (curVal === revVal);
        let comparisonReason = "";

        if (isTie) {
          comparisonReason = `${revealedCard.display} equals ${currentCard.display} (Tie)`;
          if (config.tieRule === 'WIN') isCorrect = true;
          else if (config.tieRule === 'PUSH') isCorrect = null;
          else isCorrect = false;
        } else if (revVal > curVal) {
          comparisonReason = `${revealedCard.display} is HIGHER than ${currentCard.display}`;
          isCorrect = chosenPrediction === 'HIGHER';
        } else {
          comparisonReason = `${revealedCard.display} is LOWER than ${currentCard.display}`;
          isCorrect = chosenPrediction === 'LOWER';
        }

        const currentStreak = game.consecutive_wins;
        const newStreak = isCorrect === true ? currentStreak + 1 : currentStreak;
        const multiplier = config.multiplier;
        const potentialRewardBefore = game.potential_reward;
        const potentialRewardAfter = isCorrect === true 
          ? Math.floor(potentialRewardBefore * multiplier)
          : (isCorrect === null ? potentialRewardBefore : 0);

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

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

              return res.json({
                success: true,
                result: 'WIN',
                previousCard: currentCard,
                revealedCard: revealedCard,
                prediction: chosenPrediction,
                comparisonReason,
                consecutiveWins: newStreak,
                potentialReward: potentialRewardAfter,
                cardsRemaining: remainingDeck.length,
                canClaim: newStreak >= config.minWinsForClaim,
                message: `Correct! ${comparisonReason}`
              });
            });
          } else if (isCorrect === null) {
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
                previousCard: currentCard,
                revealedCard: revealedCard,
                prediction: chosenPrediction,
                comparisonReason,
                consecutiveWins: currentStreak,
                potentialReward: potentialRewardBefore,
                cardsRemaining: remainingDeck.length,
                canClaim: currentStreak >= config.minWinsForClaim,
                message: `Tie Push! ${comparisonReason}`
              });
            });
          } else {
            // Player lost: Record loss and send back both previousCard and revealedCard
            db.run(
              `UPDATE high_low_games 
               SET current_card = ?, remaining_deck = ?, status = 'LOST', 
                   potential_reward = 0, completed_at = CURRENT_TIMESTAMP 
               WHERE id = ?`,
              [JSON.stringify(revealedCard), JSON.stringify(remainingDeck), gameId]
            );

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

              return res.json({
                success: true,
                result: 'LOSS',
                previousCard: currentCard,
                revealedCard: revealedCard,
                prediction: chosenPrediction,
                comparisonReason,
                consecutiveWins: currentStreak,
                lostReward: potentialRewardBefore,
                potentialReward: 0,
                cardsRemaining: remainingDeck.length,
                canClaim: false,
                message: `You Predicted ${chosenPrediction}. ${comparisonReason}`
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

        const minWins = config.minWinsForClaim;
        if (game.consecutive_wins < minWins) {
          return res.status(400).json({
            error: `Minimum ${minWins} consecutive wins required to claim. Current wins: ${game.consecutive_wins}`
          });
        }

        const rewardCoins = game.potential_reward;

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

          db.run(
            `UPDATE high_low_games 
             SET status = 'CLAIMED', claimed_reward = ?, completed_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [rewardCoins, gameId]
          );

          db.run(
            `UPDATE users 
             SET balance = balance + ?, 
                 total_coins_earned = COALESCE(total_coins_earned, 0) + ? 
             WHERE id = ?`,
            [rewardCoins, rewardCoins, userId]
          );

          db.run(
            `INSERT INTO transactions (user_id, type, amount, reference_id) 
             VALUES (?, 'HIGH_LOW_CLAIM', ?, ?)`,
            [userId, rewardCoins, gameId]
          );

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
      g.completed_at
    FROM high_low_games g
    WHERE g.user_id = ?
    ORDER BY g.started_at DESC
    LIMIT 50
  `;

  db.all(sql, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to retrieve match history' });
    res.json({ history: rows || [] });
  });
});

module.exports = router;
