const Client = require('../models/Client');
const Tenant = require('../models/Tenant');
const Connection = require('../models/Connection');
const { getAdapter } = require('../adapters');
const { encryptField, decryptField } = require('../utils/crypto');
const { signState, verifyAndConsumeState } = require('../utils/oauthState');
const redisClient = require('../utils/redisClient');
const { AppError } = require('../middleware/errorHandler');
const { logByActor } = require('../logger/logger');

const ACCESS_TOKEN_CACHE_SAFETY_MARGIN_SECONDS = 60;
const MIN_ACCESS_TOKEN_CACHE_TTL_SECONDS = 30;
const MAX_ORDER_FETCH_PAGES = 20; // README §6 Phase 4 — Amazon's shared-call budget, Flipkart's defensive cap
const MAX_PAYMENTS_RANGE_MS = 180 * 24 * 60 * 60 * 1000; // Amazon Finances API's real, confirmed hard cap (README §21)
const MAX_AMAZON_RETURNS_RANGE_MS = 60 * 24 * 60 * 60 * 1000; // GET_XML_RETURNS_DATA_BY_RETURN_DATE's real, documented cap

const accessTokenCacheKey = (clientId, tenantId, marketplaceConnectionId) =>
    `access_token:${clientId}:${tenantId}:${marketplaceConnectionId}`;

const cacheTtl = (expiresIn) =>
    Math.max(expiresIn - ACCESS_TOKEN_CACHE_SAFETY_MARGIN_SECONDS, MIN_ACCESS_TOKEN_CACHE_TTL_SECONDS);

// ─── Tenant sync (bulk, re-callable anytime) ────────────────────────────────────────

// Omitted tenants are left completely untouched — status only ever changes via an
// explicit status field in this list, never inferred from a tenant being left out.
const syncTenants = async (client, tenants) => {
    const results = [];

    for (const entry of tenants) {
        const { tenant_id, label, status } = entry;

        const tenant = await Tenant.findOneAndUpdate(
            { client: client._id, tenant_id },
            { $set: { status, ...(label !== undefined ? { label } : {}) } },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );

        results.push({ tenant_id: tenant.tenant_id, status: tenant.status });
    }

    return results;
};

// ─── Connect (OAuth start) ──────────────────────────────────────────────────────────

