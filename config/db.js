const mongoose = require('mongoose');

const env = require('./env');
const { logByActor } = require('../logger/logger');

// Mirrors Speedecom's own db.js (env-driven pool size, fail-fast on connect error) —
// minus its Postgres primary/replica split and result-listener startup, neither of
// which apply here: Connector is 3 small Mongo collections plus Redis, nothing else.
const connectDB = async () => {
    try {
        const conn = await mongoose.connect(env.mongoUri, {
            maxPoolSize: env.mongoMaxPoolSize,
            minPoolSize: env.mongoMinPoolSize,
            maxIdleTimeMS: 30000
        });

        const message = `MongoDB connected: ${conn.connection.host}`;
        console.log(message);
        logByActor('system', 'info', message);
    } catch (error) {
        console.error(`MongoDB connection error: ${error.message}`);
        logByActor('system', 'error', 'MongoDB connection error', { error: error.message });
        process.exit(1);
    }
};

module.exports = connectDB;
