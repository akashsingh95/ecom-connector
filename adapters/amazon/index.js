const { URL, URLSearchParams } = require('url');
const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');

const env = require('../../config/env');
const requestWithRetry = require('../requestWithRetry');
const { signSpApiRequest } = require('./awsAuth');

// Amazon SP-API adapter. Same four-function interface as adapters/flipkart, plus
// Amazon-only extras (getMarketplaceParticipations, fetchPayments, fetchReturns) that
// Flipkart either has no equivalent of, or (fetchReturns) implements completely differently.

// Every signed SP-API call repeats "build requestOptions, sign it, send it" — this is
// that pattern factored out, used by every function below except the raw LWA token calls
// (which aren't SP-API and need no SigV4 signature at all).
const signedSpApiRequest = async ({ accessToken, method, path, data }) => {
    const baseUrl = new URL(env.amazon.spApiBaseUrl);
    const headers = { 'x-amz-access-token': accessToken, ...(data ? { 'Content-Type': 'application/json' } : {}) };
    const requestOptions = { host: baseUrl.host, method: method.toUpperCase(), path, headers, ...(data ? { body: JSON.stringify(data) } : {}) };
    await signSpApiRequest(requestOptions);

    return requestWithRetry({
        method,
        url: `${env.amazon.spApiBaseUrl}${path}`,
        headers: requestOptions.headers,
        ...(data ? { data } : {})
    });
};

const getAuthorizationUrl = ({ state }) => {
    const params = new URLSearchParams({
        application_id: env.amazon.applicationId,
        state,
        redirect_uri: env.amazon.oauthRedirectUri,
        ...(env.amazon.draftMode ? { version: 'beta' } : {})
    });
    return `${env.amazon.authorizationBaseUrl}?${params.toString()}`;
};

const exchangeCode = async ({ code }) => {
    const response = await requestWithRetry({
        method: 'post',
        url: env.amazon.tokenUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: env.amazon.clientId,
            client_secret: env.amazon.clientSecret,
            redirect_uri: env.amazon.oauthRedirectUri
        }).toString()
    });

    return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in
    };
};

// LWA's refresh response has no refresh_token field — SP-API refresh tokens don't
// expire on their own, only an explicit revocation kills them (-> REAUTH_REQUIRED).
const getAccessToken = async ({ refreshToken }) => {
    const response = await requestWithRetry({
        method: 'post',
        url: env.amazon.tokenUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: env.amazon.clientId,
            client_secret: env.amazon.clientSecret
        }).toString()
    });

    return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in
    };
};

// SP-API's orders endpoint requires MarketplaceIds (which country storefronts to read),
// which nothing in the OAuth flow hands us directly — this discovers them so Layer 6 can
// call it once right after OAuth completes and store the result on the Connection.
const getMarketplaceParticipations = async ({ accessToken }) => {
    const response = await signedSpApiRequest({ accessToken, method: 'get', path: '/sellers/v1/marketplaceParticipations' });
    return (response.data.payload || []).map((entry) => entry.marketplace.id);
};

// SP-API rejects an end-of-range date within 2 minutes of "now" on EVERY endpoint that
// takes one — confirmed on both Orders (CreatedBefore) and Finances (postedBefore), same
// exact "up to 2 minutes of retrieval lag" reasoning both times. Any caller passing "now"
// as `to` (the obvious thing to do) would otherwise hit InvalidInput on every request.
//
// Real regression found in this exact fix: clamping `to` alone, with no floor, can push
// it BEFORE `from` whenever the caller asks for a recent window (e.g. from=now-1min,
// to=now) — from=now-1min, clamped to=now-3min, so CreatedAfter > CreatedBefore, which
// Amazon also rejects, just with a different error. `from` is now a hard floor: the
// clamp never produces a range narrower than the caller actually can't have avoided.
const BEFORE_DATE_SAFETY_MARGIN_MS = 3 * 60 * 1000;
const clampBeforeDate = (to, from) => {
    const clamped = Math.min(new Date(to).getTime(), Date.now() - BEFORE_DATE_SAFETY_MARGIN_MS);
    return new Date(Math.max(clamped, new Date(from).getTime())).toISOString();
};

const fetchOrders = async ({ accessToken, marketplaceIds, from, to, nextToken }) => {
    const query = new URLSearchParams();
    marketplaceIds.forEach((id) => query.append('MarketplaceIds', id));
    query.set('CreatedAfter', from);
    query.set('CreatedBefore', clampBeforeDate(to, from));
    if (nextToken) query.set('NextToken', nextToken);

    const response = await signedSpApiRequest({ accessToken, method: 'get', path: `/orders/v0/orders?${query.toString()}` });
    return response.data;
};

// Finance and Accounting role (already granted on this app) — confirmed against Amazon's
// real Finances API v2024-06-19 model: GET /finances/2024-06-19/transactions with
// postedAfter/postedBefore/marketplaceId/nextToken query params. Response is wrapped in a
// `payload` envelope (`payload.transactions`, `payload.nextToken`) — same convention as
// Orders' `payload.Orders` — confirmed via a real call returning 133 genuine transactions;
// an earlier test against an empty date window returned an empty array either way, which
// looked like confirmation but wasn't (see connectionService.js's fetchAmazonPaymentsPaged).
const fetchPayments = async ({ accessToken, marketplaceIds, from, to, nextToken }) => {
    const query = new URLSearchParams({ postedAfter: from, postedBefore: clampBeforeDate(to, from) });
    if (marketplaceIds?.[0]) query.set('marketplaceId', marketplaceIds[0]);
    if (nextToken) query.set('nextToken', nextToken);

    const response = await signedSpApiRequest({ accessToken, method: 'get', path: `/finances/2024-06-19/transactions?${query.toString()}` });
    return response.data;
};

