const axios = require('axios');

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_AFTER_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30000; // axios defaults to timeout: 0 (never) — confirmed no
// call site anywhere set one; a hung Amazon/Flipkart/AWS/S3 connection would otherwise
// tie up the request indefinitely instead of failing and letting the retry ladder above
// actually do its job. Per-call override still works — this only fills in when absent.
const BACKOFF_MS = [1000, 2000, 4000]; // fixed ladder, indexed by attempt

const TRANSIENT_ERROR_PATTERN = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|timeout/i;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries a transient failure (network blip, 5xx, 429) with a fixed backoff ladder,
// honoring Retry-After on 429 instead of the ladder. Never retries a permanent
// rejection (400/401/403/404, or any other 4xx) — see README §11: retrying those wastes
// a call against Amazon/Flipkart's own shared rate budget for nothing.
const requestWithRetry = async (axiosConfig, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) => {
    let lastError;

    const configWithTimeout = { timeout: DEFAULT_TIMEOUT_MS, ...axiosConfig };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await axios(configWithTimeout);
        } catch (err) {
            lastError = err;
            const status = err.response?.status;
            const isLastAttempt = attempt === maxAttempts;

            const isTransientNetworkError = !err.response && TRANSIENT_ERROR_PATTERN.test(err.message || err.code || '');
            const isRetryableStatus = RETRYABLE_STATUS_CODES.has(status);

            if (isLastAttempt || (!isTransientNetworkError && !isRetryableStatus)) {
                throw err;
            }

            if (status === 429) {
                const retryAfterHeader = err.response.headers['retry-after'];
                const retryAfterMs = (parseInt(retryAfterHeader, 10) * 1000) || DEFAULT_RETRY_AFTER_MS;
                await wait(retryAfterMs);
            } else {
                await wait(BACKOFF_MS[attempt - 1] || BACKOFF_MS[BACKOFF_MS.length - 1]);
            }
        }
    }

    throw lastError;
};

module.exports = requestWithRetry;
