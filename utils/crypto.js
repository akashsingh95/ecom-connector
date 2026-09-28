const crypto = require('crypto');
const argon2 = require('argon2');

const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM's recommended nonce length — not CBC's 16-byte block size
const key = Buffer.from(env.masterEncryptionKey, 'hex');

// Encrypts a single string field (a refresh token) for storage. Returns three separate
// base64 strings, matching models/Connection.js's encrypted_refresh_token sub-document,
// rather than one combined blob.
const encryptField = (plaintext) => {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return {
        data: data.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64')
    };
};

// Throws if the ciphertext was tampered with or the key is wrong — GCM's auth tag check
// fails closed. The caller decides what that means (e.g. REAUTH_REQUIRED), not this function.
const decryptField = ({ data, iv, authTag }) => {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(data, 'base64')),
        decipher.final()
    ]);

    return plaintext.toString('utf8');
};

// Client secrets are high-entropy, machine-generated tokens, not human-chosen passwords —
// Argon2id is the stronger default and installs cleanly (prebuilt binary), so this
// deliberately doesn't mirror Speedecom's bcryptjs.
const hashSecret = (plaintext) => argon2.hash(plaintext, { type: argon2.argon2id });

const verifySecret = async (hash, plaintext) => {
    try {
        return await argon2.verify(hash, plaintext);
    } catch (err) {
        return false;
    }
};

// Generic secure-random token — used for client_id/client_secret generation
// (scripts/createClient.js) and for oauthState.js's nonce.
const generateToken = (byteLength = 32) => crypto.randomBytes(byteLength).toString('hex');

module.exports = {
    encryptField,
    decryptField,
    hashSecret,
    verifySecret,
    generateToken
};
