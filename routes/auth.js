// backend/routes/auth.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');

const JWT_SECRET = 'ARENA_GAMES_SUPER_SECRET_KEY';

// Middleware to authenticate Bearer token for /me route
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// User Registration with verified referral crediting
router.post('/register', async (req, res) => {
  const { fullName, username, email, password, referralCode } = req.body;

  if (!fullName || !username || !email || !password) {
    return res.status(400).json({ error: 'All primary fields are required' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const generatedCode = generateReferralCode();

    // 1. Check if user or email exists
    db.get('SELECT id FROM users WHERE username = ? OR email = ?', [username.trim(), email.trim()], (err, existing) => {
      if (existing) {
        return res.status(400).json({ error: 'Username or Email is already registered' });
      }

      const cleanRef = (referralCode || '').toString().trim().toUpperCase();

      // 2. Validate referral code if provided
      if (cleanRef !== '') {
        db.get(
          'SELECT id, username, balance FROM users WHERE UPPER(TRIM(referral_code)) = ?',
          [cleanRef],
          (refErr, referrer) => {
            if (refErr || !referrer) {
              return res.status(400).json({ error: 'Invalid referral code. Check spelling or leave empty.' });
            }
            // Create user and reward referrer
            executeUserCreation(fullName.trim(), username.trim(), email.trim(), passwordHash, generatedCode, referrer.id, res);
          }
        );
      } else {
        // Create user without referral
        executeUserCreation(fullName.trim(), username.trim(), email.trim(), passwordHash, generatedCode, null, res);
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server encryption error' });
  }
});

function executeUserCreation(fullName, username, email, passwordHash, code, referrerId, res) {
  const signupBonus = 100; // 100 coins signup bonus for new user

  // Step A: Insert new user with initial 100 coins
  db.run(
    `INSERT INTO users (full_name, username, email, password_hash, referral_code, referred_by_id, balance) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fullName, username, email, passwordHash, code, referrerId, signupBonus],
    function (insertErr) {
      if (insertErr) {
        return res.status(500).json({ error: 'Failed to create user record' });
      }

      const newUserId = this.lastID;

      // Step B: Record signup bonus in transaction ledger
      db.run(
        `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'SIGNUP_BONUS', ?, 'SYSTEM')`,
        [newUserId, signupBonus],
        (txErr) => {
          if (txErr) console.error('Failed to log signup transaction:', txErr);

          // Step C: If user used a referral code, credit 100 coins to referrer
          if (referrerId) {
            const referralBonus = 100;
            db.run(
              `UPDATE users SET balance = balance + ? WHERE id = ?`,
              [referralBonus, referrerId],
              (updateErr) => {
                if (updateErr) console.error('Failed to update referrer balance:', updateErr);

                // Step D: Record referral bonus for referrer
                db.run(
                  `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'REFERRAL_BONUS', ?, ?)`,
                  [referrerId, referralBonus, newUserId.toString()],
                  (refTxErr) => {
                    if (refTxErr) console.error('Failed to log referral transaction:', refTxErr);
                    return res.status(201).json({
                      success: true,
                      message: 'Account registered! Signup & referral bonuses credited.',
                    });
                  }
                );
              }
            );
          } else {
            return res.status(201).json({
              success: true,
              message: 'Account registered successfully with 100 coins bonus!',
            });
          }
        }
      );
    }
  );
}

// User Login (Includes Creator Badge status & Icon lookup)
router.post('/login', (req, res) => {
  const { usernameOrEmail, password } = req.body;

  if (!usernameOrEmail || !password) {
    return res.status(400).json({ error: 'Username/email and password are required' });
  }

  const query = `
    SELECT 
      u.*,
      b.icon_url AS creator_badge_icon,
      b.is_enabled AS badge_is_enabled
    FROM users u
    LEFT JOIN badges b ON u.creator_badge_id = b.id
    WHERE u.username = ? OR u.email = ?
  `;

  db.get(
    query,
    [usernameOrEmail.trim(), usernameOrEmail.trim()],
    async (err, user) => {
      if (err || !user) return res.status(401).json({ error: 'Invalid account credentials' });
      if (user.is_banned === 1) return res.status(403).json({ error: 'Your account is banned' });

      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) return res.status(401).json({ error: 'Invalid account credentials' });

      // Badge is active only if enabled on user AND the badge record is enabled
      const isCreatorBadgeActive = (user.creator_badge_enabled === 1) &&
        (user.badge_is_enabled === 1 || user.badge_is_enabled == null);

      const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

      res.json({
        token,
        user: {
          id: user.id,
          fullName: user.full_name,
          username: user.username,
          email: user.email,
          referralCode: user.referral_code,
          balance: user.balance,
          currentStreak: user.current_streak || 0,
          currentStone: user.current_stone || 'NONE',
          creator_badge_enabled: isCreatorBadgeActive,
          creator_badge_icon: isCreatorBadgeActive
            ? (user.creator_badge_icon || 'https://cdn-icons-png.flaticon.com/512/7653/7653930.png')
            : null,
        },
      });
    }
  );
});

// GET /api/auth/me - Fetch latest profile & badge data
router.get('/me', authenticateToken, (req, res) => {
  const query = `
    SELECT 
      u.*,
      b.icon_url AS creator_badge_icon,
      b.is_enabled AS badge_is_enabled
    FROM users u
    LEFT JOIN badges b ON u.creator_badge_id = b.id
    WHERE u.id = ?
  `;

  db.get(query, [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    if (user.is_banned === 1) return res.status(403).json({ error: 'Your account is banned' });

    const isCreatorBadgeActive = (user.creator_badge_enabled === 1) &&
      (user.badge_is_enabled === 1 || user.badge_is_enabled == null);

    res.json({
      user: {
        id: user.id,
        fullName: user.full_name,
        username: user.username,
        email: user.email,
        referralCode: user.referral_code,
        balance: user.balance,
        currentStreak: user.current_streak || 0,
        currentStone: user.current_stone || 'NONE',
        creator_badge_enabled: isCreatorBadgeActive,
        creator_badge_icon: isCreatorBadgeActive
          ? (user.creator_badge_icon || 'https://cdn-icons-png.flaticon.com/512/7653/7653930.png')
          : null,
      },
    });
  });
});

module.exports = router;