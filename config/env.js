const dotenv = require('dotenv');
dotenv.config();

const { logByActor } = require('../logger/logger');

// Client credentials (Speedecom, and every other client company) are NOT env vars —
// they live in the Client collection, since there's more than one. See models/Client.js.
const REQUIRED_VARS = [
    'MONGO_URI',
    'REDIS_URL',
    'MASTER_ENCRYPTION_KEY',
    'OAUTH_STATE_SECRET',
    'AMAZON_CLIENT_ID',
    'AMAZON_CLIENT_SECRET',
    'AMAZON_OAUTH_REDIRECT_URI',
    'AMAZON_APPLICATION_ID',
    'AMAZON_AUTHORIZATION_BASE_URL',
    'AMAZON_TOKEN_URL',
    'AMAZON_SP_API_BASE_URL',
    // SP-API requires AWS SigV4 signing on top of the LWA OAuth token above — a
    // separate credential layer (see adapters/amazon/awsAuth.js). Flipkart has no
    // equivalent; it's a standard OAuth bearer-token API.
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ROLE_ARN',
    'AWS_REGION',
    'FLIPKART_CLIENT_ID',
    'FLIPKART_CLIENT_SECRET',
    'FLIPKART_OAUTH_REDIRECT_URI',
    'FLIPKART_AUTHORIZATION_BASE_URL',
    'FLIPKART_TOKEN_URL',
    'FLIPKART_API_BASE_URL'
];

const fail = (message) => {
    console.error(message);
    logByActor('system', 'error', message);
    process.exit(1);
};

const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
    fail(`Missing required environment variable(s): ${missing.join(', ')}`);
}

// AES-256-GCM needs exactly 32 bytes — a bad key here would fail silently later,
// mid-encryption, instead of at boot, so it's checked explicitly.
if (!/^[0-9a-fA-F]{64}$/.test(process.env.MASTER_ENCRYPTION_KEY)) {
    fail('MASTER_ENCRYPTION_KEY must be a 64-character hex string (32 bytes, for AES-256-GCM)');
}

const toInt = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : fallback;
};

module.exports = Object.freeze({
    port: toInt(process.env.PORT, 4001),
    nodeEnv: process.env.NODE_ENV || 'development',
    // How many reverse-proxy hops sit in front of this process (load balancer, etc.) —
    // Express uses this to resolve the real caller IP for req.ip, which
    // middleware/rateLimiter's authAttemptLimiter keys on. 0 = trust nothing (direct
    // exposure, e.g. local dev); set to the actual hop count in production.
    trustProxy: toInt(process.env.TRUST_PROXY, 0),

    mongoUri: process.env.MONGO_URI,
    mongoMaxPoolSize: toInt(process.env.MONGO_MAX_POOL_SIZE, 5),
    mongoMinPoolSize: toInt(process.env.MONGO_MIN_POOL_SIZE, 1),

    redisUrl: process.env.REDIS_URL,

    masterEncryptionKey: process.env.MASTER_ENCRYPTION_KEY,
    oauthStateSecret: process.env.OAUTH_STATE_SECRET,

    amazon: Object.freeze({
        clientId: process.env.AMAZON_CLIENT_ID,
        clientSecret: process.env.AMAZON_CLIENT_SECRET,
        oauthRedirectUri: process.env.AMAZON_OAUTH_REDIRECT_URI,
        // The SP-API "application_id" (Seller Central authorization workflow) is a
        // distinct identifier from the LWA clientId used for token exchange.
        applicationId: process.env.AMAZON_APPLICATION_ID,
        authorizationBaseUrl: process.env.AMAZON_AUTHORIZATION_BASE_URL,
        // Amazon 404s the real consent URL outright for an app still in Draft (pre-review)
        // unless `version=beta` is appended — remove once the app is approved/published.
        draftMode: process.env.AMAZON_DRAFT_MODE === 'true',
        tokenUrl: process.env.AMAZON_TOKEN_URL,
        // Region-specific (NA/EU/FE) — never hardcode this, unlike Flipkart's single host.
        spApiBaseUrl: process.env.AMAZON_SP_API_BASE_URL
    }),
    flipkart: Object.freeze({
        clientId: process.env.FLIPKART_CLIENT_ID,
        clientSecret: process.env.FLIPKART_CLIENT_SECRET,
        oauthRedirectUri: process.env.FLIPKART_OAUTH_REDIRECT_URI,
        authorizationBaseUrl: process.env.FLIPKART_AUTHORIZATION_BASE_URL,
        tokenUrl: process.env.FLIPKART_TOKEN_URL,
        apiBaseUrl: process.env.FLIPKART_API_BASE_URL
    }),
    // Powers SigV4 signing for SP-API only (adapters/amazon/awsAuth.js) — a long-lived
    // IAM user's credentials, used to assume the SP-API app's registered role.
    aws: Object.freeze({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        roleArn: process.env.AWS_ROLE_ARN,
        region: process.env.AWS_REGION,
        // Optional: AWS supports regional STS endpoints (lower latency, data residency).
        // Defaults to the global endpoint — not hardcoded as a bare constant in awsAuth.js.
        stsEndpoint: process.env.AWS_STS_ENDPOINT || 'https://sts.amazonaws.com'
    })
});
