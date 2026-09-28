const Joi = require('joi');

const KNOWN_ACTIONS = ['sync_tenants', 'connect', 'disconnect', 'delete_tenant', 'fetch_orders', 'fetch_data'];
const KNOWN_RESOURCES = ['connection_status'];
const MARKETPLACES = ['amazon', 'flipkart'];

// Joi.string().min(Joi.ref(...)) means minimum STRING LENGTH, not chronological order —
// verified directly (it throws a schema-definition error, doesn't validate anything) —
// so a real cross-field date check needs a custom validator instead. Previously nothing
// caught an inverted range (to < from) at all: `new Date(to) - new Date(from)` going
// negative silently bypassed every ">" range-cap check downstream instead of tripping it.
const requireFromBeforeTo = (schema) => schema.custom((value, helpers) => {
    if (new Date(value.to) < new Date(value.from)) {
        return helpers.error('dateRange.inverted');
    }
    return value;
}, 'from <= to').messages({ 'dateRange.inverted': '"to" must not be before "from"' });

const tenantEntrySchema = Joi.object({
    tenant_id: Joi.string().required(),
    label: Joi.string().allow('').optional(),
    status: Joi.string().valid('active', 'inactive').required()
});

const syncTenantsSchema = Joi.object({
    action: Joi.string().valid('sync_tenants').required(),
    tenants: Joi.array().items(tenantEntrySchema).min(1).required()
});

const connectSchema = Joi.object({
    action: Joi.string().valid('connect').required(),
    tenant_id: Joi.string().required(),
    marketplace: Joi.string().valid(...MARKETPLACES).required(),
    marketplace_connection_id: Joi.string().required(),
    label: Joi.string().allow('').optional()
});

const disconnectSchema = Joi.object({
    action: Joi.string().valid('disconnect').required(),
    tenant_id: Joi.string().required(),
    marketplace: Joi.string().valid(...MARKETPLACES).required(),
    marketplace_connection_id: Joi.string().required()
});

const deleteTenantSchema = Joi.object({
    action: Joi.string().valid('delete_tenant').required(),
    tenant_id: Joi.string().required()
});

const fetchOrdersSchema = requireFromBeforeTo(Joi.object({
    action: Joi.string().valid('fetch_orders').required(),
    tenant_id: Joi.string().required(),
    marketplace_connection_id: Joi.string().required(),
    // Kept as validated strings, not Joi.date() — connectionService/adapters pass these
    // straight through as raw ISO strings (e.g. into URLSearchParams); converting to a
    // JS Date object here would just have to be re-stringified right after.
    from: Joi.string().isoDate().required(),
    to: Joi.string().isoDate().required()
}));

// Covers Amazon Payments (Finances API) and Amazon/Flipkart Returns — deliberately one
// action with a discriminator, not a separate action per data type. Orders keeps its own
// dedicated `fetch_orders` action (already proven live, no reason to touch it) — this is
// for the data types added after that: see README §21.
const fetchDataSchema = requireFromBeforeTo(Joi.object({
    action: Joi.string().valid('fetch_data').required(),
    tenant_id: Joi.string().required(),
    marketplace_connection_id: Joi.string().required(),
    data_type: Joi.string().valid('payments', 'returns').required(),
    from: Joi.string().isoDate().required(),
    to: Joi.string().isoDate().required()
}));

// A single coherent schema, not Joi.alternatives().try(...) — the `otherwise` branch
// gives one clean "action must be one of [...]" error for a genuinely unrecognized
// action, instead of .try()'s error dump of all N branches' mismatched-field messages.
const postActionsSchema = Joi.alternatives().conditional('.action', {
    switch: [
        { is: 'sync_tenants', then: syncTenantsSchema },
        { is: 'connect', then: connectSchema },
        { is: 'disconnect', then: disconnectSchema },
        { is: 'delete_tenant', then: deleteTenantSchema },
        { is: 'fetch_orders', then: fetchOrdersSchema },
        { is: 'fetch_data', then: fetchDataSchema }
    ],
    otherwise: Joi.object({ action: Joi.string().valid(...KNOWN_ACTIONS).required() })
});

const connectionStatusSchema = Joi.object({
    resource: Joi.string().valid('connection_status').required(),
    tenant_id: Joi.string().required(),
    marketplace_connection_id: Joi.string().required()
});

const getQuerySchema = Joi.alternatives().conditional('.resource', {
    switch: [
        { is: 'connection_status', then: connectionStatusSchema }
    ],
    otherwise: Joi.object({ resource: Joi.string().valid(...KNOWN_RESOURCES).required() })
});

module.exports = { postActionsSchema, getQuerySchema };
