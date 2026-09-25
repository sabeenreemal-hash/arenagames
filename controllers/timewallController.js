// controllers/timewallController.js
const crypto = require('crypto');
const db = require('../core/db'); // Your existing sqlite database instance (sqlite3 or better-sqlite3)

// 1. Mandatory Whitelisted IPs from TimeWall documentation
const WHITELISTED_IPS = new Set([
    '18.156.132.55',
    '51.81.120.73',
    '142.111.248.18'
]);

const TIMEWALL_SECRET_KEY = process.env.TIMEWALL_SECRET_KEY || 'YOUR_TIMEWALL_SECRET_KEY';

/**
 * Extracts client IP handling reverse proxies (Cloudflare, Nginx, etc.)
 */
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ? req.socket.remoteAddress.replace(/^.*:/, '') : '';
}

/**
 * GET or POST /api/offerwall/timewall/postback
 */
exports.handlePostback = async (req, res) => {
    try {
        const clientIp = getClientIp(req);

        // Step A: IP Whitelist Check (Disable in development if testing via localhost)
        if (process.env.NODE_ENV === 'production' && !WHITELISTED_IPS.has(clientIp)) {
            console.warn(`[TIMEWALL REJECT] Unauthorized IP attempt: ${clientIp}`);
            return res.status(403).send('Forbidden: Invalid Origin IP');
        }

        // Merge query and body params (TimeWall sends postbacks as GET query parameters)
        const params = { ...req.query, ...req.body };
        const {
            userid,
            txid,
            revenue, // Crucial: must remain a raw string
            currency,
            hash,
            type = 'credit', // 'credit' or 'chargeback' / 'reversal'
            offername = 'TimeWall Offer',
            offerdetail = ''
        } = params;

        if (!userid || !txid || !revenue || !hash) {
            return res.status(400).send('Missing mandatory postback parameters');
        }

        // Step B: SHA-256 Hash Validation
        // Formula: hash("sha256", userID . revenue . SecretKey)
        // CRITICAL: revenue must NOT be parsed to float/decimal before calculating hash
        const expectedHash = crypto
            .createHash('sha256')
            .update(String(userid) + String(revenue) + TIMEWALL_SECRET_KEY)
            .digest('hex');

        if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
            console.error(`[TIMEWALL HASH MISMATCH] Expected: ${expectedHash}, Received: ${hash}`);
            return res.status(400).send('Invalid signature hash');
        }

        // Step C: Check if TimeWall is enabled
        const isEnabledRow = await db.get("SELECT value FROM offerwall_settings WHERE key = 'timewall_enabled'");
        if (isEnabledRow && isEnabledRow.value !== '1') {
            return res.status(403).send('TimeWall integration is currently disabled');
        }

        // Step D: Duplicate / Idempotency Check
        const existingTx = await db.get("SELECT * FROM offerwall_transactions WHERE transaction_id = ?", [txid]);

        // Handle Chargeback / Reversal
        if (type.toLowerCase() === 'chargeback' || type.toLowerCase() === 'reversal') {
            if (!existingTx) {
                return res.status(200).send('OK'); // Nothing to reverse
            }
            if (existingTx.status === 'reversed') {
                return res.status(200).send('OK'); // Already reversed
            }

            // Deduct previously credited coins from user wallet
            await db.run(
                "UPDATE users SET coins = MAX(0, coins - ?) WHERE id = ?",
                [existingTx.coins_credited, userid]
            );

            await db.run(
                "UPDATE offerwall_transactions SET status = 'reversed', updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?",
                [txid]
            );

            console.log(`[TIMEWALL REVERSED] User ${userid} deducted ${existingTx.coins_credited} coins for txid ${txid}`);
            return res.status(200).send('OK');
        }

        // If transaction exists and was already completed, return 200 without duplicate credit
        if (existingTx) {
            console.log(`[TIMEWALL DUPLICATE] Transaction ${txid} already processed.`);
            return res.status(200).send('OK');
        }

        // Step E: Calculate Coins
        const rawRevenueNumber = parseFloat(revenue);
        const rateRow = await db.get("SELECT value FROM offerwall_settings WHERE key = 'coins_per_usd'");
        const coinsPerUsd = rateRow ? parseInt(rateRow.value, 10) : 1000;

        // Coins = revenue * exchange rate (e.g., $0.10 * 1000 = 100 Coins)
        const coinsEarned = Math.max(1, Math.round(rawRevenueNumber * coinsPerUsd));

        // Step F: Atomic Database Transaction (Record log & credit wallet)
        await db.run("BEGIN TRANSACTION");
        try {
            // 1. Record Transaction
            await db.run(
                `INSERT INTO offerwall_transactions 
          (user_id, provider, offer_id, offer_name, transaction_id, revenue_usd, coins_credited, status, raw_payload)
         VALUES (?, 'timewall', ?, ?, ?, ?, ?, 'completed', ?)`,
                [userid, offerdetail, offername, txid, rawRevenueNumber, coinsEarned, JSON.stringify(params)]
            );

            // 2. Credit Coins to User's Arena Wallet
            await db.run(
                "UPDATE users SET coins = coins + ? WHERE id = ?",
                [coinsEarned, userid]
            );

            await db.run("COMMIT");
            console.log(`[TIMEWALL SUCCESS] Credited ${coinsEarned} Coins to User: ${userid} (TxID: ${txid})`);
        } catch (err) {
            await db.run("ROLLBACK");
            throw err;
        }

        // Step G: Return 200 OK so TimeWall acknowledges successful delivery
        return res.status(200).send('OK');
    } catch (error) {
        console.error('[TIMEWALL SERVER ERROR]', error);
        return res.status(500).send('Internal Server Error');
    }
};