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

async function withEnvAsync(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) {
        saved[k] = process.env[k];
        if (vars[k] === undefined) delete process.env[k];
        else process.env[k] = vars[k];
    }
    try {
        return await fn();
    } finally {
        for (const k of Object.keys(vars)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

function captureAuthRoutes({ appSecret = '' } = {}) {
    const routes = {};
    const app = {
        get(path, handler) { routes[`GET ${path}`] = handler; },
        post(path, handler) { routes[`POST ${path}`] = handler; }
    };
    auth.registerAuthRoutes(app, { APP_SECRET: appSecret });
    return routes;
}

function mockReq({ headers = {}, query = {}, secure = false } = {}) {
    return { headers, query, secure };
}

function mockRes() {
    const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; },
        redirect(location) { this.statusCode = 302; this.headers.location = location; return this; },
        cookie(name, value, options = {}) {
            const parts = [`${name}=${value}`];
            if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
            if (options.path) parts.push(`Path=${options.path}`);
            if (options.httpOnly) parts.push('HttpOnly');
            if (options.secure) parts.push('Secure');
            if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
            this.headers['set-cookie'] = [...(this.headers['set-cookie'] || []), parts.join('; ')];
            return this;
        },
        clearCookie(name, options = {}) {
            const parts = [`${name}=`, 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
            if (options.path) parts.push(`Path=${options.path}`);
            this.headers['set-cookie'] = [...(this.headers['set-cookie'] || []), parts.join('; ')];
            return this;
        }
    };
    return res;
}

async function invoke(handler, reqOptions = {}) {
    const res = mockRes();
    await handler(mockReq(reqOptions), res);
    return res;
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

test('getSessionEmail treats malformed percent-encoded cookies as unauthenticated', () => {
    withEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_EMAILS: 'writer@example.com', SESSION_SECRET: SECRET }, () => {
        const req = { headers: { cookie: 'pageone_session=%E0%A4%A' } };
        assert.doesNotThrow(() => auth.getSessionEmail(req));
        assert.strictEqual(auth.getSessionEmail(req), null);
    });
});

// ─── Auth route integration smoke tests ──────────────────────────────────────

test('/api/auth-config reflects open, secret, and google modes', async () => {
    await withEnvAsync({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ALLOWED_EMAILS: '', SESSION_SECRET: '' }, async () => {
        const openRoutes = captureAuthRoutes();
        assert.deepStrictEqual((await invoke(openRoutes['GET /api/auth-config'])).body, { mode: 'open', googleEnabled: false });

        const secretRoutes = captureAuthRoutes({ appSecret: 'break-glass' });
        assert.deepStrictEqual((await invoke(secretRoutes['GET /api/auth-config'])).body, { mode: 'secret', googleEnabled: false });
    });

    await withEnvAsync({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_EMAILS: 'writer@example.com', SESSION_SECRET: SECRET }, async () => {
        const googleRoutes = captureAuthRoutes({ appSecret: 'break-glass' });
        assert.deepStrictEqual((await invoke(googleRoutes['GET /api/auth-config'])).body, { mode: 'google', googleEnabled: true });
    });
});

test('/api/me rejects missing sessions and accepts a signed allowlisted session', async () => {
    await withEnvAsync({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_EMAILS: 'writer@example.com', SESSION_SECRET: SECRET }, async () => {
        const token = auth.signSession('writer@example.com', SECRET);
        const routes = captureAuthRoutes();

        const missing = await invoke(routes['GET /api/me']);
        assert.strictEqual(missing.statusCode, 401);

        const signed = await invoke(routes['GET /api/me'], { headers: { cookie: `pageone_session=${token}` } });
        assert.strictEqual(signed.statusCode, 200);
        assert.deepStrictEqual(signed.body, { email: 'writer@example.com' });
    });
});

test('/auth/google/callback rejects a state-cookie mismatch before token exchange', async () => {
    await withEnvAsync({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_EMAILS: 'writer@example.com', SESSION_SECRET: SECRET }, async () => {
        const routes = captureAuthRoutes();
        const res = await invoke(routes['GET /auth/google/callback'], {
            headers: { cookie: 'pageone_oauth_state=from-cookie' },
            query: { code: 'fake-code', state: 'from-query' }
        });
        assert.strictEqual(res.statusCode, 302);
        assert.strictEqual(res.headers.location, '/?auth=error');
        assert.match((res.headers['set-cookie'] || []).join('\n'), /pageone_oauth_state=/);
    });
});

test('/auth/logout clears the session cookie', async () => {
    const routes = captureAuthRoutes();
    const res = await invoke(routes['POST /auth/logout']);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    const setCookie = (res.headers['set-cookie'] || []).join('\n');
    assert.match(setCookie, /pageone_session=/);
    assert.match(setCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
});
