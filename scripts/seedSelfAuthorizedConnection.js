const mongoose = require('mongoose');

const connectDB = require('../config/db');
const Client = require('../models/Client');
const Connection = require('../models/Connection');
const { encryptField } = require('../utils/crypto');
const amazonAdapter = require('../adapters/amazon');

// Amazon's redirect-based `connect` flow (getAuthorizationUrl -> real consent screen ->
// exchangeCode) has no equivalent when a seller self-authorizes their own account in
// Seller Central -> Develop Apps -> Authorize: Amazon hands back a refresh token directly,
// with no redirect_uri ever called and no `code` to exchange. This script is that missing
// entry point — it seeds a Connection the same way handleOAuthCallback would have, then
// calls getMarketplaceParticipations for real so marketplace_ids is populated exactly like
// a normal connection, instead of leaving that step half-done.

const getArg = (flag) => {
    const index = process.argv.indexOf(flag);
    return index !== -1 ? process.argv[index + 1] : null;
};

async function main() {
    const clientId = getArg('--client-id');
    const tenantId = getArg('--tenant-id');
    const marketplaceConnectionId = getArg('--marketplace-connection-id');
    const refreshToken = getArg('--refresh-token');
    const label = getArg('--label') || null;

    if (!clientId || !tenantId || !marketplaceConnectionId || !refreshToken) {
        console.error(
            'Usage: node scripts/seedSelfAuthorizedConnection.js --client-id ec_... --tenant-id T-100 ' +
            '--marketplace-connection-id SELLER-1 --refresh-token "Atzr|..." [--label "Primary Store"]'
        );
        process.exit(1);
    }

    await connectDB();

    const client = await Client.findOne({ client_id: clientId });
    if (!client) throw new Error(`No Client found with client_id=${clientId}`);

    console.log('Exchanging refresh token for a real access token (proves the token is valid)...');
    const { accessToken } = await amazonAdapter.getAccessToken({ refreshToken });

    console.log('Fetching real marketplace participations...');
    const marketplaceIds = await amazonAdapter.getMarketplaceParticipations({ accessToken });
    console.log('  marketplace_ids:', marketplaceIds);

    const encrypted = encryptField(refreshToken);

    const connection = await Connection.findOneAndUpdate(
        { client: client._id, tenant_id: tenantId, marketplace: 'amazon', marketplace_connection_id: marketplaceConnectionId },
        {
            client: client._id,
            tenant_id: tenantId,
            marketplace: 'amazon',
            marketplace_connection_id: marketplaceConnectionId,
            label,
            status: 'active',
            encrypted_refresh_token: encrypted,
            marketplace_ids: marketplaceIds,
            last_connected_at: new Date(),
            last_error: null
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log('');
    console.log('Connection seeded successfully.');
    console.log(`  _id:                      ${connection._id}`);
    console.log(`  tenant_id:                ${connection.tenant_id}`);
    console.log(`  marketplace_connection_id: ${connection.marketplace_connection_id}`);
    console.log(`  status:                   ${connection.status}`);
    console.log(`  marketplace_ids:          ${connection.marketplace_ids}`);

    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Seeding failed:', err.response?.data || err.message);
    process.exit(1);
});
