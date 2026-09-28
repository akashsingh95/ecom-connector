const connectionService = require('../services/connectionService');

// Public, unauthenticated — hit directly by Amazon/Flipkart's redirect after seller
// consent, never by a client or an SDK. req.query is NOT run through Layer 8's Joi
// validator like the authenticated routes are: the marketplace controls this request's
// shape, not a Connector client, so there's nothing of ours to validate it against.
//
// A thrown error here (invalid/expired state, or the state's own records gone) is
// deliberately NOT turned into a redirect — see connectionService.handleOAuthCallback —
// so it just flows to errorHandler.js as a plain JSON response, same as any other error.
const handleCallback = async (req, res) => {
    // Amazon SP-API doesn't use the standard OAuth2 `code` param on its callback — it sends
    // `spapi_oauth_code` instead (plus an unsolicited `selling_partner_id`, unused for now).
    // Flipkart follows plain OAuth2 and sends `code`. Safe to OR them: neither marketplace
    // ever sends the other's param name.
    const { code, spapi_oauth_code, state, error } = req.query;
    const { redirect_url } = await connectionService.handleOAuthCallback({ code: code || spapi_oauth_code, state, error });
    return res.redirect(redirect_url);
};

module.exports = { handleCallback };
