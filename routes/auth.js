// backend/routes/auth.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');

const JWT_SECRET = 'ARENA_GAMES_SUPER_SECRET_KEY';

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

// User Registration
router.post('/register', async (req, res) => {
  const { fullName, username, email, password, referralCode } = req.body;

  if (!fullName || !username || !email || !password) {
    return res.status(400).json({ error: 'All primary fields are required' });
  }

  // Extract the user's real client IP address
  const clientIp =
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
    req.headers['x-real-ip'] ||
    req.ip ||
    req.socket.remoteAddress ||
    'unknown';

  handleUserRegistration(fullName, username, email, password, referralCode, clientIp, res);
});

async function handleUserRegistration(fullName, username, email, password, referralCode, clientIp, res) {
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const generatedCode = generateReferralCode();

    db.get('SELECT id FROM users WHERE username = ? OR email = ?', [username.trim(), email.trim()], (err, existing) => {
      if (existing) {
        return res.status(400).json({ error: 'Username or Email is already registered' });
      }

      const cleanRef = (referralCode || '').toString().trim().toUpperCase();

      if (cleanRef !== '') {
        db.get(
          'SELECT id, username, balance FROM users WHERE UPPER(TRIM(referral_code)) = ?',
          [cleanRef],
          (refErr, referrer) => {
            if (refErr || !referrer) {
              return res.status(400).json({ error: 'Invalid referral code. Check spelling or leave empty.' });
            }
            executeUserCreation(
              fullName.trim(),
              username.trim(),
              email.trim(),
              passwordHash,
              generatedCode,
              referrer.id,
              clientIp,
              res
            );
          }
        );
      } else {
        executeUserCreation(
          fullName.trim(),
          username.trim(),
          email.trim(),
          passwordHash,
          generatedCode,
          null,
          clientIp,
          res
        );
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server encryption error' });
  }
}

function executeUserCreation(fullName, username, email, passwordHash, code, referrerId, clientIp, res) {
  const signupBonus = 100;

  db.run(
    `INSERT INTO users (full_name, username, email, password_hash, referral_code, referred_by_id, balance, registration_ip) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [fullName, username, email, passwordHash, code, referrerId, signupBonus, clientIp],
    function (insertErr) {
      if (insertErr) {
        console.error('Error inserting user record:', insertErr.message);
        return res.status(500).json({ error: 'Failed to create user record' });
      }

      const newUserId = this.lastID;

      db.run(
        `INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'SIGNUP_BONUS', ?, 'SYSTEM')`,
        [newUserId, signupBonus],
        () => {
          if (referrerId) {
            db.run(`UPDATE users SET balance = balance + 100 WHERE id = ?`, [referrerId], () => {
              db.run(`INSERT INTO transactions (user_id, type, amount, reference_id) VALUES (?, 'REFERRAL_BONUS', 100, ?)`, [referrerId, newUserId.toString()]);
            });
          }
          return res.status(201).json({ success: true, message: 'Account registered successfully!' });
        }
      );
    }
  );
}

// User Login (Unrestricted - any valid account can log in on any device)
router.post('/login', (req, res) => {
  const { usernameOrEmail, password } = req.body;

  if (!usernameOrEmail || !password) {
    return res.status(400).json({ error: 'Username/email and password are required' });
  }

  const query = `
    SELECT 
      u.*,
      b.icon_url AS creator_badge_icon
    FROM users u
    LEFT JOIN badges b ON u.creator_badge_id = b.id
    WHERE u.username = ? OR u.email = ?
  `;

  db.get(query, [usernameOrEmail.trim(), usernameOrEmail.trim()], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid account credentials' });
    if (user.is_banned === 1) return res.status(403).json({ error: 'Your account is banned' });

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Invalid account credentials' });

    // Resilient check (handles 1, '1', true)
    const isCreatorActive = user.creator_badge_enabled == 1 || user.creator_badge_enabled === true;
    const badgeIcon = isCreatorActive
      ? (user.creator_badge_icon || 'https://cdn-icons-png.flaticon.com/512/7653/7653930.png')
      : null;

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
        creator_badge_enabled: isCreatorActive,
        creator_badge_icon: badgeIcon,
      },
    });
  });
});

// GET /api/auth/me - Live Profile & Badge Sync
router.get('/me', authenticateToken, (req, res) => {
  const query = `
    SELECT 
      u.*,
      b.icon_url AS creator_badge_icon
    FROM users u
    LEFT JOIN badges b ON u.creator_badge_id = b.id
    WHERE u.id = ?
  `;

  db.get(query, [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    if (user.is_banned === 1) return res.status(403).json({ error: 'Your account is banned' });

    const isCreatorActive = user.creator_badge_enabled == 1 || user.creator_badge_enabled === true;
    const badgeIcon = isCreatorActive
      ? (user.creator_badge_icon || 'https://cdn-icons-png.flaticon.com/512/7653/7653930.png')
      : null;

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
        creator_badge_enabled: isCreatorActive,
        creator_badge_icon: badgeIcon,
      },
    });
  });
});

module.exports = router;
