// backend/routes/spinWheelRoutes.js

const express = require('express');
const router = express.Router();
const spinWheelController = require('../controllers/spinWheelController');

// If your app uses an auth token middleware, you can optionally import it here:
// const { verifyToken } = require('../middleware/auth');

/**
 * @route   GET /api/spin/status
 * @desc    Fetch daily free spins left, cooldown seconds, and action required (FREE_SPIN, NEED_AD, IN_COOLDOWN)
 * @query   userId, spinType ('basic' | 'premium')
 */
router.get('/status', spinWheelController.getSpinStatus);

/**
 * @route   POST /api/spin/execute
 * @desc    Server-authoritative spin execution (calculates weighted reward, updates wallet, starts cooldown)
 * @body    { userId, spinType, adWatched }
 */
router.post('/execute', spinWheelController.executeSpin);

/**
 * @route   POST /api/spin/claim-2x
 * @desc    Double the coin reward after verified rewarded ad completion
 * @body    { userId, spinId }
 */
router.post('/claim-2x', spinWheelController.claim2xReward);

/**
 * @route   POST /api/spin/try-again-ad
 * @desc    Grant an extra spin attempt after landing on 'Try Again' and watching an ad
 * @body    { userId, spinId }
 */
router.post('/try-again-ad', spinWheelController.claimTryAgainSpin);

module.exports = router;