// Amazon has no direct, synchronous "list returns" call like Orders/Finances — returns
// only come through the async Reports API: request a report, poll until it's done,
// fetch a presigned download URL, then download and decompress/parse the file yourself.
//
// reportType is GET_XML_RETURNS_DATA_BY_RETURN_DATE, NOT GET_FBA_FULFILLMENT_CUSTOMER_
// RETURNS_DATA (what this originally used) — that one is FBA-only and genuinely 403s for
// an MFN (merchant-fulfilled) seller, confirmed both by real testing (persistent 403 with
// the Inventory and Order Tracking role already granted) and by Amazon's own docs description
// of the FBA-specific report. GET_XML_RETURNS_DATA_BY_RETURN_DATE covers MFN returns and
// needs only the already-granted Inventory and Order Tracking role — no extra role, no
// re-authorization needed. Real, meaningful difference: this one is XML, not TSV, and
// caps at 60 days per request (not 180, unlike Finances — see MAX_RETURNS_RANGE_MS in
// connectionService.js).
const REPORT_POLL_INTERVAL_MS = 5000;
const REPORT_POLL_MAX_ATTEMPTS = 24; // ~2 minutes total

const xmlParser = new XMLParser({ ignoreAttributes: false });

// Exact root/record element names for this report aren't confirmed against a real
// response yet (Amazon's docs describe the fields in prose, not a schema) — this walks
// the parsed tree and returns the first repeated-sibling array it finds, which is how
// fast-xml-parser represents "many of the same element," rather than guessing a specific
// tag name that might be wrong. Verify the actual shape the first time this returns data.
const firstArrayIn = (node) => {
    if (Array.isArray(node)) return node;
    if (node && typeof node === 'object') {
        for (const value of Object.values(node)) {
            const found = firstArrayIn(value);
            if (found) return found;
        }
    }
    return null;
};

const fetchReturns = async ({ accessToken, marketplaceIds, from, to }) => {
    const createResponse = await signedSpApiRequest({
        accessToken, method: 'post', path: '/reports/2021-06-30/reports',
        data: { reportType: 'GET_XML_RETURNS_DATA_BY_RETURN_DATE', marketplaceIds, dataStartTime: from, dataEndTime: to }
    });
    const { reportId } = createResponse.data;

    let reportDocumentId;
    for (let attempt = 0; attempt < REPORT_POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, REPORT_POLL_INTERVAL_MS));

        const pollResponse = await signedSpApiRequest({ accessToken, method: 'get', path: `/reports/2021-06-30/reports/${reportId}` });
        const { processingStatus, reportDocumentId: docId } = pollResponse.data;

        if (processingStatus === 'DONE') { reportDocumentId = docId; break; }
        if (processingStatus === 'CANCELLED' || processingStatus === 'FATAL') {
            throw new Error(`Amazon returns report ${reportId} finished with status ${processingStatus}`);
        }
    }
    if (!reportDocumentId) {
        throw new Error(`Amazon returns report ${reportId} did not finish within ${(REPORT_POLL_MAX_ATTEMPTS * REPORT_POLL_INTERVAL_MS) / 1000}s`);
    }

    const docResponse = await signedSpApiRequest({ accessToken, method: 'get', path: `/reports/2021-06-30/documents/${reportDocumentId}` });
    const { url, compressionAlgorithm } = docResponse.data;

    // Presigned S3 URL — a plain, unsigned GET (SigV4/LWA headers aren't accepted here,
    // and the URL expires in 5 minutes per Amazon's docs).
    const fileResponse = await requestWithRetry({ method: 'get', url, responseType: 'arraybuffer' });
    const raw = compressionAlgorithm === 'GZIP' ? zlib.gunzipSync(fileResponse.data) : Buffer.from(fileResponse.data);

    const parsed = xmlParser.parse(raw.toString('utf8'));
    return firstArrayIn(parsed) || [parsed];
};

// LWA has no documented public "revoke this refresh token" endpoint — Amazon's model is
// that the seller revokes authorization from within Seller Central themselves. disconnect()
// calls this as a best-effort step regardless; it degrades to "discard our copy only",
// which is honest about what's actually achievable here, not a placeholder for a real call.
const revokeToken = async () => {
    return { revoked: false, reason: 'not_supported' };
};

module.exports = {
    getAuthorizationUrl,
    exchangeCode,
    getAccessToken,
    getMarketplaceParticipations,
    fetchOrders,
    fetchPayments,
    fetchReturns,
    revokeToken,
    // Exported so connectionService can reject an impossible request up front (a `from`
    // more recent than this margin has no valid `to` — every candidate either comes
    // before `from` or violates Amazon's own "at least this long before now" rule) instead
    // of letting it reach Amazon and come back as a confusing InvalidInput.
    BEFORE_DATE_SAFETY_MARGIN_MS
};
