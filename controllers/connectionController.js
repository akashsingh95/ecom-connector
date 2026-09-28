const connectionService = require('../services/connectionService');
const { AppError } = require('../middleware/errorHandler');

// Both handlers assume req.body / req.query are already validated and shaped correctly
// by Layer 8's Joi schemas — this layer stays thin: dispatch on the discriminator field,
// delegate to connectionService, respond. No business logic lives here.

const postActions = async (req, res) => {
    const { action } = req.body;

    switch (action) {
        case 'sync_tenants':
            return res.json({ tenants: await connectionService.syncTenants(req.client, req.body.tenants) });

        case 'connect':
            return res.json(await connectionService.connect(req.client, req.body));

        case 'disconnect':
            return res.json(await connectionService.disconnect(req.client, req.body));

        case 'delete_tenant':
            return res.json(await connectionService.deleteTenant(req.client, req.body));

        case 'fetch_orders':
            return res.json(await connectionService.fetchOrders(req.client, req.body));

        case 'fetch_data':
            return res.json(await connectionService.fetchData(req.client, req.body));

        default:
            throw new AppError(400, 'UNKNOWN_ACTION', `Unknown action "${action}".`);
    }
};

const getQuery = async (req, res) => {
    const { resource } = req.query;

    switch (resource) {
        case 'connection_status':
            return res.json(await connectionService.getConnectionStatus(req.client, req.query));

        default:
            throw new AppError(400, 'UNKNOWN_RESOURCE', `Unknown resource "${resource}".`);
    }
};

module.exports = { postActions, getQuery };
