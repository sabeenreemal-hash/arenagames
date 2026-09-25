// backend/middleware/auth.js

const jwt = require('jsonwebtoken');
const JWT_SECRET = 'ARENA_GAMES_SUPER_SECRET_KEY';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token session' });
    req.user = decoded;
    next();
  });
}

// Export the function directly (do not wrap in curly braces)
module.exports = authenticateToken;