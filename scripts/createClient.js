const mongoose = require('mongoose');

const connectDB = require('../config/db');
const Client = require('../models/Client');
const { generateToken, hashSecret } = require('../utils/crypto');

// Mirrors Speedecom's own scripts/ convention: plain process.argv flag parsing (no CLI
// library), async main() + .catch(), mongoose.disconnect() on success. Reuses Connector's
// own config/db.js (rather than a bare mongoose.connect() like Speedecom's scripts do) —
// there's no pooling tuning worth duplicating for a short-lived one-off script, and this
// keeps the connection logic in exactly one place.
//
// The only way a client company is onboarded — no public registration endpoint exists.

const getArg = (flag) => {
    const index = process.argv.indexOf(flag);
    return index !== -1 ? process.argv[index + 1] : null;
};

async function main() {
    const name = getArg('--name');
    const returnUrl = getArg('--return-url');

    if (!name || !returnUrl) {
        console.error('Usage: node scripts/createClient.js --name "Speedecom" --return-url "https://speedecom.example.com/marketplaces/callback"');
        process.exit(1);
    }

    await connectDB();

    // "ec_" prefix is a plain readability aid (Stripe-style), not a format the schema
    // relies on — Client.client_id is validated as nothing more than a unique string.
    const clientId = `ec_${generateToken(16)}`;
    const clientSecret = generateToken(32);

    const client = await Client.create({
        client_id: clientId,
        client_secret_hash: await hashSecret(clientSecret),
        name,
        default_return_url: returnUrl
    });

    console.log('Client created successfully.');
    console.log(`  _id:            ${client._id}`);
    console.log(`  name:           ${client.name}`);
    console.log(`  default_return_url: ${client.default_return_url}`);
    console.log(`  client_id:      ${clientId}`);
    console.log(`  client_secret:  ${clientSecret}`);
    console.log('');
    console.log('Store the client_secret now — it is shown only this once and cannot be recovered.');

    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Client creation failed:', err);
    process.exit(1);
});
