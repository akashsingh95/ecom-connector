const Client = require('../models/Client');
const { verifySecret, hashSecret } = require('../utils/crypto');
const { AppError } = require('./errorHandler');

// The identical-error-body protection below (confirmed real, and deliberate) only closes
// half the enumeration gap. `!client || !(await verifySecret(...))` short-circuits on
// `!client` — verified directly: an unknown client_id returns in ~1-5ms (just the failed
// Mongo lookup), while a known client_id with a wrong secret takes ~100-300ms (a real
// Argon2id verification runs). Same response body, measurably different response time —
// an attacker timing responses can still enumerate valid client_ids. Fixed by always
// running a real verify() of equal cost, against a fixed dummy hash when no client was
// found, so both paths cost the same regardless of which branch is actually taken.
let dummyHashPromise = null;
const getDummyHash = () => {
    if (!dummyHashPromise) dummyHashPromise = hashSecret('timing-attack-mitigation-dummy-value');
    return dummyHashPromise;
};

// Checks x-client-id / x-client-secret headers directly against the matching row in the
// Client collection (there can be more than one client company). No token-mint step —
// every request re-authenticates. Attaches the resolved client document to req.client
// for downstream scoping (req.client._id).
const authMiddleware = async (req, res, next) => {
    const clientId = req.headers['x-client-id'];
    const clientSecret = req.headers['x-client-secret'];

    if (!clientId || !clientSecret) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Missing x-client-id or x-client-secret header.'));
    }

    const client = await Client.findOne({ client_id: clientId });
    const hashToVerify = client ? client.client_secret_hash : await getDummyHash();
    const secretIsValid = await verifySecret(hashToVerify, clientSecret);

    // Identical message AND now identical timing whether client_id is unknown or the
    // secret is wrong — a caller must not be able to tell those two cases apart.
    if (!client || !secretIsValid) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Invalid client credentials.'));
    }

    if (client.status === 'revoked') {
        return next(new AppError(403, 'FORBIDDEN', 'This client has been revoked.'));
    }

    req.client = client;
    return next();
};

module.exports = authMiddleware;
