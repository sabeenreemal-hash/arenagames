// backend/routes/tasks.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');

let jwt;
try {
  jwt = require('jsonwebtoken');
} catch (e) {
  jwt = null;
}

const uploadDir = path.join(__dirname, '../uploads/task_proofs');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

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
  limits: { fileSize: 10 * 1024 * 1024 }
});

function deleteScreenshot(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`[VPS Clean Error] ${filePath}:`, err.message);
      else console.log(`[VPS Clean Success] Deleted: ${filePath}`);
    });
  }
}

// GET /api/tasks — Available Tasks for user
router.get('/tasks', (req, res) => {
  const userId = extractUserId(req) || 0;

  const sql = `
    SELECT * FROM tasks 
    WHERE (is_active = 1 OR is_active = '1' OR is_active IS NULL)
      AND id NOT IN (
        SELECT task_id FROM task_submissions 
        WHERE user_id = ? AND status IN ('pending', 'approved')
      )
    ORDER BY id DESC
  `;

  db.all(sql, [userId], (err, rows) => {
    if (err) {
      console.error('[GET TASKS DB ERROR]:', err.message);
      return res.status(500).json({ success: false, error: err.message, tasks: [] });
    }

    const taskList = rows || [];
    res.json({ success: true, tasks: taskList });
  });
});

// GET /api/tasks/my-submissions
router.get('/tasks/my-submissions', (req, res) => {
  const userId = extractUserId(req);

  if (!userId) {
    return res.json({ success: true, submissions: [] });
  }

  const sql = `
    SELECT 
      ts.id AS submission_id,
      ts.task_id,
      ts.user_id,
      ts.proof_text,
      ts.screenshot_path,
      ts.status,
      ts.rejection_reason,
      ts.submitted_at,
      t.title,
      t.reward_coins,
      t.instructions,
      t.proof_type,
      t.action_url
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

// POST /api/tasks/:id/submit
router.post('/tasks/:id/submit', upload.single('screenshot'), (req, res) => {
  const rawTaskId = req.params.id;
  const taskId = parseInt(rawTaskId, 10);
  const rawUserId = extractUserId(req);
  const userId = parseInt(rawUserId, 10);
  const { proof_text } = req.body;
  const screenshotPath = req.file ? req.file.path : null;

  if (isNaN(userId)) {
    if (screenshotPath) deleteScreenshot(screenshotPath);
    return res.status(401).json({ success: false, message: 'Unauthorized. Please login again.' });
  }

  // 1. Verify task actually exists in tasks table (Prevents FOREIGN KEY Constraint Error)
  db.get('SELECT id FROM tasks WHERE id = ?', [taskId], (taskErr, taskRow) => {
    if (taskErr || !taskRow) {
      if (screenshotPath) deleteScreenshot(screenshotPath);
      return res.status(404).json({ success: false, message: 'Task does not exist or has been removed.' });
    }

    // 2. Check if a pending submission already exists
    db.get(
      `SELECT id FROM task_submissions WHERE task_id = ? AND user_id = ? AND status = 'pending'`,
      [taskId, userId],
      (err, existingPending) => {
        if (err) {
          if (screenshotPath) deleteScreenshot(screenshotPath);
          return res.status(500).json({ success: false, message: err.message });
        }

        if (existingPending) {
          if (screenshotPath) deleteScreenshot(screenshotPath);
          return res.status(400).json({ success: false, message: 'You already have a pending submission for this task.' });
        }

        // 3. If re-applying, clean up the old rejected record so it cleanly moves to Pending
        db.run(
          `DELETE FROM task_submissions WHERE task_id = ? AND user_id = ? AND status = 'rejected'`,
          [taskId, userId],
          (delErr) => {
            if (delErr) console.error('[REAPPLY CLEANUP ERROR]:', delErr.message);

            // 4. Insert the new pending submission
            db.run(
              `INSERT INTO task_submissions (task_id, user_id, proof_text, screenshot_path, status)
               VALUES (?, ?, ?, ?, 'pending')`,
              [taskId, userId, proof_text || '', screenshotPath],
              function (insErr) {
                if (insErr) {
                  if (screenshotPath) deleteScreenshot(screenshotPath);
                  console.error('[TASK SUBMISSION INSERT ERROR]:', insErr.message);
                  return res.status(500).json({ success: false, message: insErr.message });
                }

                console.log(`[TASK SUBMITTED] User #${userId} submitted proof for Task #${taskId}`);
                res.json({ success: true, message: 'Task submitted for verification!' });
              }
            );
          }
        );
      }
    );
  });
});

module.exports = router;
