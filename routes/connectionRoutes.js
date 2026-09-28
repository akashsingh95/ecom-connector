const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/authMiddleware');
const { authAttemptLimiter, clientApiLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../validator/globalValidator');
const { postActionsSchema, getQuerySchema } = require('../validator/schemas/connectionSchemas');
const connectionController = require('../controllers/connectionController');

// Mounted at /v1 in index.js — POST /v1/actions {action: sync_tenants|connect|
// disconnect|delete_tenant|fetch_orders}, GET /v1/query {resource: connection_status}.
// Order matters: rate-limit the auth attempt itself, THEN authenticate, THEN rate-limit
// per-client throughput, THEN validate the payload shape — an unauthenticated or
// over-budget caller never reaches Joi at all.

router.post(
    '/actions',
    authAttemptLimiter,
    authMiddleware,
    clientApiLimiter,
    validate(postActionsSchema, 'body'),
    connectionController.postActions
);

router.get(
    '/query',
    authAttemptLimiter,
    authMiddleware,
    clientApiLimiter,
    validate(getQuerySchema, 'query'),
    connectionController.getQuery
);

module.exports = router;
