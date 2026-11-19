// backend/middleware/auth.js

const jwt = require('jsonwebtoken');
const db = require('../database');
const JWT_SECRET = 'ARENA_GAMES_SUPER_SECRET_KEY';

const lastTouchedMap = new Map();
const TOUCH_THROTTLE_MS = 60 * 1000; // Update DB at most once per minute per user

function touchUserActivity(userId, force = false) {
  if (!userId) return;
  const now = Date.now();
  const prev = lastTouchedMap.get(userId) || 0;
  if (!force && (now - prev) < TOUCH_THROTTLE_MS) return;

  lastTouchedMap.set(userId, now);
  db.run(
    'UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?',
    [userId],
    () => {}
  );
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token session' });
    req.user = decoded;
    touchUserActivity(decoded.id);
    next();
  });
}

authenticateToken.touchUserActivity = touchUserActivity;
module.exports = authenticateToken;
