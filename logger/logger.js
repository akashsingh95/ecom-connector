const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Mirrors Speedecom's own logger/logger.js (Winston + daily rotation, JSON format,
// dispatch-by-actor). Connector has no user roles though — its only two actors are an
// authenticated client and the system itself (startup, background jobs) — so the role
// list shrinks to those two instead of Speedecom's four.
const createLogger = (folderName) => {
    const logDir = path.join(__dirname, '..', 'logs', folderName);

    const logFormat = winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    );

    // maxFiles/maxSize were missing entirely (inherited as-is from Speedecom's own
    // logger.js, which has the same gap) — with neither set, these files grow and
    // accumulate forever until the disk fills (ENOSPC), which takes the whole process
    // down. 14 days / 50MB per file are reasonable defaults, not load-bearing on any
    // existing behavior.
    return winston.createLogger({
        format: logFormat,
        transports: [
            new DailyRotateFile({
                filename: path.join(logDir, '%DATE%-info.log'),
                datePattern: 'YYYY-MM-DD',
                level: 'info',
                zippedArchive: true,
                maxFiles: '14d',
                maxSize: '50m',
            }),
            new DailyRotateFile({
                filename: path.join(logDir, '%DATE%-error.log'),
                datePattern: 'YYYY-MM-DD',
                level: 'error',
                zippedArchive: true,
                maxFiles: '14d',
                maxSize: '50m',
            }),
            new DailyRotateFile({
                filename: path.join(logDir, '%DATE%-http.log'),
                datePattern: 'YYYY-MM-DD',
                level: 'http',
                zippedArchive: true,
                maxFiles: '14d',
                maxSize: '50m',
            }),
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.simple()
                )
            })
        ]
    });
};

const systemLogger = createLogger('system');
const clientLogger = createLogger('client');

const loggers = {
    system: systemLogger,
    client: clientLogger,
    default: systemLogger
};

/**
 * @param {string} actorType - 'system' or 'client'.
 * @param {string} level - 'error' | 'warn' | 'info' | 'http'.
 * @param {string} message
 * @param {object} [meta] - Never put a token, secret, or client_secret in here.
 */
const logByActor = (actorType, level, message, meta) => {
    const normalized = (actorType || '').toString().trim().toLowerCase();
    const targetLogger = loggers[normalized] || loggers.default;

    if (targetLogger && typeof targetLogger[level] === 'function') {
        targetLogger[level](message, meta);
    } else {
        console.warn(`Logger level '${level}' invalid.`);
        targetLogger.info(message, meta);
    }
};

module.exports = { logByActor };
