const redisClient = require('../utils/redisClient');
const { AppError } = require('./errorHandler');

// Ported verbatim from Speedecom's own middleware/rateLimiter.js — same Lua script,
// same {points, duration} token-bucket shape, same rl:<name>:<id> key format, same
// fail-open-on-Redis-error behavior. Only the response glue differs (AppError ->
// errorHandler.js), since Connector has no sendResponse/apiResponse.js utility to reuse.
//   points   = max tokens in the bucket (burst capacity)
//   duration = time in seconds to fully refill all tokens
const RATE_LIMIT_CONFIGS = {
    // Guards the auth lookup itself — keyed by IP + the claimed client_id, so credential
    // guessing is throttled before the DB is even queried.
    authAttempt: {
        points: parseInt(process.env.RL_AUTH_ATTEMPT_POINTS, 10) || 20,
        duration: parseInt(process.env.RL_AUTH_ATTEMPT_DURATION, 10) || 60
    },
    // Generic per-client throughput cap, applied after auth succeeds.
    clientApi: {
        points: parseInt(process.env.RL_CLIENT_API_POINTS, 10) || 60,
        duration: parseInt(process.env.RL_CLIENT_API_DURATION, 10) || 60
    }
};

// KEYS[1] = Redis hash key (e.g., "rl:clientApi:65f...")
// ARGV[1] = max_tokens  (bucket capacity)
// ARGV[2] = refill_time (seconds for full refill)
const TOKEN_BUCKET_SCRIPT = `
    local key = KEYS[1]
    local max_tokens = tonumber(ARGV[1])
    local refill_time = tonumber(ARGV[2])

    -- Use Redis server time to avoid clock skew between Node.js instances
    local redis_time = redis.call("TIME")
    local now = tonumber(redis_time[1]) + (tonumber(redis_time[2]) / 1000000)

    local refill_rate = max_tokens / refill_time

    local data = redis.call("HMGET", key, "tokens", "last_refill")
    local tokens = tonumber(data[1])
    local last_refill = tonumber(data[2])

    if tokens == nil then
        tokens = max_tokens
        last_refill = now
    end

    local elapsed = now - last_refill
    local new_tokens = elapsed * refill_rate
    tokens = math.min(max_tokens, tokens + new_tokens)
    last_refill = now

    if tokens >= 1 then
        tokens = tokens - 1
        redis.call("HMSET", key, "tokens", tokens, "last_refill", last_refill)
        redis.call("EXPIRE", key, refill_time)
        return {1, 0}
    else
        redis.call("HMSET", key, "tokens", tokens, "last_refill", last_refill)
        redis.call("EXPIRE", key, refill_time)
        local wait = (1 - tokens) / refill_rate
        return {0, math.ceil(wait)}
    end
`;

const createLimiterMiddleware = (configName, keyGenerator, message) => {
    const config = RATE_LIMIT_CONFIGS[configName];

    if (!config) {
        throw new Error(`[rateLimiter] Unknown config "${configName}". Check RATE_LIMIT_CONFIGS.`);
    }

    return async (req, res, next) => {
        try {
            const rawKey = keyGenerator(req);
            const redisKey = `rl:${configName}:${rawKey}`;

            const result = await redisClient.eval(TOKEN_BUCKET_SCRIPT, {
                keys: [redisKey],
                arguments: [String(config.points), String(config.duration)]
            });

            const isAllowed = result[0] === 1;
            const retrySecs = result[1];

            if (isAllowed) {
                return next();
            }

            return next(new AppError(
                429,
                'RATE_LIMITED',
                message || 'Too many requests. Please try again later.',
                { retry_after: retrySecs }
            ));
        } catch (err) {
            // Redis connection error — fail open so the app keeps working
            console.error('[rateLimiter] Redis error, allowing request through:', err.message);
            return next();
        }
    };
};

/** Throttles the auth lookup itself. Keyed by IP + the claimed client_id header. */
const authAttemptLimiter = createLimiterMiddleware(
    'authAttempt',
    (req) => `${req.ip}:${req.headers['x-client-id'] || 'unknown'}`,
    'Too many authentication attempts. Please try again in a few minutes.'
);

/** Per-client throughput cap. Requires authMiddleware to have already run (needs req.client). */
const clientApiLimiter = createLimiterMiddleware(
    'clientApi',
    (req) => `${req.client._id}`,
    'Too many requests. Please slow down and try again.'
);

module.exports = {
    authAttemptLimiter,
    clientApiLimiter,
    createLimiterMiddleware,
    RATE_LIMIT_CONFIGS
};
