// backend/services/tictactoeMatchmaking.js

const db = require('../database');
const { getSettings } = require('../database/tictactoeDatabase');
const { deductEntryFee, refundEntryFee } = require('./tictactoeCoinService');

// In-Memory Queue Store
// userId -> { socketId, username, avatar, joinedAt, timer, isSearching }
const queue = new Map();

function checkPlayerBotCooldown(userId) {
  return new Promise((resolve) => {
    db.get(
      'SELECT consecutive_bot_matches, bot_cooldown_until FROM tictactoe_player_stats WHERE user_id = ?',
      [userId],
      (err, row) => {
        if (!row) return resolve({ canPlayBot: true, remainingMs: 0 });

        const now = Date.now();
        if (row.bot_cooldown_until) {
          const cooldownEnd = new Date(row.bot_cooldown_until).getTime();
          if (now < cooldownEnd) {
            return resolve({
              canPlayBot: false,
              remainingMs: cooldownEnd - now,
              cooldownUntil: row.bot_cooldown_until
            });
          }
        }

        resolve({
          canPlayBot: (row.consecutive_bot_matches || 0) < 3,
          consecutiveBotMatches: row.consecutive_bot_matches || 0,
          remainingMs: 0
        });
      }
    );
  });
}

async function joinQueue({ socket, user, onMatchFound, onBotFallback, onTimeout, onError }) {
  const userId = user.id;

  if (queue.has(userId)) {
    return onError(new Error('Already in matchmaking queue'));
  }

  const settings = await getSettings();
  if (settings.is_enabled === '0') {
    return onError(new Error('Tic Tac Toe is temporarily disabled by admin'));
  }

  const entryFee = parseInt(settings.entry_fee || '100', 10);
  const botActivationTimeSec = parseInt(settings.bot_activation_time || '20', 10);
  const searchTimeoutSec = parseInt(settings.real_player_search_time || '30', 10);

  // 1. Check user coin balance
  try {
    const tempMatchId = `QUEUE_${userId}_${Date.now()}`;
    await deductEntryFee(userId, entryFee, tempMatchId);
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return onError(new Error('Insufficient balance to pay entry fee.'));
    }
    return onError(err);
  }

  // 2. Add to queue
  const queueEntry = {
    socketId: socket.id,
    userId: user.id,
    username: user.username,
    avatar: user.avatar || `https://api.dicebear.com/7.x/identicon/png?seed=${user.username}`,
    joinedAt: Date.now(),
    entryFee,
    botTimeout: null,
    totalTimeout: null
  };

  queue.set(userId, queueEntry);

  // 3. Search for available human opponent (FIFO)
  for (const [otherUserId, otherEntry] of queue.entries()) {
    if (otherUserId !== userId) {
      // Clear timers
      clearTimeout(queueEntry.botTimeout);
      clearTimeout(queueEntry.totalTimeout);
      clearTimeout(otherEntry.botTimeout);
      clearTimeout(otherEntry.totalTimeout);

      queue.delete(userId);
      queue.delete(otherUserId);

      return onMatchFound(queueEntry, otherEntry);
    }
  }

  // 4. Timer: Fallback to Bot at configured time (default 20s)
  queueEntry.botTimeout = setTimeout(async () => {
    if (!queue.has(userId)) return;

    // Check 3 consecutive bot match rule and 10-minute cooldown
    const cooldownInfo = await checkPlayerBotCooldown(userId);
    if (!cooldownInfo.canPlayBot) {
      console.log(`[BOT MATCH BLOCKED] User ${userId} reached 3 consecutive bot matches. Cooldown active.`);
      return; // Player remains in queue to await a human until totalTimeout
    }

    // Assign Bot
    queue.delete(userId);
    clearTimeout(queueEntry.totalTimeout);

    db.get(
      'SELECT * FROM tictactoe_bots WHERE is_enabled = 1 ORDER BY RANDOM() LIMIT 1',
      (bErr, bot) => {
        const selectedBot = bot || {
          id: 1,
          name: 'CyberTitan (Bot)',
          avatar_url: 'https://api.dicebear.com/7.x/bottts/png?seed=CyberTitan',
          difficulty: settings.bot_difficulty || 'HARD',
          move_delay_sec: 2
        };
        onBotFallback(queueEntry, selectedBot);
      }
    );
  }, botActivationTimeSec * 1000);

  // 5. Timer: Total Queue Timeout (default 30s)
  queueEntry.totalTimeout = setTimeout(async () => {
    if (!queue.has(userId)) return;
    queue.delete(userId);

    // Refund entry fee
    await refundEntryFee(userId, entryFee, `QUEUE_TIMEOUT_${userId}`);
    onTimeout(queueEntry);
  }, searchTimeoutSec * 1000);
}

async function cancelQueue(userId) {
  const entry = queue.get(userId);
  if (!entry) return false;

  clearTimeout(entry.botTimeout);
  clearTimeout(entry.totalTimeout);
  queue.delete(userId);

  await refundEntryFee(userId, entry.entryFee, `CANCEL_${userId}`);
  return true;
}

function getQueueEntry(userId) {
  return queue.get(userId);
}

module.exports = {
  joinQueue,
  cancelQueue,
  getQueueEntry,
  checkPlayerBotCooldown
};
