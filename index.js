const express = require('express');
const mongoose = require('mongoose');

const env = require('./config/env');
const connectDB = require('./config/db');
const redisClient = require('./utils/redisClient');
const { errorHandler, AppError } = require('./middleware/errorHandler');
const { logByActor } = require('./logger/logger');
const connectionRoutes = require('./routes/connectionRoutes');
const oauthRoutes = require('./routes/oauthRoutes');
const { sweepAbandonedPendingConnections } = require('./services/connectionService');
const helmet = require('helmet');

const startServer = async () => {
    await connectDB();

    const app = express();
    app.disable('x-powered-by');
    app.use(helmet());
    // Mirrors Speedecom's own trust-proxy setup — without it, req.ip (which
    // middleware/rateLimiter's authAttemptLimiter keys on) would see the load
    // balancer's IP for every caller instead of the real one.
    //
    // No CORS middleware, deliberately: every authenticated call here is server-to-
    // server (a client's own backend), never a browser fetch() — the two browser-facing
    // hops (the authorization redirect, the OAuth callback redirect) are plain
    // navigations, not CORS-relevant XHR. No cluster mode either — that's Speedecom-scale
    // tuning; this starts as a single small process.
    app.set('trust proxy', env.trustProxy);

    app.use(express.json({ limit: '1mb' }));

    app.get('/', (req, res) => res.json({ status: 'ok' }));

    // /ready actually checks the two datastores instead of just answering — mongoose's
    // readyState 1 = connected; redis ping throws if unreachable. For orchestrator
    // liveness/readiness probes.
    app.get('/ready', async (req, res) => {
        const mongoUp = mongoose.connection.readyState === 1;
        let redisUp = true;
        try {
            await redisClient.ping();
        } catch {
            redisUp = false;
        }
        const ready = mongoUp && redisUp;
        res.status(ready ? 200 : 503).json({ ready, mongo: mongoUp, redis: redisUp });
    });

    app.use('/v1', connectionRoutes);
    app.use('/oauth', oauthRoutes);

    // Mirrors Speedecom's 404-before-errorHandler shape, adapted to Connector's own
    // AppError convention (a plain Error here would fall through errorHandler's
    // INTERNAL_ERROR branch, which is the wrong code for an unmatched route).
    app.use((req, res, next) => {
        next(new AppError(404, 'ROUTE_NOT_FOUND', 'Not Found'));
    });

    app.use(errorHandler);

    const server = app.listen(env.port, () => {
        const message = `Ecom Connector listening on port ${env.port}`;
        console.log(message);
        logByActor('system', 'info', message);
    });

    const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
    const sweepTimer = setInterval(() => {
        sweepAbandonedPendingConnections().catch((err) =>
            logByActor('system', 'error', 'Abandoned-PENDING sweep failed', { error: err.message })
        );
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    // Speedecom's own index.js has no graceful shutdown — deliberately going beyond
    // that baseline rather than mirroring its absence: this costs little for a fresh
    // service and avoids leaking the Mongo/Redis connections or dropping in-flight
    // requests when a container orchestrator sends SIGTERM.
    // server.close()'s callback only fires once every in-flight connection ends on its
    // own — with no bound on that wait, a single hung request (Amazon Returns' own ~2min
    // poll, or any outbound call before requestWithRetry's new default timeout existed)
    // could block shutdown indefinitely, which a container orchestrator's own SIGKILL
    // grace period would eventually paper over anyway. Forcing exit after a bounded
    // window makes that explicit instead of leaving it to chance.
    const SHUTDOWN_FORCE_EXIT_MS = 15000;

    const shutdown = (signal) => {
        logByActor('system', 'info', `${signal} received, shutting down gracefully`);

        const forceExit = setTimeout(() => {
            logByActor('system', 'error', 'Graceful shutdown timed out — forcing exit');
            process.exit(1);
        }, SHUTDOWN_FORCE_EXIT_MS);
        forceExit.unref();

        server.close(async () => {
            clearTimeout(forceExit);
            await mongoose.connection.close();
            await redisClient.quit();
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
};

// No .catch() here previously — if connectDB() (or anything else in startServer) rejects,
// e.g. Mongo unreachable at boot, that was an unhandled rejection crashing the process
// with a raw stack trace instead of a clean, logged failure message.
startServer().catch((err) => {
    console.error('Failed to start Ecom Connector:', err.message);
    logByActor('system', 'error', 'Failed to start Ecom Connector', { error: err.message });
    process.exit(1);
});
