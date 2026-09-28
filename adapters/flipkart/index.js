const { URLSearchParams } = require('url');

const env = require('../../config/env');
const requestWithRetry = require('../requestWithRetry');

// Flipkart Seller API adapter. Same four-function interface as adapters/amazon — no
// SigV4 equivalent needed here, it's a standard OAuth 2.0 bearer-token API.
//
// Verified against Flipkart's own docs (seller.flipkart.com/api-docs/listing-api-docs/
// authTut.html) — two real corrections from the generic-OAuth2 assumption this was
// originally built on, before that documentation had been found: the authorization URL
// needs an explicit scope=Seller_Api param, and the token endpoint authenticates via
// HTTP Basic Auth (client_id:secret in the Authorization header), not client_id/secret as
// body fields — and takes GET with query-string params, not a POST body, per Flipkart's
// own documented curl example.

const basicAuthHeader = () =>
    'Basic ' + Buffer.from(`${env.flipkart.clientId}:${env.flipkart.clientSecret}`).toString('base64');

const getAuthorizationUrl = ({ state }) => {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: env.flipkart.clientId,
        redirect_uri: env.flipkart.oauthRedirectUri,
        scope: 'Seller_Api',
        state
    });
    return `${env.flipkart.authorizationBaseUrl}?${params.toString()}`;
};

const exchangeCode = async ({ code }) => {
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.flipkart.oauthRedirectUri
    });

    const response = await requestWithRetry({
        method: 'get',
        url: `${env.flipkart.tokenUrl}?${params.toString()}`,
        headers: { Authorization: basicAuthHeader() }
    });

    return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in
    };
};

const getAccessToken = async ({ refreshToken }) => {
    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });

    const response = await requestWithRetry({
        method: 'get',
        url: `${env.flipkart.tokenUrl}?${params.toString()}`,
        headers: { Authorization: basicAuthHeader() }
    });

    return {
        accessToken: response.data.access_token,
        // Unlike Amazon, Flipkart does sometimes rotate the refresh token on refresh —
        // pass it through and let Layer 6 decide whether to persist an updated one.
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in
    };
};

// Verified against Flipkart's real Order Management API docs (seller.flipkart.com/api-docs/
// order-api-docs/SearchOrderRef.html) — the original implementation was built around the
// mock server's shape, not Flipkart's real one, and got every real detail wrong: real search
// is POST (not GET) to /sellers/v2/orders/search (not /orders/search) with a nested JSON
// body (not orderDate=from_to as a query param), and pagination is done by literally calling
// the exact `nextPageURL` the response hands back, not an offset we compute ourselves.
const fetchOrders = async ({ accessToken, from, to, nextPageUrl }) => {
    const response = await requestWithRetry(
        nextPageUrl
            ? { method: 'get', url: nextPageUrl, headers: { Authorization: `Bearer ${accessToken}` } }
            : {
                method: 'post',
                url: `${env.flipkart.apiBaseUrl}/sellers/v2/orders/search`,
                headers: { Authorization: `Bearer ${accessToken}` },
                data: {
                    filter: { orderDate: { fromDate: from, toDate: to } },
                    pagination: { pageSize: 20 },
                    sort: { field: 'orderDate', order: 'desc' }
                }
            }
    );

    return response.data;
};

// Verified against Flipkart's real docs (seller.flipkart.com/api-docs/order-api-docs/
// ReturnsRef.html): GET /sellers/v2/returns?createdAfter=...&createdBefore=..., paginated
// via a `nextUrl` field — same "call the exact URL the response hands back" pattern as
// order-search pagination, and much simpler than Amazon's async report flow for the same
// data. Response envelope field name is a best-guess match to Flipkart's `orderItems`
// naming convention (`returnItems`) — NOT confirmed against a real response; no real
// Flipkart app is registered yet (README §21). Verify on first real call.
const fetchReturns = async ({ accessToken, from, to, nextPageUrl }) => {
    const response = await requestWithRetry(
        nextPageUrl
            ? { method: 'get', url: nextPageUrl, headers: { Authorization: `Bearer ${accessToken}` } }
            : {
                method: 'get',
                url: `${env.flipkart.apiBaseUrl}/sellers/v2/returns`,
                headers: { Authorization: `Bearer ${accessToken}` },
                params: { createdAfter: from, createdBefore: to }
            }
    );

    return response.data;
};

// Flipkart's Seller API has no verified public "revoke this token" endpoint either —
// same honest best-effort no-op as adapters/amazon, for the same reason.
const revokeToken = async () => {
    return { revoked: false, reason: 'not_supported' };
};

module.exports = { getAuthorizationUrl, exchangeCode, getAccessToken, fetchOrders, fetchReturns, revokeToken };
