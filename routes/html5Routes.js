// backend/routes/html5Routes.js

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const html5Controller = require('../controllers/html5Controller');

router.get('/games', authenticateToken, html5Controller.getGamesAndStatus);
router.get('/status', authenticateToken, html5Controller.getStatus);
router.post('/session/start', authenticateToken, html5Controller.startSession);
router.post('/session/heartbeat', authenticateToken, html5Controller.heartbeat);
router.post('/session/claim', authenticateToken, html5Controller.claimCoins);
router.post('/session/end', authenticateToken, html5Controller.endSession);
router.post('/booster/watch-ad', authenticateToken, html5Controller.watchBoosterAd);

module.exports = router;
