const mongoose = require('mongoose');

// One row per client company (Speedecom is the first, not the only one). client_id /
// client_secret_hash are generated once by scripts/createClient.js (Layer 10) — there is
// no public registration endpoint. Field names stay snake_case: these are also the exact
// wire-level names used across the API surface (LLD 2), so request body and document
// match 1:1 with no translation layer.
const clientSchema = new mongoose.Schema({
    client_id: {
        type: String,
        required: true,
        unique: true
    },
    client_secret_hash: {
        type: String,
        required: true
    },
    name: {
        type: String,
        required: true
    },
    // Fixed at registration, never sent per-request — see README §8 (open-redirect risk).
    default_return_url: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'revoked'],
        default: 'active'
    }
}, { timestamps: true });

module.exports = mongoose.model('Client', clientSchema);
