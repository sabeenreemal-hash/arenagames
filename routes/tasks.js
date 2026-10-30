const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 1. Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../uploads/task_proofs');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 2. Configure Multer for Proof Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `proof_${req.user.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 5 * 1024 * 1024 } // Max 5MB
});

// Helper: Safely delete screenshot from VPS
function deleteScreenshot(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`[VPS Clean] Failed to delete: ${filePath}`, err);
      else console.log(`[VPS Clean] Screenshot deleted to save disk space: ${filePath}`);
    });
  }
}

// -------------------------------------------------------------
// USER ENDPOINTS
// -------------------------------------------------------------

// GET: Fetch Available Tasks (excludes pending & approved; includes active tasks)
router.get('/tasks', async (req, res) => {
  const userId = req.user.id;
  try {
    // Return tasks that are active and do NOT have an active 'pending' or 'approved' submission
    const tasks = await db.all(`
      SELECT t.* 
      FROM tasks t
      LEFT JOIN task_submissions ts 
        ON t.id = ts.task_id AND ts.user_id = ? AND ts.status IN ('pending', 'approved')
      WHERE t.is_active = 1 AND ts.id IS NULL
      ORDER BY t.id DESC
    `, [userId]);

    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET: Fetch User's Submissions (categorized by pending, approved, rejected)
router.get('/tasks/my-submissions', async (req, res) => {
  const userId = req.user.id;
  try {
    const submissions = await db.all(`
      SELECT ts.*, t.title, t.reward_coins, t.instructions, t.proof_type, t.action_url
      FROM task_submissions ts
      JOIN tasks t ON ts.task_id = t.id
      WHERE ts.user_id = ?
      ORDER BY ts.submitted_at DESC
    `, [userId]);

    res.json({ success: true, submissions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST: Submit Task Proof
router.post('/tasks/:id/submit', upload.single('screenshot'), async (req, res) => {
  const taskId = req.params.id;
  const userId = req.user.id;
  const { proof_text } = req.body;
  const screenshotPath = req.file ? req.file.path : null;

  try {
    // Check if task exists and already pending
    const existing = await db.get(
      `SELECT * FROM task_submissions WHERE task_id = ? AND user_id = ? AND status = 'pending'`,
      [taskId, userId]
    );

    if (existing) {
      if (screenshotPath) deleteScreenshot(screenshotPath);
      return res.status(400).json({ success: false, message: 'You already have a pending submission for this task.' });
    }

    await db.run(`
      INSERT INTO task_submissions (task_id, user_id, proof_text, screenshot_path, status)
      VALUES (?, ?, ?, ?, 'pending')
    `, [taskId, userId, proof_text || '', screenshotPath]);

    res.json({ success: true, message: 'Task submitted for verification!' });
  } catch (err) {
    if (screenshotPath) deleteScreenshot(screenshotPath);
    res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------------
// ADMIN PANEL ENDPOINTS
// -------------------------------------------------------------

// POST: Create Task
router.post('/admin/tasks', async (req, res) => {
  const { title, reward_coins, instructions, proof_type, action_url } = req.body;
  try {
    await db.run(`
      INSERT INTO tasks (title, reward_coins, instructions, proof_type, action_url)
      VALUES (?, ?, ?, ?, ?)
    `, [title, reward_coins, instructions, proof_type || 'both', action_url || '']);

    res.json({ success: true, message: 'Task created successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET: All Submissions for Admin
router.get('/admin/submissions', async (req, res) => {
  const { status } = req.query; // 'pending', 'approved', 'rejected'
  try {
    let sql = `
      SELECT ts.*, t.title, t.reward_coins, u.email as user_email
      FROM task_submissions ts
      JOIN tasks t ON ts.task_id = t.id
      JOIN users u ON ts.user_id = u.id
    `;
    const params = [];
    if (status) {
      sql += ` WHERE ts.status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY ts.submitted_at DESC`;

    const submissions = await db.all(sql, params);
    res.json({ success: true, submissions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST: Approve Submission (Credits coins + deletes screenshot file)
router.post('/admin/submissions/:id/approve', async (req, res) => {
  const subId = req.params.id;
  try {
    const submission = await db.get(`
      SELECT ts.*, t.reward_coins 
      FROM task_submissions ts 
      JOIN tasks t ON ts.task_id = t.id 
      WHERE ts.id = ?
    `, [subId]);

    if (!submission || submission.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Invalid submission or not pending' });
    }

    // 1. Credit User Unified Wallet
    await db.run(
      `UPDATE users SET coins = coins + ? WHERE id = ?`,
      [submission.reward_coins, submission.user_id]
    );

    // 2. Mark submission as approved
    await db.run(
      `UPDATE task_submissions SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [subId]
    );

    // 3. DELETE SCREENSHOT FROM VPS TO FREE DISK SPACE
    deleteScreenshot(submission.screenshot_path);

    res.json({ success: true, message: 'Submission approved and coins credited.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST: Reject Submission (Stores reason, deletes screenshot file, allows re-apply)
router.post('/admin/submissions/:id/reject', async (req, res) => {
  const subId = req.params.id;
  const { reason } = req.body;

  try {
    const submission = await db.get(`SELECT * FROM task_submissions WHERE id = ?`, [subId]);
    if (!submission || submission.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Invalid submission or not pending' });
    }

    // 1. Mark as rejected with reason
    await db.run(
      `UPDATE task_submissions SET status = 'rejected', rejection_reason = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [reason || 'Task requirements not fulfilled properly.', subId]
    );

    // 2. DELETE SCREENSHOT FROM VPS TO FREE DISK SPACE
    deleteScreenshot(submission.screenshot_path);

    res.json({ success: true, message: 'Submission rejected and screenshot removed from storage.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
