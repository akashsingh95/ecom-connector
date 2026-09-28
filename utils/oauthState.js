const crypto = require('crypto');

const env = require('../config/env');
const redisClient = require('./redisClient');
const { generateToken } = require('./crypto');

const STATE_TTL_SECONDS = 600; // 10 minutes
const REDIS_KEY_PREFIX = 'oauth_state:';

const sign = (nonce) =>
    crypto.createHmac('sha256', env.oauthStateSecret).update(nonce).digest('base64url');

// Carries {client_id, tenant_id, marketplace, marketplace_connection_id} through the
// OAuth redirect round trip. The nonce alone is already unguessable (24 random bytes),
// so the HMAC is defense in depth against a forged/substituted state value — the Redis
// single-use lookup below is what actually prevents replay.
const signState = async (payload) => {
    const nonce = generateToken(24);
    const signature = sign(nonce);

    await redisClient.set(
        `${REDIS_KEY_PREFIX}${nonce}`,
        JSON.stringify(payload),
        { EX: STATE_TTL_SECONDS }
    );

    return `${nonce}.${signature}`;
};

// Single-use: the Redis key is deleted as part of this call, so a replayed state (e.g.
// the callback URL hit twice) fails the second time even within the TTL window.
const verifyAndConsumeState = async (state) => {
    if (typeof state !== 'string' || !state.includes('.')) return null;

    const [nonce, signature] = state.split('.');
    const expected = sign(nonce);

    const signatureBuf = Buffer.from(signature || '');
    const expectedBuf = Buffer.from(expected);
    if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
        return null;
    }

    // GET then a separate DEL was non-atomic — two callback requests racing on the exact
    // same state value within that window could both pass the GET before either DEL
    // landed, defeating the single-use guarantee this function exists for. GETDEL (redis
    // client v5.10, confirmed available) does both in one atomic round trip.
    const key = `${REDIS_KEY_PREFIX}${nonce}`;
    const raw = await redisClient.getDel(key);
    if (!raw) return null; // expired, already consumed, or never issued

    return JSON.parse(raw);
};

module.exports = { signState, verifyAndConsumeState };
