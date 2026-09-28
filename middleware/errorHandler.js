const { logByActor } = require('../logger/logger');

// Every other layer throws/next()s this instead of writing res.json() itself, so the
// { error: {...} } envelope shape exists in exactly one place. The taxonomy grows
// organically (README §11) — only UNAUTHORIZED/FORBIDDEN/RATE_LIMITED exist so far,
// because those are the only codes Layer 4 itself needs.
class AppError extends Error {
    constructor(statusCode, code, message, extra) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.extra = extra || {};
    }
}

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    const code = err.code || 'INTERNAL_ERROR';
    // Never leak an unexpected error's raw message to the client — only ever the
    // message on a deliberately-thrown AppError.
    const message = err instanceof AppError ? err.message : 'Internal server error';

    if (!(err instanceof AppError)) {
        console.error(err);
        logByActor('system', 'error', 'Unhandled error', { message: err.message, stack: err.stack });
    }

    if (err.extra && err.extra.retry_after !== undefined) {
        res.set('Retry-After', String(err.extra.retry_after));
    }

    res.status(statusCode).json({
        error: {
            code,
            message,
            ...(err.extra || {})
        }
    });
};

module.exports = { errorHandler, AppError };
