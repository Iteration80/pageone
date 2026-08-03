/**
 * utils/auth.js — Google OAuth sign-in + stateless session for PageOne.
 *
 * Design goals (see specs/pageone-roadmap-2026-07-03.md auth section):
 *  - DORMANT unless configured: Google auth is active only when GOOGLE_CLIENT_ID,
 *    GOOGLE_CLIENT_SECRET, and ALLOWED_EMAILS are all set. Until then the server
 *    behaves exactly as before (APP_SECRET, or fully open on localhost).
 *  - STATELESS SESSION: an HMAC-signed cookie (no session store), keyed on
 *    SESSION_SECRET (falls back to APP_SECRET). Survives redeploys and multiple
 *    instances with zero infra.
 *  - LIVE ALLOWLIST: the email allowlist is re-checked on every request, so
 *    removing an address from ALLOWED_EMAILS instantly revokes access even if the
 *    user still holds a valid, unexpired cookie.
 *  - BREAK-GLASS: APP_SECRET stays a valid credential (checked in requireAuth),
 *    so admin/CLI/maintenance access survives a Google misconfiguration.
 *
 * The OAuth handshake uses a plain server-side redirect (no Google JS SDK), so
 * the existing Content-Security-Policy needs no changes.
 */

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const SESSION_COOKIE = 'pageone_session';
const STATE_COOKIE = 'pageone_oauth_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STATE_TTL_MS = 10 * 60 * 1000;            // 10 minutes

// Read fresh each call so env changes (and tests) take effect without a restart.
function config() {
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
    const allowed = (process.env.ALLOWED_EMAILS || '')
        .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const enabled = Boolean(clientId && clientSecret && allowed.length);
    const sessionSecret = process.env.SESSION_SECRET || process.env.APP_SECRET || '';
    return { clientId, clientSecret, allowed, enabled, sessionSecret };
}

function isGoogleAuthEnabled() {
    return config().enabled;
}

function isAllowedEmail(email) {
    if (!email) return false;
    return config().allowed.includes(String(email).trim().toLowerCase());
}

// ─── Stateless signed session token: base64url(payload).base64url(HMAC) ────────

function b64url(input) {
    return Buffer.from(input).toString('base64url');
}

function signSession(email, secret) {
    const payload = b64url(JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS }));
    const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
    return `${payload}.${sig}`;
}

function verifySession(token, secret) {
    if (!token || !secret) return null;
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let data;
    try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!data || typeof data.email !== 'string') return null;
    if (!data.exp || Date.now() > data.exp) return null;
    return data.email;
}

/**
 * Hand-rolled cookie parsing, so the rules it follows are worth stating.
 *
 * FIRST occurrence of a name wins. A browser can legitimately send two cookies with
 * the same name — one set for `.example.com` and one for `app.example.com`, say —
 * and RFC 6265 orders the more specific path first. Taking the last would let a
 * cookie set on a broader scope shadow the right one. Forging a session that way is
 * not possible (the HMAC still has to verify), but it would knock a signed-in writer
 * out of their own session with no way to see why. Express's own cookie parser is
 * first-wins; matching it removes a difference nobody would think to look for.
 *
 * A quoted value (`name="abc"`, also legal per RFC 6265) has its quotes stripped —
 * otherwise the token verifies against a signature computed over different bytes.
 */
function parseCookies(req) {
    const raw = req.headers?.cookie || '';
    const out = {};
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        if (!k || Object.prototype.hasOwnProperty.call(out, k)) continue;
        let rawValue = part.slice(i + 1).trim();
        if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
            rawValue = rawValue.slice(1, -1);
        }
        try {
            out[k] = decodeURIComponent(rawValue);
        } catch {
            out[k] = rawValue;
        }
    }
    return out;
}

/** The authenticated AND still-allowlisted email for this request, or null. */
function getSessionEmail(req) {
    const cfg = config();
    if (!cfg.enabled) return null;
    const email = verifySession(parseCookies(req)[SESSION_COOKIE], cfg.sessionSecret);
    if (!email || !isAllowedEmail(email)) return null;
    return email;
}

function requestBaseUrl(req) {
    if (process.env.OAUTH_BASE_URL) return process.env.OAUTH_BASE_URL.replace(/\/+$/, '');
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
        || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

/**
 * Whether to mark cookies `secure`.
 *
 * `x-forwarded-proto` is the only signal behind a TLS-terminating proxy, and if it
 * is ever missing the session cookie would be issued without `secure` on an HTTPS
 * site. `OAUTH_BASE_URL` is the operator's own statement of the public origin, so
 * an https base URL settles it regardless of what the proxy did or didn't send.
 */
function isSecureRequest(req) {
    if ((process.env.OAUTH_BASE_URL || '').startsWith('https://')) return true;
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return proto === 'https' || Boolean(req.secure);
}

function registerAuthRoutes(app, deps = {}) {
    const APP_SECRET = deps.APP_SECRET;
    // No-op unless the caller supplies one — keeps this module usable standalone.
    const oauthLimiter = deps.oauthLimiter || ((_req, _res, next) => next());
    const cfg = config();
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
        const c = config();
        res.json({ mode: c.enabled ? 'google' : (APP_SECRET ? 'secret' : 'open'), googleEnabled: c.enabled });
    });

    // Session probe used by the frontend to decide whether to show the login overlay.
    app.get('/api/me', (req, res) => {
        const email = getSessionEmail(req);
        if (!email) return res.status(401).json({ error: 'Not signed in' });
        res.json({ email });
    });

    app.get('/auth/google', oauthLimiter, (req, res) => {
        const c = config();
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
        const c = config();
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

module.exports = {
    isGoogleAuthEnabled,
    getSessionEmail,
    isAllowedEmail,
    registerAuthRoutes,
    // exported for unit tests:
    signSession,
    verifySession,
    _config: config,
};
