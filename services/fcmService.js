// backend/services/fcmService.js

const fs = require('fs');
const path = require('path');
const { initializeApp, getApps, cert, SDK_VERSION } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const db = require('../database');

let isFcmInitialized = false;

function getAdminSdkVersion() {
  return String(SDK_VERSION || '0.0.0');
}

function supportsFidTargetField() {
  try {
    const parts = getAdminSdkVersion().split('.');
    const major = parseInt(parts[0], 10) || 0;
    const minor = parseInt(parts[1], 10) || 0;
    return major > 14 || (major === 14 && minor >= 1);
  } catch {
    return false;
  }
}

function isFidString(val = '') {
  const s = String(val).trim();
  return s.length > 0 && !s.includes(':') && s.length <= 40;
}

function initFirebaseAdmin() {
  if (isFcmInitialized || getApps().length > 0) {
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

    initializeApp({
      credential: cert(serviceAccount),
    });

    isFcmInitialized = true;
    console.log(`✅ [FCM] Firebase Admin SDK v${getAdminSdkVersion()} initialized (FID support: ${supportsFidTargetField()}).`);
    return true;
  } catch (err) {
    console.error('❌ [FCM] Failed to initialize Firebase Admin SDK:', err.message);
    return false;
  }
}

initFirebaseAdmin();

function isInvalidTokenError(code = '') {
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/installation-id-not-registered' ||
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
      if (err) console.error('[FCM] Failed clearing stale tokens/FIDs:', err.message);
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
            error: `User @${user.username} does not have an FCM ID yet (user has not opened the updated app or denied notifications).`
          });
        }

        const targetId = user.fcm_token.trim();
        const useFid = supportsFidTargetField() && isFidString(targetId);

        const message = {
          ...(useFid ? { fid: targetId } : { token: targetId }),
          notification: {
            title: String(title),
            body: String(body),
          },
          data: sanitizeDataPayload(data),
          android: {
            priority: 'high',
            notification: {
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
          const errMsg = sendErr?.errorInfo?.message || sendErr?.message || 'Failed to send FCM message';
          console.error(`❌ [FCM sendToUser error] (${useFid ? 'fid' : 'token'}) [${errCode}]: ${errMsg}`);
          if (isInvalidTokenError(errCode)) {
            clearInvalidTokens([targetId]);
          }
          resolve({
            success: false,
            error: `[${errCode}] ${errMsg}`,
            targetedCount: 1,
            successCount: 0,
            failureCount: 1,
          });
        }
      }
    );
  });
}

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

        const uniqueIds = Array.from(
          new Set((rows || []).map((r) => r.fcm_token.trim()).filter(Boolean))
        );

        if (uniqueIds.length === 0) {
          return resolve({
            success: false,
            error: 'No reachable users with valid FCM IDs match this audience.',
            targetedCount: 0,
            successCount: 0,
            failureCount: 0,
          });
        }

        const messaging = getMessaging();
        const cleanData = sanitizeDataPayload(data);
        const canUseFidsField = supportsFidTargetField();
        const invalidIds = [];
        let successCount = 0;
        let failureCount = 0;
        let firstError = '';

        const BATCH_SIZE = 500;
        for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
          const batch = uniqueIds.slice(i, i + BATCH_SIZE);
          const fidsBatch = canUseFidsField ? batch.filter(isFidString) : [];
          const tokensBatch = canUseFidsField ? batch.filter((x) => !isFidString(x)) : batch;

          const orderedTargets = [...tokensBatch, ...fidsBatch];
          const payload = {
            ...(tokensBatch.length > 0 ? { tokens: tokensBatch } : {}),
            ...(fidsBatch.length > 0 ? { fids: fidsBatch } : {}),
            notification: {
              title: String(title),
              body: String(body),
            },
            data: cleanData,
            android: {
              priority: 'high',
              notification: {
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
            const response = await messaging.sendEachForMulticast(payload);

            successCount += response.successCount || 0;
            failureCount += response.failureCount || 0;

            (response.responses || []).forEach((resp, idx) => {
              if (!resp.success && resp.error) {
                const code = resp.error.code || '';
                const msg = resp.error.message || '';
                console.error(`❌ [FCM multicast item error] [${code}]: ${msg}`);
                if (!firstError) firstError = `[${code}] ${msg}`;
                if (isInvalidTokenError(code)) {
                  invalidIds.push(orderedTargets[idx]);
                }
              }
            });
          } catch (batchErr) {
            console.error('❌ [FCM] Batch multicast error:', batchErr.message);
            if (!firstError) firstError = batchErr.message;
            failureCount += batch.length;
          }
        }

        if (invalidIds.length > 0) {
          clearInvalidTokens(invalidIds);
        }

        resolve({
          success: true,
          targetedCount: uniqueIds.length,
          successCount,
          failureCount,
          firstError,
          cleanedInvalidTokens: invalidIds.length,
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
