const { createClient } = require('redis');

const env = require('../config/env');
const { logByActor } = require('../logger/logger');

// Deliberately the same package and connection shape as Speedecom's own
// utils/redisClient.js — Layer 4's rate limiter ports Speedecom's Lua-script token
// bucket verbatim, and that only works if it's calling the same client's .eval() API.
// Just the bare connected client here; access-token cache key format and TTL policy
// are business logic and live in Layer 6 (connectionService), not this layer.
const redisClient = createClient({ url: env.redisUrl });

redisClient.on('error', (err) => {
    console.error('Redis client error', err);
    logByActor('system', 'error', 'Redis client error', { error: err.message });
});

redisClient.on('connect', () => {
    console.log('Redis client connected');
    logByActor('system', 'info', 'Redis client connected');
});

// No .catch() here previously — if Redis is unreachable at boot, redisClient.connect()
// rejects and this becomes an unhandled promise rejection, which crashes the process in
// current Node with a raw, unstructured stack trace instead of a clean failure message.
(async () => {
    try {
        await redisClient.connect();
    } catch (err) {
        console.error('Failed to connect to Redis at boot:', err.message);
        logByActor('system', 'error', 'Failed to connect to Redis at boot', { error: err.message });
        process.exit(1);
    }
})();

module.exports = redisClient;
