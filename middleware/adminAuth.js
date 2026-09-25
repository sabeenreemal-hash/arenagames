const jwt = require('jsonwebtoken');
const JWT_ADMIN_SECRET = 'ARENA_GAMES_ADMIN_SECRET_KEY';

module.exports = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Admin access denied' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Session token missing' });

  jwt.verify(token, JWT_ADMIN_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Session expired. Please log in again.' });
    req.admin = decoded;
    next();
  });
};