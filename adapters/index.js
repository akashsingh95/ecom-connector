const amazon = require('./amazon');
const flipkart = require('./flipkart');

const ADAPTERS = { amazon, flipkart };

// So Layer 6 never branches on marketplace name itself.
const getAdapter = (marketplace) => {
    const adapter = ADAPTERS[marketplace];
    if (!adapter) {
        throw new Error(`No adapter registered for marketplace "${marketplace}"`);
    }
    return adapter;
};

module.exports = { getAdapter };
