const mongoose = require('mongoose');

// tenant_id is the CLIENT's own existing identifier, reused as-is — stored as an opaque
// String (no format assumed) even though Speedecom's own Tenant.tenantId happens to be a
// Number, because a future client may use UUIDs or slugs. Uniqueness is scoped by client
// first, so this needs no schema change to onboard one.
const tenantSchema = new mongoose.Schema({
    client: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client',
        required: true
    },
    tenant_id: {
        type: String,
        required: true
    },
    label: {
        type: String,
        default: null
    },
    // Set only by an explicit status field in sync_tenants — never inferred from a
    // tenant being left out of a later sync call.
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    },
    // Soft-delete marker, mirrors Speedecom's own Upload.deletedAt convention.
    deletedAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

tenantSchema.index({ client: 1, tenant_id: 1 }, { unique: true });
tenantSchema.index({ client: 1, deletedAt: 1 });

module.exports = mongoose.model('Tenant', tenantSchema);
