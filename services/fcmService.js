// backend/services/fcmService.js

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');
const db = require('../database');

let isFcmInitialized = false;

function initFirebaseAdmin() {
  if (isFcmInitialized || admin.apps.length > 0) {
    isFcmInitialized = true;
    return true;
  }

  try {
    let serviceAccount = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else {
      const defaultPath = path.join(__dirname, '..', 'firebase-service-account.json');
      if (fs.existsSync(defaultPath)) {
        serviceAccount = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
      }
    }

    if (!serviceAccount) {
      console.warn('⚠️ [FCM] firebase-service-account.json not found. Push notifications disabled until configured.');
      return false;
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    isFcmInitialized = true;
    console.log('✅ [FCM] Firebase Admin SDK initialized successfully.');
    return true;
  } catch (err) {
    console.error('❌ [FCM] Failed to initialize Firebase Admin SDK:', err.message);
    return false;
  }
}

// Initialize on module load
initFirebaseAdmin();

function isInvalidTokenError(code = '') {
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/invalid-argument'
  );
}

function clearInvalidTokens(tokens = []) {
  if (!tokens.length) return;
  const placeholders = tokens.map(() => '?').join(',');
  db.run(
    `UPDATE users SET fcm_token = NULL WHERE fcm_token IN (${placeholders})`,
    tokens,
    (err) => {
      if (err) console.error('[FCM] Failed clearing stale tokens:', err.message);
    }
  );
}

function sanitizeDataPayload(data = {}) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v !== undefined && v !== null) {
      out[String(k)] = String(v);
    }
  }
  return out;
}

/**
 * Send push notification to a single user by userId
 */
async function sendToUser(userId, { title, body, data = {} }) {
  if (!initFirebaseAdmin()) {
    return { success: false, error: 'Firebase Admin SDK is not configured on server.' };
  }

  return new Promise((resolve) => {
    db.get(
      'SELECT id, username, fcm_token FROM users WHERE id = ?',
      [userId],
      async (err, user) => {
        if (err || !user) {
          return resolve({ success: false, error: 'User not found' });
        }
        if (!user.fcm_token || !user.fcm_token.trim()) {
          return resolve({
            success: false,
            error: `User @${user.username} does not have an FCM token yet (user has not opened the updated app or denied notifications).`
          });
        }

        const token = user.fcm_token.trim();
        const message = {
          token,
          notification: {
            title: String(title),
            body: String(body),
          },
          data: sanitizeDataPayload(data),
          android: {
            priority: 'high',
            notification: {
              channelId: 'arena_games_high_importance',
              sound: 'default',
            },
          },
          apns: {
            payload: {
              aps: { sound: 'default' },
            },
          },
        };

        try {
          const messageId = await getMessaging().send(message);
          resolve({
            success: true,
            messageId,
            username: user.username,
            targetedCount: 1,
            successCount: 1,
            failureCount: 0,
          });
        } catch (sendErr) {
          const errCode = sendErr?.errorInfo?.code || sendErr?.code || '';
          if (isInvalidTokenError(errCode)) {
            clearInvalidTokens([token]);
          }
          resolve({
            success: false,
            error: sendErr.message || 'Failed to send FCM message',
            targetedCount: 1,
            successCount: 0,
            failureCount: 1,
          });
        }
      }
    );
  });
}

/**
 * Send push notification to multiple users based on audience filter
 * audience: 'all' | 'active_24h' | 'inactive_3d' | 'inactive_7d' | 'inactive_30d'
 */
async function sendToAudience({ title, body, data = {}, audience = 'all' }) {
  if (!initFirebaseAdmin()) {
    return { success: false, error: 'Firebase Admin SDK is not configured on server.' };
  }

  let whereExtra = '';
  if (audience === 'active_24h') {
    whereExtra = `AND datetime(COALESCE(last_active_at, created_at)) >= datetime('now', '-1 day')`;
  } else if (audience === 'inactive_3d') {
    whereExtra = `AND datetime(COALESCE(last_active_at, created_at)) <= datetime('now', '-3 days')`;
  } else if (audience === 'inactive_7d') {
    whereExtra = `AND datetime(COALESCE(last_active_at, created_at)) <= datetime('now', '-7 days')`;
  } else if (audience === 'inactive_30d') {
    whereExtra = `AND datetime(COALESCE(last_active_at, created_at)) <= datetime('now', '-30 days')`;
  }

  return new Promise((resolve) => {
    db.all(
      `SELECT id, fcm_token
       FROM users
       WHERE is_banned = 0
         AND fcm_token IS NOT NULL
         AND TRIM(fcm_token) != ''
         ${whereExtra}`,
      async (err, rows) => {
        if (err) {
          return resolve({ success: false, error: 'Database query failed' });
        }

        const uniqueTokens = Array.from(
          new Set((rows || []).map((r) => r.fcm_token.trim()).filter(Boolean))
        );

        if (uniqueTokens.length === 0) {
          return resolve({
            success: false,
            error: 'No reachable users with valid FCM tokens match this audience.',
            targetedCount: 0,
            successCount: 0,
            failureCount: 0,
          });
        }

        const messaging = getMessaging();
        const cleanData = sanitizeDataPayload(data);
        const invalidTokens = [];
        let successCount = 0;
        let failureCount = 0;

        // FCM sendEachForMulticast supports max 500 tokens per batch
        const BATCH_SIZE = 500;
        for (let i = 0; i < uniqueTokens.length; i += BATCH_SIZE) {
          const batch = uniqueTokens.slice(i, i + BATCH_SIZE);
          try {
            const response = await messaging.sendEachForMulticast({
              tokens: batch,
              notification: {
                title: String(title),
                body: String(body),
              },
              data: cleanData,
              android: {
                priority: 'high',
                notification: {
                  channelId: 'arena_games_high_importance',
                  sound: 'default',
                },
              },
              apns: {
                payload: {
                  aps: { sound: 'default' },
                },
              },
            });

            successCount += response.successCount || 0;
            failureCount += response.failureCount || 0;

            (response.responses || []).forEach((resp, idx) => {
              if (!resp.success && resp.error) {
                const code = resp.error.code || '';
                if (isInvalidTokenError(code)) {
                  invalidTokens.push(batch[idx]);
                }
              }
            });
          } catch (batchErr) {
            console.error('[FCM] Batch multicast error:', batchErr.message);
            failureCount += batch.length;
          }
        }

        if (invalidTokens.length > 0) {
          clearInvalidTokens(invalidTokens);
        }

        resolve({
          success: true,
          targetedCount: uniqueTokens.length,
          successCount,
          failureCount,
          cleanedInvalidTokens: invalidTokens.length,
        });
      }
    );
  });
}

module.exports = {
  initFirebaseAdmin,
  sendToUser,
  sendToAudience,
};
