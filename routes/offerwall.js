const express = require('express');
const router = express.Router();
const timewallController = require('./controllers/timewallController');

// Support both GET and POST postbacks from TimeWall
router.get('/postback/timewall', timewallController.handlePostback);
router.post('/postback/timewall', timewallController.handlePostback);

module.exports = router;