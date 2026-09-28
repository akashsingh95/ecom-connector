const mongoose = require('mongoose');

// tenant_id here is the client's own tenant_id string, carried through directly — NOT a
// Mongo ref to the Tenant document. Deliberate: connect()/disconnect() and the tenant-
// deletion cascade all key off (client, tenant_id, marketplace) directly, no join needed.
// marketplace_connection_id is likewise the client's own seller-account id, reused as-is.
const connectionSchema = new mongoose.Schema({
    client: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client',
        required: true
    },
    tenant_id: {
        type: String,
        required: true
    },
    marketplace: {
        type: String,
        enum: ['amazon', 'flipkart'],
        required: true
    },
    marketplace_connection_id: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'active', 'reauth_required', 'disconnected'],
        default: 'pending'
    },
    // AES-256-GCM ciphertext (Layer 3's utils/crypto.js). All null until OAuth completes.
    encrypted_refresh_token: {
        data: { type: String, default: null },
        iv: { type: String, default: null },
        authTag: { type: String, default: null }
    },
    label: {
        type: String,
        default: null
    },
    // Amazon-only: which country storefronts this seller authorization covers, discovered
    // via SP-API's marketplaceParticipations right after OAuth completes (Layer 5's
    // getMarketplaceParticipations) — SP-API's orders endpoint requires this and nothing
    // in the OAuth flow itself provides it. Always empty for Flipkart.
    marketplace_ids: {
        type: [String],
        default: []
    },
    last_connected_at: {
        type: Date,
        default: null
    },
    last_error: {
        type: String,
        default: null
    }
}, { timestamps: true });

connectionSchema.index({ client: 1, tenant_id: 1, marketplace: 1 }, { unique: true });
connectionSchema.index({ client: 1, tenant_id: 1 }); // tenant-deletion cascade lookup

module.exports = mongoose.model('Connection', connectionSchema);
