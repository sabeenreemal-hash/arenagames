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

// 1. Ensure directory exists
const uploadDir = path.join(__dirname, '../uploads/task_proofs');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 2. Allow direct access to screenshots through /uploads/task_proofs/<filename>
router.use('/uploads/task_proofs', express.static(uploadDir));

function extractUserId(req) {
  if (req.query.userId || req.query.user_id) {
    return req.query.userId || req.query.user_id;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      let payload = null;
      if (jwt) {
        payload = jwt.decode(token);
      } else {
        const parts = token.split('.');
        if (parts.length === 3) {
          payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        }
      }
      if (payload) {
        return (
          payload.id ||
          payload.userId ||
          payload.user_id ||
          payload.uid ||
          payload._id ||
          payload.sub ||
          null
        );
      }
    } catch (e) {
      console.error('[JWT EXTRACT ERROR]:', e.message);
    }
  }
  return null;
}

// Helper: converts any file path (including old OS disk paths) into a public web URL
function toPublicUrl(savedPath) {
  if (!savedPath) return null;
  const fileName = path.basename(savedPath);
  return `/uploads/task_proofs/${fileName}`;
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
  if (!filePath) return;
  const fileName = path.basename(filePath);
  const diskPath = path.join(uploadDir, fileName);
  if (fs.existsSync(diskPath)) {
    fs.unlink(diskPath, (err) => {
      if (err) console.error(`[Clean Error] ${diskPath}:`, err.message);
    });
  }
}

// ==========================================
// 1. GET Available Tasks
// ==========================================
router.get(['/', '/tasks'], (req, res) => {
  const userId = extractUserId(req) || 0;

  const sql = `
    SELECT t.* FROM tasks t
    WHERE (
      t.is_active = 1 
      OR t.is_active = '1' 
      OR t.is_active = 'true' 
      OR t.is_active = 'active'
      OR t.is_active IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM task_submissions ts 
      WHERE ts.task_id = t.id 
        AND ts.user_id = ? 
        AND ts.status IN ('pending', 'approved')
    )
    ORDER BY t.id DESC
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

// ==========================================
// 2. GET My Submissions (Normalizes URLs)
// ==========================================
router.get(['/my-submissions', '/tasks/my-submissions'], (req, res) => {
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

    const submissions = (rows || []).map((row) => ({
      ...row,
      screenshot_path: toPublicUrl(row.screenshot_path)
    }));

    res.json({ success: true, submissions });
  });
});

// ==========================================
// 3. POST Submit Task Proof (Saves Web URL)
// ==========================================
router.post(['/:id/submit', '/tasks/:id/submit'], upload.single('screenshot'), (req, res) => {
  const rawTaskId = req.params.id;
  const taskId = parseInt(rawTaskId, 10);
  const rawUserId = extractUserId(req);
  const userId = parseInt(rawUserId, 10);
  const { proof_text } = req.body;

  // FIX: Save as public web URL path instead of OS filesystem path
  const screenshotUrl = req.file ? `/uploads/task_proofs/${req.file.filename}` : null;

  if (isNaN(userId)) {
    if (screenshotUrl) deleteScreenshot(screenshotUrl);
    return res.status(401).json({ success: false, message: 'Unauthorized. Please login again.' });
  }

  // 1. Verify task exists
  db.get('SELECT id FROM tasks WHERE id = ?', [taskId], (taskErr, taskRow) => {
    if (taskErr || !taskRow) {
      if (screenshotUrl) deleteScreenshot(screenshotUrl);
      return res.status(404).json({ success: false, message: 'Task does not exist or has been removed.' });
    }

    // 2. Check for existing pending submission
    db.get(
      `SELECT id FROM task_submissions WHERE task_id = ? AND user_id = ? AND status = 'pending'`,
      [taskId, userId],
      (err, existingPending) => {
        if (err) {
          if (screenshotUrl) deleteScreenshot(screenshotUrl);
          return res.status(500).json({ success: false, message: err.message });
        }

        if (existingPending) {
          if (screenshotUrl) deleteScreenshot(screenshotUrl);
          return res.status(400).json({ success: false, message: 'You already have a pending submission for this task.' });
        }

        // 3. Remove old rejected submission if re-applying
        db.run(
          `DELETE FROM task_submissions WHERE task_id = ? AND user_id = ? AND status = 'rejected'`,
          [taskId, userId],
          (delErr) => {
            if (delErr) console.error('[REAPPLY CLEANUP ERROR]:', delErr.message);

            // 4. Insert new pending submission with public web URL
            db.run(
              `INSERT INTO task_submissions (task_id, user_id, proof_text, screenshot_path, status)
               VALUES (?, ?, ?, ?, 'pending')`,
              [taskId, userId, proof_text || '', screenshotUrl],
              function (insErr) {
                if (insErr) {
                  if (screenshotUrl) deleteScreenshot(screenshotUrl);
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
