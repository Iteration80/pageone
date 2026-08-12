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

/**
 * The deployment owner: the FIRST address in ALLOWED_EMAILS.
 *
 * ⚠️ PROVISIONAL, and deliberately the smallest rule that works. Multi-user Phase 2
 * needed *some* admin distinction immediately, because the /api/maintenance/* routes
 * read and write across every tenant's projects and were behind plain requireAuth —
 * i.e. any allowlisted tester could sweep everyone's data. Ordering the env var is a
 * weak way to express "who runs this deployment", but it needs no new config, no
 * migration, and no data. Phase 4 (admin surface) replaces this with a real admin
 * list; when it does, this function is the single place to change.
 */
function isAdminEmail(email) {
    const [first] = config().allowed;
    if (!first || !email) return false;
    return String(email).trim().toLowerCase() === first;
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

module.exports = {
    // Cookie names and lifetimes — shared with routes/auth.js.
    SESSION_COOKIE,
    STATE_COOKIE,
    SESSION_TTL_MS,
    STATE_TTL_MS,

    // Auth decisions. Everything that determines whether a request is
    // authenticated lives here; routes/auth.js only wires these to URLs.
    authConfig: config,
    isGoogleAuthEnabled,
    getSessionEmail,
    isAllowedEmail,
    isAdminEmail,
    isSecureRequest,
    parseCookies,
    requestBaseUrl,
    signSession,
    verifySession,

    _config: config, // legacy alias used by test/auth.test.js
};
