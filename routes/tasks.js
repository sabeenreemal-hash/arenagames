// backend/routes/tasks.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');

// Optional JWT loader with safe fallback
let jwt;
try {
  jwt = require('jsonwebtoken');
} catch (e) {
  jwt = null;
}

// 1. Ensure proof uploads directory exists on VPS
const uploadDir = path.join(__dirname, '../uploads/task_proofs');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 2. Configure Multer for Proof Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const userId = extractUserId(req) || 'guest';
    cb(null, `proof_${userId}_${Date.now()}${ext}`);
  }
});

const upload = multer({ 
  storage, 
  limits: { fileSize: 10 * 1024 * 1024 } // Max 10MB
});

// Helper: Safely delete screenshot from VPS
function deleteScreenshot(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`[VPS Clean Error] Could not delete: ${filePath}`, err.message);
      else console.log(`[VPS Clean Success] Deleted screenshot: ${filePath}`);
    });
  }
}

// Helper: Extract User ID from Bearer Token or Query
function extractUserId(req) {
  if (req.query.userId || req.query.user_id) {
    return req.query.userId || req.query.user_id;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      if (jwt) {
        const decoded = jwt.decode(token);
        if (decoded && (decoded.id || decoded.userId || decoded.sub)) {
          return decoded.id || decoded.userId || decoded.sub;
        }
      } else {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
          return payload.id || payload.userId || payload.sub;
        }
      }
    } catch (_) {}
  }
  return null;
}

// =============================================================
// USER APIS (Called by Flutter App)
// =============================================================

// GET /api/tasks — Available Tasks for the user
router.get('/tasks', (req, res) => {
  const userId = extractUserId(req) || 0;

  // Fetch active tasks that are NOT already 'pending' or 'approved' by this user
  const sql = `
    SELECT t.* 
    FROM tasks t
    LEFT JOIN task_submissions ts 
      ON t.id = ts.task_id AND ts.user_id = ? AND ts.status IN ('pending', 'approved')
    WHERE (t.is_active = 1 OR t.is_active IS NULL) AND ts.id IS NULL
    ORDER BY t.id DESC
  `;

  db.all(sql, [userId], (err, rows) => {
    if (err) {
      console.error('[GET TASKS DB ERROR]:', err.message);
      return res.status(500).json({ success: false, error: err.message, tasks: [] });
    }

    const taskList = rows || [];
    console.log(`[TASKS API] User #${userId} retrieved ${taskList.length} available tasks`);
    res.json({ success: true, tasks: taskList });
  });
});

// GET /api/tasks/my-submissions — User's task history (Pending, Rejected, Approved)
router.get('/tasks/my-submissions', (req, res) => {
  const userId = extractUserId(req);

  if (!userId) {
    return res.json({ success: true, submissions: [] });
  }

  const sql = `
    SELECT ts.*, t.title, t.reward_coins, t.instructions, t.proof_type, t.action_url
    FROM task_submissions ts
    JOIN tasks t ON ts.task_id = t.id
    WHERE ts.user_id = ?
    ORDER BY ts.submitted_at DESC
  `;

  db.all(sql, [userId], (err, rows) => {
    if (err) {
      console.error('[GET SUBMISSIONS DB ERROR]:', err.message);
      return res.status(500).json({ success: false, error: err.message, submissions: [] });
    }

    res.json({ success: true, submissions: rows || [] });
  });
});

// POST /api/tasks/:id/submit — Submit Task Proof
router.post('/tasks/:id/submit', upload.single('screenshot'), (req, res) => {
  const taskId = req.params.id;
  const userId = extractUserId(req);
  const { proof_text } = req.body;
  const screenshotPath = req.file ? req.file.path : null;

  if (!userId) {
    if (screenshotPath) deleteScreenshot(screenshotPath);
    return res.status(401).json({ success: false, message: 'Unauthorized. Please login again.' });
  }

  // Check if a pending submission already exists
  db.get(
    `SELECT id FROM task_submissions WHERE task_id = ? AND user_id = ? AND status = 'pending'`,
    [taskId, userId],
    (err, existing) => {
      if (err) {
        if (screenshotPath) deleteScreenshot(screenshotPath);
        return res.status(500).json({ success: false, message: err.message });
      }

      if (existing) {
        if (screenshotPath) deleteScreenshot(screenshotPath);
        return res.status(400).json({ success: false, message: 'You already have a pending submission for this task.' });
      }

      // Insert new submission
      db.run(
        `INSERT INTO task_submissions (task_id, user_id, proof_text, screenshot_path, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [taskId, userId, proof_text || '', screenshotPath],
        function (insErr) {
          if (insErr) {
            if (screenshotPath) deleteScreenshot(screenshotPath);
            return res.status(500).json({ success: false, message: insErr.message });
          }

          console.log(`[TASK SUBMITTED] User #${userId} submitted proof for Task #${taskId}`);
          res.json({ success: true, message: 'Task submitted for verification!' });
        }
      );
    }
  );
});

module.exports = router;
