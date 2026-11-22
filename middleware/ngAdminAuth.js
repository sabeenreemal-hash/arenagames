// backend/middleware/ngAdminAuth.js
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { dbGet } = require('../ngDatabase');

function getSecrets() {
  const list = [
    process.env.ADMIN_JWT_SECRET,
    process.env.JWT_SECRET,
    'arena_ng_admin_secret_change_in_env',
  ].filter(Boolean);
  return [...new Set(list)];
}

function signAdminToken(admin) {
  const secret = getSecrets()[0];
  return jwt.sign(
    {
      adminId: admin.id,
      id: admin.id,
      username: admin.username,
      fullName: admin.full_name || admin.username,
      role: 'ADMIN',
    },
    secret,
    { expiresIn: '24h' }
  );
}

async function loginAdmin(username, password) {
  if (!username || !password) return null;
  const admin = await dbGet(`SELECT * FROM admins WHERE username = ?`, [String(username).trim()]);
  if (!admin) return null;

  const valid = bcrypt.compareSync(String(password), admin.password_hash);
  if (!valid) return null;

  const token = signAdminToken(admin);
  return {
    token,
    admin: {
      id: admin.id,
      username: admin.username,
      fullName: admin.full_name || admin.username,
    },
  };
}

async function authenticateNgAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  let decoded = null;
  for (const secret of getSecrets()) {
    try {
      decoded = jwt.verify(token, secret);
      break;
    } catch (_) {}
  }

  if (!decoded || !decoded.username) {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }

  try {
    const admin = await dbGet(`SELECT id, username, full_name FROM admins WHERE username = ?`, [decoded.username]);
    if (!admin) {
      return res.status(403).json({ error: 'Admin account not found' });
    }
    req.admin = admin;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Admin verification failed' });
  }
}

module.exports = {
  loginAdmin,
  authenticateNgAdmin,
};
