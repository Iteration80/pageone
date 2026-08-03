/**
 * routes/auth.js — the Google sign-in and session endpoints.
 *
 * Split out of `utils/auth.js` on 2026-08-03 (item 5 of the 2026-07-08 audit brief).
 * The routes were originally kept beside the crypto to hold all the security-sensitive
 * code in one file, which was a reasonable call; the cost was that this was the only
 * route module not living in routes/, so "where are the routes registered" had one
 * answer for seven modules and a different one for the eighth.
 *
 * The split is by KIND, not by sensitivity: `utils/auth.js` still owns everything that
 * decides whether a request is authenticated — config gating, session signing and
 * verification, cookie parsing, the live allowlist check — and this file only wires
 * those decisions to URLs. Nothing security-relevant was reimplemented here.
 */

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const {
    SESSION_COOKIE,
    STATE_COOKIE,
    SESSION_TTL_MS,
    STATE_TTL_MS,
    authConfig,
    getSessionEmail,
    isAllowedEmail,
    isSecureRequest,
    parseCookies,
    requestBaseUrl,
    signSession
} = require('../utils/auth');

function registerAuthRoutes(app, deps = {}) {
    const APP_SECRET = deps.APP_SECRET;
    // No-op unless the caller supplies one — keeps this module usable standalone.
    const oauthLimiter = deps.oauthLimiter || ((_req, _res, next) => next());
    const cfg = authConfig();
    if (cfg.enabled && !cfg.sessionSecret) {
        console.warn('[auth] Google sign-in is enabled but no SESSION_SECRET / APP_SECRET is set — sessions cannot be signed. Set SESSION_SECRET.');
    }
    if (cfg.enabled && !process.env.OAUTH_BASE_URL) {
        // Both legs of the handshake derive redirect_uri from the request. If they
        // ever resolve differently — a proxy that sets x-forwarded-host on one leg
        // and not the other — Google rejects the token exchange with an error of its
        // own, which surfaces here as a generic failure with no obvious cause.
        console.warn('[auth] Google sign-in is enabled but OAUTH_BASE_URL is not set — redirect_uri will be derived from request headers, which is proxy-dependent. Set OAUTH_BASE_URL to the public origin.');
    }

    // Public: lets the frontend render the correct login UI (google | secret | open).
    app.get('/api/auth-config', (_req, res) => {
        const c = authConfig();
        res.json({ mode: c.enabled ? 'google' : (APP_SECRET ? 'secret' : 'open'), googleEnabled: c.enabled });
    });

    // Session probe used by the frontend to decide whether to show the login overlay.
    app.get('/api/me', (req, res) => {
        const email = getSessionEmail(req);
        if (!email) return res.status(401).json({ error: 'Not signed in' });
        res.json({ email });
    });

    app.get('/auth/google', oauthLimiter, (req, res) => {
        const c = authConfig();
        if (!c.enabled) return res.status(404).send('Google sign-in is not configured.');
        const redirectUri = `${requestBaseUrl(req)}/auth/google/callback`;
        const state = crypto.randomBytes(16).toString('hex');
        res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: isSecureRequest(req), sameSite: 'lax', maxAge: STATE_TTL_MS, path: '/' });
        const client = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri });
        res.redirect(client.generateAuthUrl({ scope: ['openid', 'email', 'profile'], state, prompt: 'select_account' }));
    });

    // Rate-limited because it is the one unauthenticated route that makes an
    // outbound call on our credentials: anyone can fetch /auth/google to obtain a
    // state cookie, then replay /auth/google/callback with junk codes, and each
    // attempt spends a real request against our Google token endpoint quota.
    app.get('/auth/google/callback', oauthLimiter, async (req, res) => {
        const c = authConfig();
        if (!c.enabled) return res.status(404).send('Google sign-in is not configured.');
        if (!c.sessionSecret) {
            // Without a signing secret signSession produces a token verifySession
            // will always reject, so the writer would complete the whole Google
            // handshake, be handed a cookie, and land back on a login screen with
            // no indication why. Fail here, where the cause is knowable.
            console.error('[auth] callback refused: Google sign-in is enabled but SESSION_SECRET / APP_SECRET is unset, so sessions cannot be signed.');
            // A distinct code, not `error`: this is a server misconfiguration the
            // writer cannot fix by trying again, and telling them to retry would
            // send them round the loop forever.
            return res.redirect('/?auth=misconfigured');
        }
        try {
            const { code, state } = req.query;
            const cookieState = parseCookies(req)[STATE_COOKIE];
            res.clearCookie(STATE_COOKIE, { path: '/' });
            if (!code || !state || !cookieState || String(state) !== cookieState) {
                return res.redirect('/?auth=error');
            }
            const redirectUri = `${requestBaseUrl(req)}/auth/google/callback`;
            const client = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri });
            const { tokens } = await client.getToken(String(code));
            const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: c.clientId });
            const payload = ticket.getPayload() || {};
            const email = String(payload.email || '').toLowerCase();
            if (!payload.email_verified || !isAllowedEmail(email)) {
                return res.redirect('/?auth=denied');
            }
            const token = signSession(email, c.sessionSecret);
            res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: isSecureRequest(req), sameSite: 'lax', maxAge: SESSION_TTL_MS, path: '/' });
            res.redirect('/');
        } catch (err) {
            console.error('[auth] google callback error:', err.message);
            res.redirect('/?auth=error');
        }
    });

    app.post('/auth/logout', (req, res) => {
        res.clearCookie(SESSION_COOKIE, { path: '/' });
        res.json({ ok: true });
    });
}

module.exports = { registerAuthRoutes };
