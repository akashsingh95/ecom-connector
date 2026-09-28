const { AppError } = require('../middleware/errorHandler');

// Mirrors Speedecom's own validator/globalValidator.js (Joi options, error-message
// shape: validate(schema, source) applied per-route). Response glue is adapted —
// AppError -> errorHandler.js — since Connector has no sendResponse/apiResponse.js
// utility, the same adaptation already made for middleware/rateLimiter.js.
const formatValidationError = (error) => error.details.map((detail) => detail.message);

const validate = (schema, source = 'body') => (req, res, next) => {
    const dataToValidate = source === 'query' ? req.query : source === 'params' ? req.params : req.body;

    const { error, value } = schema.validate(dataToValidate, {
        abortEarly: false,
        stripUnknown: true,
        convert: true
    });

    if (error) {
        return next(new AppError(400, 'VALIDATION_ERROR', 'Validation failed', { errors: formatValidationError(error) }));
    }

    // Express 5 made req.query a getter-only property in this version — a plain
    // reassignment silently no-ops (confirmed directly while building this). req.body
    // and req.params stay normal writable properties, so only req.query needs this.
    if (source === 'query') {
        Object.defineProperty(req, 'query', { value, writable: true, configurable: true, enumerable: true });
    } else if (source === 'params') {
        req.params = value;
    } else {
        req.body = value;
    }

    next();
};

module.exports = { validate, formatValidationError };
