const { test } = require('node:test');
const assert = require('node:assert');

const auth = require('../utils/auth');

const SECRET = 'test-session-secret';

// ─── Stateless session token ─────────────────────────────────────────────────

test('signSession → verifySession round-trips the email', () => {
    const token = auth.signSession('writer@example.com', SECRET);
    assert.strictEqual(auth.verifySession(token, SECRET), 'writer@example.com');
});

test('verifySession rejects a tampered payload', () => {
    const token = auth.signSession('writer@example.com', SECRET);
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'attacker@evil.com', exp: Date.now() + 1e9 })).toString('base64url') + '.' + sig;
    assert.strictEqual(auth.verifySession(forged, SECRET), null);
});

test('verifySession rejects a token signed with a different secret', () => {
    const token = auth.signSession('writer@example.com', SECRET);
    assert.strictEqual(auth.verifySession(token, 'other-secret'), null);
});

test('verifySession rejects an expired token', () => {
    // Hand-build an already-expired payload with a valid signature.
    const crypto = require('node:crypto');
    const payload = Buffer.from(JSON.stringify({ email: 'writer@example.com', exp: Date.now() - 1000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest().toString('base64url');
    assert.strictEqual(auth.verifySession(`${payload}.${sig}`, SECRET), null);
});

test('verifySession rejects malformed input', () => {
    assert.strictEqual(auth.verifySession('', SECRET), null);
    assert.strictEqual(auth.verifySession('no-dot', SECRET), null);
    assert.strictEqual(auth.verifySession('a.b.c', SECRET), null);
    assert.strictEqual(auth.verifySession(auth.signSession('x@y.com', SECRET), ''), null);
});

// ─── Config + allowlist (env-driven) ─────────────────────────────────────────

function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return fn(); } finally {
        for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
}

test('isGoogleAuthEnabled requires client id, secret, AND allowlist', () => {
    withEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ALLOWED_EMAILS: '' }, () => {
        assert.strictEqual(auth.isGoogleAuthEnabled(), false);
    });
    withEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_EMAILS: '' }, () => {
        assert.strictEqual(auth.isGoogleAuthEnabled(), false); // no allowlist
    });
    withEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_EMAILS: 'a@b.com' }, () => {
        assert.strictEqual(auth.isGoogleAuthEnabled(), true);
    });
});

test('isAllowedEmail is case-insensitive and trims', () => {
    withEnv({ ALLOWED_EMAILS: 'Writer@Example.com , other@x.com' }, () => {
        assert.strictEqual(auth.isAllowedEmail('writer@example.com'), true);
        assert.strictEqual(auth.isAllowedEmail('  WRITER@EXAMPLE.COM '), true);
        assert.strictEqual(auth.isAllowedEmail('nope@example.com'), false);
        assert.strictEqual(auth.isAllowedEmail(''), false);
    });
});

test('getSessionEmail returns null when Google auth is disabled', () => {
    withEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ALLOWED_EMAILS: '' }, () => {
        const token = auth.signSession('writer@example.com', SECRET);
        const req = { headers: { cookie: `pageone_session=${token}` } };
        assert.strictEqual(auth.getSessionEmail(req), null);
    });
});

test('getSessionEmail accepts a valid cookie for an allowlisted email', () => {
    withEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_EMAILS: 'writer@example.com', SESSION_SECRET: SECRET }, () => {
        const token = auth.signSession('writer@example.com', SECRET);
        const req = { headers: { cookie: `foo=bar; pageone_session=${token}` } };
        assert.strictEqual(auth.getSessionEmail(req), 'writer@example.com');
    });
});

test('getSessionEmail rejects a valid cookie once the email leaves the allowlist', () => {
    const token = withEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_EMAILS: 'writer@example.com', SESSION_SECRET: SECRET }, () => {
        return auth.signSession('writer@example.com', SECRET);
    });
    // Same signed cookie, but the allowlist no longer contains the email.
    withEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_EMAILS: 'someone-else@example.com', SESSION_SECRET: SECRET }, () => {
        const req = { headers: { cookie: `pageone_session=${token}` } };
        assert.strictEqual(auth.getSessionEmail(req), null);
    });
});
