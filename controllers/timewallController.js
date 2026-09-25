// offerwall.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('./core/db'); // Adjust path to your SQLite database connection

// 1. TimeWall & RubyLune Whitelisted IPs
const WHITELISTED_IPS = new Set([
  '18.156.132.55',
  '51.81.120.73',
  '142.111.248.18',
  '36.253.137.4' // RubyLune server IP (e.g. ping rubylune.com)
]);

// 2. Secret Key from TimeWall dashboard
const TIMEWALL_SECRET_KEY = "YOUR_TIMEWALL_SECRET_KEY";

// Helper: Get real visitor IP through Nginx / RubyLune
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || (req.socket.remoteAddress ? req.socket.remoteAddress.replace(/^.*:/, '') : '');
}

/**
 * Route: /postback/timewall (Handles both GET and POST)
 */
router.all('/timewall', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const isRubyLuneRelay = req.headers['x-rubylune-relay'] === 'true';

    // A. IP Whitelist Check (Ignored in development or if verified relay header present)
    if (process.env.NODE_ENV === 'production' && !isRubyLuneRelay && !WHITELISTED_IPS.has(clientIp)) {
      console.warn(`[TIMEWALL BLOCKED] Unauthorized IP: ${clientIp}`);
      return res.status(403).send('Forbidden');
    }

    const params = { ...req.query, ...req.body };
    const {
      userid,
      txid,
      revenue,
      hash,
      type = 'credit',
      offername = 'TimeWall Offer',
      offerdetail = ''
    } = params;

    // B. Validate Required Fields
    if (!userid || !txid || !revenue || !hash) {
      return res.status(400).send('Missing mandatory parameters');
    }

    // C. Validate SHA-256 Signature Hash
    // Formula: hash("sha256", userID . revenue . SecretKey)
    const expectedHash = crypto
      .createHash('sha256')
      .update(String(userid) + String(revenue) + TIMEWALL_SECRET_KEY)
      .digest('hex');

    if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
      console.error(`[TIMEWALL HASH MISMATCH] Expected: ${expectedHash}, Received: ${hash}`);
      return res.status(400).send('Invalid signature hash');
    }

    // D. Check for Chargeback / Reversal
    const existingTx = await db.get("SELECT * FROM offerwall_transactions WHERE transaction_id = ?", [txid]);

    if (type.toLowerCase() === 'chargeback' || type.toLowerCase() === 'reversal') {
      if (existingTx && existingTx.status !== 'reversed') {
        await db.run("UPDATE users SET coins = MAX(0, coins - ?) WHERE id = ?", [existingTx.coins_credited, userid]);
        await db.run("UPDATE offerwall_transactions SET status = 'reversed' WHERE transaction_id = ?", [txid]);
        console.log(`[TIMEWALL REVERSED] User: ${userid}, Deducted: ${existingTx.coins_credited}`);
      }
      return res.status(200).send('OK');
    }

    // E. Prevent Duplicate Crediting (Idempotency)
    if (existingTx) {
      console.log(`[TIMEWALL DUPLICATE] Transaction ${txid} already credited.`);
      return res.status(200).send('OK');
    }

    // F. Calculate Coins ($1.00 USD = 1000 Arena Coins)
    const rawRevenueNum = parseFloat(revenue);
    const coinsEarned = Math.max(1, Math.round(rawRevenueNum * 1000));

    // G. Atomic Database Update (Record audit log & credit user wallet)
    await db.run("BEGIN TRANSACTION");
    try {
      await db.run(
        `INSERT INTO offerwall_transactions 
          (user_id, provider, offer_id, offer_name, transaction_id, revenue_usd, coins_credited, status, raw_payload)
         VALUES (?, 'timewall', ?, ?, ?, ?, ?, 'completed', ?)`,
        [userid, offerdetail, offername, txid, rawRevenueNum, coinsEarned, JSON.stringify(params)]
      );

      await db.run(
        "UPDATE users SET coins = coins + ? WHERE id = ?",
        [coinsEarned, userid]
      );

      await db.run("COMMIT");
      console.log(`[TIMEWALL SUCCESS] +${coinsEarned} Coins credited to User: ${userid} (TxID: ${txid})`);
    } catch (err) {
      await db.run("ROLLBACK");
      throw err;
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('[TIMEWALL ERROR]', error);
    return res.status(500).send('Internal Server Error');
  }
});

module.exports = router;