// Upserts unconditionally — the same code path whether this is a brand new connection
// or a reconnect of an existing ACTIVE/REAUTH_REQUIRED/DISCONNECTED one. Old token
// material is cleared immediately (not revoked — that's disconnect's job, not a
// supersede's); fetchOrders' strict status-gating means a stale token sitting around
// during the PENDING window could never be used anyway, so clearing it early is pure
// least-retention with no functional downside.
const connect = async (client, { tenant_id, marketplace, marketplace_connection_id, label }) => {
    await Connection.findOneAndUpdate(
        { client: client._id, tenant_id, marketplace },
        {
            $set: {
                marketplace_connection_id,
                ...(label !== undefined ? { label } : {}),
                status: 'pending',
                encrypted_refresh_token: { data: null, iv: null, authTag: null },
                marketplace_ids: [],
                last_error: null
            }
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    const adapter = getAdapter(marketplace);

    const state = await signState({
        client_id: client._id.toString(),
        tenant_id,
        marketplace,
        marketplace_connection_id
    });

    return { authorization_url: adapter.getAuthorizationUrl({ state }) };
};

// ─── OAuth callback (public endpoint) ───────────────────────────────────────────────

const buildErrorRedirect = (returnUrl, reason) => {
    const url = new URL(returnUrl);
    url.searchParams.set('status', 'error');
    url.searchParams.set('reason', reason);
    return url.toString();
};

const buildSuccessRedirect = (returnUrl, marketplaceConnectionId) => {
    const url = new URL(returnUrl);
    url.searchParams.set('status', 'active');
    url.searchParams.set('marketplace_connection_id', marketplaceConnectionId);
    return url.toString();
};

// Two genuinely different failure shapes, not one: an invalid/expired/replayed state
// means there is no verified client to redirect to, so this throws a plain error
// (redirecting anywhere here would itself be an open-redirect risk). Once state is
// verified, the client IS known, so every failure past that point redirects back to
// their own default_return_url with an error status instead.
const handleOAuthCallback = async ({ code, state, error: providerError }) => {
    const payload = await verifyAndConsumeState(state);

    if (!payload) {
        throw new AppError(400, 'INVALID_OAUTH_STATE', 'This authorization link is invalid, expired, or has already been used.');
    }

    const { client_id, tenant_id, marketplace, marketplace_connection_id } = payload;

    const client = await Client.findById(client_id);
    const connection = await Connection.findOne({ client: client_id, tenant_id, marketplace });

    if (!client || !connection) {
        // The state was valid but points at records that no longer exist (e.g. the
        // tenant was deleted mid-flow) — no safe destination to redirect to either.
        throw new AppError(404, 'CONNECTION_NOT_FOUND', 'The connection this authorization was started for no longer exists.');
    }

    if (providerError) {
        connection.last_error = providerError;
        await connection.save();
        return { redirect_url: buildErrorRedirect(client.default_return_url, providerError) };
    }

    const adapter = getAdapter(marketplace);

    let tokens;
    try {
        tokens = await adapter.exchangeCode({ code });
    } catch (err) {
        logByActor('system', 'error', 'OAuth code exchange failed', {
            marketplace, tenant_id, marketplace_connection_id,
            error: err.response?.data || err.message
        });
        connection.last_error = 'code_exchange_failed';
        await connection.save();
        return { redirect_url: buildErrorRedirect(client.default_return_url, 'code_exchange_failed') };
    }

    let marketplaceIds = [];
    if (marketplace === 'amazon') {
        try {
            marketplaceIds = await adapter.getMarketplaceParticipations({ accessToken: tokens.accessToken });
        } catch (err) {
            // Non-fatal — the OAuth grant itself succeeded; orders just won't page
            // through anything until this is retried.
            logByActor('system', 'warn', 'Failed to fetch Amazon marketplace participations', { error: err.message });
        }
    }

    connection.encrypted_refresh_token = encryptField(tokens.refreshToken);
    connection.marketplace_ids = marketplaceIds;
    connection.status = 'active';
    connection.last_connected_at = new Date();
    connection.last_error = null;
    await connection.save();

    await redisClient.set(
        accessTokenCacheKey(client._id, tenant_id, marketplace_connection_id),
        tokens.accessToken,
        { EX: cacheTtl(tokens.expiresIn) }
    );

    return { redirect_url: buildSuccessRedirect(client.default_return_url, marketplace_connection_id) };
};

// ─── Disconnect / teardown ──────────────────────────────────────────────────────────

// Shared by disconnect() and deleteTenant()'s cascade. Idempotent: a no-op if the
// connection is already disconnected.
const disconnectConnectionDoc = async (client, connection) => {
    if (connection.status === 'disconnected') {
        return connection;
    }

    const adapter = getAdapter(connection.marketplace);

    if (connection.encrypted_refresh_token?.data) {
        try {
            const refreshToken = decryptField(connection.encrypted_refresh_token);
            await adapter.revokeToken({ refreshToken });
        } catch (err) {
            // Best-effort only — see adapters/*/index.js revokeToken for why neither
            // marketplace guarantees a real revoke call exists.
            logByActor('system', 'warn', 'Best-effort token revoke failed', {
                marketplace: connection.marketplace, error: err.message
            });
        }
    }

    await redisClient.del(accessTokenCacheKey(client._id, connection.tenant_id, connection.marketplace_connection_id));

    connection.encrypted_refresh_token = { data: null, iv: null, authTag: null };
    connection.status = 'disconnected';
    await connection.save();

    return connection;
};

// Looks up by all four fields (not just client/tenant/marketplace) so a mismatched
// marketplace_connection_id correctly 404s instead of silently disconnecting a
// different seller account than the caller thinks it's disconnecting.
const disconnect = async (client, { tenant_id, marketplace, marketplace_connection_id }) => {
    const connection = await Connection.findOne({
        client: client._id, tenant_id, marketplace, marketplace_connection_id
    });

    if (!connection) {
        throw new AppError(404, 'CONNECTION_NOT_FOUND', 'No matching connection found.');
    }

    await disconnectConnectionDoc(client, connection);

    return { status: connection.status };
};

// Soft delete, mirrors Speedecom's own Upload.deletedAt convention — cascades through
// every Connection for this tenant regardless of current status.
const deleteTenant = async (client, { tenant_id }) => {
    const tenant = await Tenant.findOne({ client: client._id, tenant_id });

    if (!tenant) {
        throw new AppError(404, 'TENANT_NOT_FOUND', 'No matching tenant found.');
    }

    tenant.deletedAt = new Date();
    await tenant.save();

    const connections = await Connection.find({ client: client._id, tenant_id });
    for (const connection of connections) {
        await disconnectConnectionDoc(client, connection);
    }

    return { tenant_id: tenant.tenant_id, deleted_connections: connections.length };
};

// ─── Fetch orders ────────────────────────────────────────────────────────────────────

// Concurrent requests hitting an expired cache entry at the same moment previously each
// called adapter.getAccessToken() independently — harmless for Amazon (LWA never rotates
// the refresh token), but a real race for Flipkart, which DOES rotate it on every
// refresh: whichever concurrent call is processed second sends a refresh token Flipkart
// already invalidated by the first, fails, and incorrectly marks a perfectly healthy
// connection as reauth_required. Deduping in-process (one real refresh per cacheKey,
// every concurrent caller awaits the same promise) fixes this for a single instance;
// scaling the Connector to multiple instances would need a real Redis-based lock instead.
const inFlightRefreshes = new Map();

const getValidAccessToken = async (client, connection) => {
    const cacheKey = accessTokenCacheKey(client._id, connection.tenant_id, connection.marketplace_connection_id);
    const cached = await redisClient.get(cacheKey);
    if (cached) return cached;

    const existing = inFlightRefreshes.get(cacheKey);
    if (existing) return existing;

    const refreshPromise = refreshAccessToken(client, connection, cacheKey).finally(() => {
        inFlightRefreshes.delete(cacheKey);
    });
    inFlightRefreshes.set(cacheKey, refreshPromise);
    return refreshPromise;
};

const refreshAccessToken = async (client, connection, cacheKey) => {
    const adapter = getAdapter(connection.marketplace);
    const refreshToken = decryptField(connection.encrypted_refresh_token);

    let tokens;
    try {
        tokens = await adapter.getAccessToken({ refreshToken });
    } catch (err) {
        // Only a genuine grant rejection (400 invalid_grant — Amazon/Flipkart's real
        // response for a revoked/expired refresh token) means the connection actually
        // needs a human to reauthorize. Anything else reaching here (a network failure,
        // or a 5xx that survived requestWithRetry's own retry ladder) is a transient
        // provider outage, not a dead grant — previously ANY error here, including a
        // 1-second network blip, permanently corrupted the connection to reauth_required
        // in Mongo, forcing manual reauthorization for something that would have
        // succeeded on the very next call.
        if (err.response?.status === 400) {
            connection.status = 'reauth_required';
            connection.last_error = 'refresh_failed';
            await connection.save();
            throw new AppError(409, 'REAUTH_REQUIRED', 'This connection needs to be reauthorized.');
        }
        throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'The marketplace token endpoint is temporarily unavailable — try again shortly.');
    }

    // Flipkart sometimes rotates the refresh token on refresh; Amazon's LWA never does.
    if (tokens.refreshToken) {
        connection.encrypted_refresh_token = encryptField(tokens.refreshToken);
        await connection.save();
    }

    await redisClient.set(cacheKey, tokens.accessToken, { EX: cacheTtl(tokens.expiresIn) });

    return tokens.accessToken;
};

const normalizeAmazonOrder = (order) => ({
    order_id: order.AmazonOrderId,
    marketplace: 'amazon',
    status: order.OrderStatus,
    order_date: order.PurchaseDate,
    total_amount: order.OrderTotal ? Number(order.OrderTotal.Amount) : null,
    currency: order.OrderTotal ? order.OrderTotal.CurrencyCode : null,
    raw: order
});

const normalizeFlipkartOrder = (order) => ({
    order_id: order.orderId,
    marketplace: 'flipkart',
    status: order.status,
    order_date: order.orderDate,
    total_amount: order.orderValue ?? null,
    currency: 'INR',
    raw: order
});

// Refreshes once and resumes the SAME page on a mid-loop token expiry — never restarts
// the whole paginated fetch from empty.
const fetchAmazonOrdersPaged = async (client, connection, initialAccessToken, from, to) => {
    const adapter = getAdapter('amazon');
    const orders = [];
    let nextToken;
    let accessToken = initialAccessToken;
    let retriedThisPage = false;

    for (let page = 0; page < MAX_ORDER_FETCH_PAGES; page++) {
        let response;
        try {
            response = await adapter.fetchOrders({
                accessToken, marketplaceIds: connection.marketplace_ids, from, to, nextToken
            });
            retriedThisPage = false;
        } catch (err) {
            // Retry exactly once per page, and only after evicting the cache — without
            // the eviction, getValidAccessToken's cache-hit path returns the SAME token
            // that was just rejected, and page-- + the for loop's own page++ cancel out,
            // pinning the loop in place forever (a real, confirmed infinite-retry bug).
            // If a freshly-refreshed token also 401s, that's a genuinely broken grant —
            // surface it instead of retrying again.
            if (err.response?.status === 401 && !retriedThisPage) {
                await redisClient.del(accessTokenCacheKey(client._id, connection.tenant_id, connection.marketplace_connection_id));
                accessToken = await getValidAccessToken(client, connection);
                retriedThisPage = true;
                page--;
                continue;
            }
            throw err;
        }

        orders.push(...(response.payload?.Orders || []).map(normalizeAmazonOrder));
        nextToken = response.payload?.NextToken;
        if (!nextToken) break;
    }

    return orders;
};

const fetchFlipkartOrdersPaged = async (client, connection, initialAccessToken, from, to) => {
    const adapter = getAdapter('flipkart');
    const orders = [];
    let nextPageUrl;
    let accessToken = initialAccessToken;
    let retriedThisPage = false;

    for (let page = 0; page < MAX_ORDER_FETCH_PAGES; page++) {
        let response;
        try {
            response = await adapter.fetchOrders({ accessToken, from, to, nextPageUrl });
            retriedThisPage = false;
        } catch (err) {
            if (err.response?.status === 401 && !retriedThisPage) {
                await redisClient.del(accessTokenCacheKey(client._id, connection.tenant_id, connection.marketplace_connection_id));
                accessToken = await getValidAccessToken(client, connection);
                retriedThisPage = true;
                page--;
                continue;
            }
            throw err;
        }

        // Field name unverified against a real response (Flipkart's docs describe the
        // shape only in prose) — confirm this on the first real Flipkart order fetch.
        const items = response.orderItems || [];
        orders.push(...items.map(normalizeFlipkartOrder));
        if (!response.nextPageURL) break;
        nextPageUrl = response.nextPageURL;
    }

    return orders;
};

// Shared by fetchOrders and getConnectionStatus — marketplace isn't part of the lookup
// (neither's documented request shape includes it), so in the practically-impossible
// case of a real collision across marketplaces, this surfaces it loudly rather than
// silently picking one.
const findConnectionByMarketplaceConnectionId = async (client, tenant_id, marketplace_connection_id) => {
    const matches = await Connection.find({ client: client._id, tenant_id, marketplace_connection_id });

    if (matches.length === 0) {
        throw new AppError(404, 'CONNECTION_NOT_FOUND', 'No matching connection found.');
    }
    if (matches.length > 1) {
        logByActor('system', 'error', 'Ambiguous marketplace_connection_id across marketplaces', {
            tenant_id, marketplace_connection_id, count: matches.length
        });
        throw new AppError(500, 'AMBIGUOUS_CONNECTION', 'Multiple connections matched this marketplace_connection_id.');
    }

    return matches[0];
};

// Read-only — never returns a token of any kind, only lifecycle metadata.
const getConnectionStatus = async (client, { tenant_id, marketplace_connection_id }) => {
    const connection = await findConnectionByMarketplaceConnectionId(client, tenant_id, marketplace_connection_id);

    return {
        status: connection.status,
        last_connected_at: connection.last_connected_at,
        last_error: connection.last_error
    };
};

// Shared by fetchOrders and fetchData — same three guard conditions either way.
const assertConnectionUsable = (connection) => {
    if (connection.status === 'pending') {
        throw new AppError(409, 'CONNECTION_PENDING', 'This connection has not finished the authorization flow yet.');
    }
    if (connection.status === 'reauth_required') {
        throw new AppError(409, 'REAUTH_REQUIRED', 'This connection needs to be reauthorized.');
    }
    if (connection.status === 'disconnected') {
        throw new AppError(409, 'CONNECTION_DISCONNECTED', 'This connection has been disconnected.');
    }
};

// Amazon's Orders/Finances/Reports calls all require at least one MarketplaceIds value —
// normally populated once, right after OAuth, by getMarketplaceParticipations (README §6).
// If that one call happened to fail, the connection still goes ACTIVE with
// marketplace_ids: [] (a deliberate non-fatal choice — the OAuth grant itself is fine),
// but every future fetch would then silently omit the required param entirely
// (`[].forEach()` is a no-op) and get a confusing Amazon 400 with no path to recover —
// reconnecting is the only way to retry the participations call. Surface that plainly
// instead of letting Amazon's own opaque error be the first sign anything's wrong.
const assertAmazonMarketplaceIdsPopulated = (connection) => {
    if (connection.marketplace === 'amazon' && connection.marketplace_ids.length === 0) {
        throw new AppError(409, 'MARKETPLACE_IDS_NOT_POPULATED', 'This Amazon connection has no marketplace participations on record — disconnect and reconnect to repopulate them.');
    }
};

// Real, verified edge case: Amazon requires CreatedBefore/postedBefore to be at least
// ~2 minutes before "now" (adapters/amazon's BEFORE_DATE_SAFETY_MARGIN_MS), and that
// clamp is floored at `from` so it can never invert into `from > to`. But if `from`
// itself is more recent than that margin, satisfying BOTH constraints is impossible —
// the floored clamp lands on `from` exactly, which is still too recent, and Amazon
// rejects it with the same InvalidInput either way. Reject it here with a clear reason
// instead of letting that confusing round trip happen.
const assertAmazonFromNotTooRecent = (connection, from) => {
    if (connection.marketplace !== 'amazon') return;
    const marginMs = getAdapter('amazon').BEFORE_DATE_SAFETY_MARGIN_MS;
    if (new Date(from).getTime() > Date.now() - marginMs) {
        throw new AppError(400, 'INVALID_DATE_RANGE', `"from" must be at least ${marginMs / 60000} minutes before now — Amazon's own data has up to that much retrieval lag.`);
    }
};

const fetchOrders = async (client, { tenant_id, marketplace_connection_id, from, to }) => {
    const connection = await findConnectionByMarketplaceConnectionId(client, tenant_id, marketplace_connection_id);
    assertConnectionUsable(connection);
    assertAmazonMarketplaceIdsPopulated(connection);
    assertAmazonFromNotTooRecent(connection, from);

    const accessToken = await getValidAccessToken(client, connection);

    const orders = connection.marketplace === 'amazon'
        ? await fetchAmazonOrdersPaged(client, connection, accessToken, from, to)
        : await fetchFlipkartOrdersPaged(client, connection, accessToken, from, to);

    return { orders };
};

// Amazon: paginated via nextToken, same 401-refresh-and-resume pattern as orders.
// Response envelope field name (`transactions`) is unverified — see adapters/amazon/index.js.
const fetchAmazonPaymentsPaged = async (client, connection, initialAccessToken, from, to) => {
    const adapter = getAdapter('amazon');
    const transactions = [];
    let nextToken;
    let accessToken = initialAccessToken;
    let retriedThisPage = false;

    for (let page = 0; page < MAX_ORDER_FETCH_PAGES; page++) {
        let response;
        try {
            response = await adapter.fetchPayments({ accessToken, marketplaceIds: connection.marketplace_ids, from, to, nextToken });
            retriedThisPage = false;
        } catch (err) {
            if (err.response?.status === 401 && !retriedThisPage) {
                await redisClient.del(accessTokenCacheKey(client._id, connection.tenant_id, connection.marketplace_connection_id));
                accessToken = await getValidAccessToken(client, connection);
                retriedThisPage = true;
                page--;
                continue;
            }
            throw err;
        }

        // Real response is {payload: {transactions, nextToken?}} — same payload-wrapper
        // convention as Orders (payload.Orders). Confirmed via a real call that returned
        // 133 genuine transactions our earlier top-level `response.transactions` read
        // completely missed — it silently fell back to [] instead of erroring, which read
        // as a false "confirmed correct, zero results" the first time this was tested.
        transactions.push(...(response.payload?.transactions || []));
        nextToken = response.payload?.nextToken;
        if (!nextToken) break;
    }

    return transactions;
};

// Flipkart: paginated via nextUrl, same shape as fetchFlipkartOrdersPaged.
const fetchFlipkartReturnsPaged = async (client, connection, initialAccessToken, from, to) => {
    const adapter = getAdapter('flipkart');
    const returns = [];
    let nextPageUrl;
    let accessToken = initialAccessToken;
    let retriedThisPage = false;

    for (let page = 0; page < MAX_ORDER_FETCH_PAGES; page++) {
        let response;
        try {
            response = await adapter.fetchReturns({ accessToken, from, to, nextPageUrl });
            retriedThisPage = false;
        } catch (err) {
            if (err.response?.status === 401 && !retriedThisPage) {
                await redisClient.del(accessTokenCacheKey(client._id, connection.tenant_id, connection.marketplace_connection_id));
                accessToken = await getValidAccessToken(client, connection);
                retriedThisPage = true;
                page--;
                continue;
            }
            throw err;
        }

        returns.push(...(response.returnItems || []));
        if (!response.nextUrl) break;
        nextPageUrl = response.nextUrl;
    }

    return returns;
};

// Covers Amazon Payments and Amazon/Flipkart Returns — kept as one action with a
// `data_type` discriminator rather than a separate action per type (README §21). Amazon
// returns is a single async report covering the whole range, not paginated request-by-
// request like everything else here, so it has no 401-refresh-and-resume loop the way the
// paginated paths do — a token expiring mid-poll (unlikely inside a ~1hr access-token
// lifetime) surfaces as a plain error instead of transparently recovering.
const fetchData = async (client, { tenant_id, marketplace_connection_id, data_type, from, to }) => {
    const connection = await findConnectionByMarketplaceConnectionId(client, tenant_id, marketplace_connection_id);
    assertConnectionUsable(connection);
    assertAmazonMarketplaceIdsPopulated(connection);

    const accessToken = await getValidAccessToken(client, connection);

    if (data_type === 'payments') {
        if (connection.marketplace !== 'amazon') {
            throw new AppError(400, 'DATA_TYPE_NOT_SUPPORTED', 'payments is only available for amazon — Flipkart settlement reports require a paid Partner-tier agreement with Flipkart, not implemented here.');
        }
        assertAmazonFromNotTooRecent(connection, from);
        // Confirmed via a real Amazon error ("Date range exceeds maximum number of days:
        // 180") — checked here, before the call, so a too-wide range fails with a clear,
        // actionable message instead of Amazon's InvalidInput surfacing as a generic 500.
        if (new Date(to) - new Date(from) > MAX_PAYMENTS_RANGE_MS) {
            throw new AppError(400, 'INVALID_DATE_RANGE', 'Amazon Finances API allows at most a 180-day range between from and to — split the request into multiple 180-day windows.');
        }
        return { transactions: await fetchAmazonPaymentsPaged(client, connection, accessToken, from, to) };
    }

    // data_type === 'returns' (Joi already restricts data_type to these two values)
    if (connection.marketplace === 'amazon') {
        if (new Date(to) - new Date(from) > MAX_AMAZON_RETURNS_RANGE_MS) {
            throw new AppError(400, 'INVALID_DATE_RANGE', 'Amazon returns reports allow at most a 60-day range between from and to — split the request into multiple 60-day windows.');
        }
        const adapter = getAdapter('amazon');
        return { returns: await adapter.fetchReturns({ accessToken, marketplaceIds: connection.marketplace_ids, from, to }) };
    }
    return { returns: await fetchFlipkartReturnsPaged(client, connection, accessToken, from, to) };
};

// README §5 documented this transition as already existing; it wasn't — no cron/TTL
// index anywhere ever implemented it, so an abandoned Connect flow stayed PENDING
// forever. Pure cleanup of stuck rows, only touches connections already stuck.
const ABANDONED_PENDING_MS = 30 * 60 * 1000;

const sweepAbandonedPendingConnections = async () => {
    const cutoff = new Date(Date.now() - ABANDONED_PENDING_MS);
    const result = await Connection.updateMany(
        { status: 'pending', updatedAt: { $lt: cutoff } },
        { $set: { status: 'disconnected', last_error: 'abandoned_pending_timeout' } }
    );
    if (result.modifiedCount > 0) {
        logByActor('system', 'info', 'Swept abandoned PENDING connections', { count: result.modifiedCount });
    }
};

module.exports = {
    syncTenants,
    connect,
    handleOAuthCallback,
    getConnectionStatus,
    disconnect,
    deleteTenant,
    fetchOrders,
    fetchData,
    sweepAbandonedPendingConnections
};
