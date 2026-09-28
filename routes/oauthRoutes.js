const express = require('express');
const router = express.Router();

const oauthController = require('../controllers/oauthController');

// Mounted at /oauth in index.js — a single unified GET /oauth/callback, not a
// per-marketplace path. Which marketplace this is comes from the signed `state`
// (utils/oauthState.js), not the URL — both AMAZON_OAUTH_REDIRECT_URI and
// FLIPKART_OAUTH_REDIRECT_URI point at this same endpoint. Public and unauthenticated:
// no authMiddleware, no rate limiter, no Joi validation — the marketplace controls this
// request's shape, not a Connector client.
router.get('/callback', oauthController.handleCallback);

module.exports = router;
