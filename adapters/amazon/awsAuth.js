const aws4 = require('aws4');
const { URL, URLSearchParams } = require('url');

const env = require('../../config/env');
const redisClient = require('../../utils/redisClient');
const requestWithRetry = require('../requestWithRetry');

const STS_CACHE_KEY = 'aws_sts_credentials';
const SESSION_DURATION_SECONDS = 3600;
const SAFETY_MARGIN_SECONDS = 120;

// STS temporary credentials are shared Connector-wide infrastructure, not per-tenant —
// cached in Redis exactly like an OAuth access token, just keyed globally.
const assumeRole = async () => {
    const stsUrl = new URL(env.aws.stsEndpoint);

    const body = new URLSearchParams({
        Action: 'AssumeRole',
        Version: '2011-06-15',
        RoleArn: env.aws.roleArn,
        RoleSessionName: 'ecom-connector',
        DurationSeconds: String(SESSION_DURATION_SECONDS)
    }).toString();

    const requestOptions = {
        host: stsUrl.host,
        method: 'POST',
        path: stsUrl.pathname || '/',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        service: 'sts',
        region: env.aws.region
    };

    aws4.sign(requestOptions, {
        accessKeyId: env.aws.accessKeyId,
        secretAccessKey: env.aws.secretAccessKey
    });

    const response = await requestWithRetry({
        method: 'post',
        url: env.aws.stsEndpoint,
        data: body,
        headers: requestOptions.headers
    });

    // STS's default response is XML — pulling out the three fields directly avoids
    // adding an XML-parser dependency just for this.
    const xml = response.data;
    const extract = (tag) => xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1];

    return {
        accessKeyId: extract('AccessKeyId'),
        secretAccessKey: extract('SecretAccessKey'),
        sessionToken: extract('SessionToken'),
        expiration: extract('Expiration')
    };
};

const getStsCredentials = async () => {
    const cached = await redisClient.get(STS_CACHE_KEY);
    if (cached) return JSON.parse(cached);

    const credentials = await assumeRole();
    await redisClient.set(STS_CACHE_KEY, JSON.stringify(credentials), {
        EX: SESSION_DURATION_SECONDS - SAFETY_MARGIN_SECONDS
    });

    return credentials;
};

// Signs an SP-API request in place — adds Authorization/x-amz-* headers directly onto
// requestOptions.headers using freshly-cached temporary STS credentials. Mutates and
// also returns requestOptions for convenience.
const signSpApiRequest = async (requestOptions) => {
    const credentials = await getStsCredentials();

    requestOptions.service = 'execute-api';
    requestOptions.region = env.aws.region;

    aws4.sign(requestOptions, {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken
    });

    return requestOptions;
};

module.exports = { getStsCredentials, signSpApiRequest };
