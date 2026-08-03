const { test } = require('node:test');
const assert = require('node:assert');

const { startTestServer, cookieIsCleared } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// Route-level coverage for the auth surface, closing item 1 of
// specs/codex-handoff-post-auth-audit-2026-07-08.md: "No automated test exercises the
// actual Express routes as wired through registerAuthRoutes — my testing of those was
// manual curl, not a committed test."
//
// test/auth.test.js already covers the session primitives in isolation. What this file
// adds is the wiring: that the routes exist, that requireAuth is actually in front of
// the protected ones, and that a real HTTP request behaves the way the curl session did.

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'writer@example.com, Second@Example.com',
    SESSION_SECRET: 'test-session-secret',
    // Pinning the public origin is what production does, and it makes redirect_uri
    // assertable instead of dependent on whatever Host the test client sent.
    OAUTH_BASE_URL: 'https://pageone.test'
};

async function withServer(env, run) {
    const server = await startTestServer({ env });
    try {
        return await run(server);
    } finally {
        await server.close();
    }
}

// ─── /api/auth-config: the frontend renders its login UI from this ───────────────
// A wrong answer here is the 2026-06-11 lockout shape: overlay offering a login
// method the backend does not accept.

test('auth-config reports open mode when nothing is configured', async () => {
    await withServer({}, async ({ request }) => {
        const res = await request('/api/auth-config');
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, { mode: 'open', googleEnabled: false });
    });
});

test('auth-config reports secret mode when only APP_SECRET is set', async () => {
    await withServer({ APP_SECRET: 'break-glass' }, async ({ request }) => {
        assert.deepEqual((await request('/api/auth-config')).json, { mode: 'secret', googleEnabled: false });
    });
});

test('auth-config reports google mode when all three Google vars are set', async () => {
    await withServer({ ...GOOGLE_ENV, APP_SECRET: 'break-glass' }, async ({ request }) => {
        assert.deepEqual((await request('/api/auth-config')).json, { mode: 'google', googleEnabled: true });
    });
});

test('google mode needs all three vars — two is still secret mode', async () => {
    const partial = { GOOGLE_CLIENT_ID: GOOGLE_ENV.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: GOOGLE_ENV.GOOGLE_CLIENT_SECRET, APP_SECRET: 'break-glass' };
    await withServer(partial, async ({ request }) => {
        assert.equal((await request('/api/auth-config')).json.mode, 'secret');
    });
});

// ─── /api/me: the session probe ─────────────────────────────────────────────────

test('/api/me 401s with no cookie and 200s with a valid one', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        assert.equal((await request('/api/me')).status, 401);

        const token = signSession('writer@example.com', GOOGLE_ENV.SESSION_SECRET);
        const ok = await request('/api/me', { cookies: { pageone_session: token } });
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.json, { email: 'writer@example.com' });
    });
});

test('/api/me rejects a well-formed cookie signed with the wrong secret', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const forged = signSession('writer@example.com', 'not-the-session-secret');
        assert.equal((await request('/api/me', { cookies: { pageone_session: forged } })).status, 401);
    });
});

test('/api/me rejects a validly-signed cookie for an email no longer allowlisted', async () => {
    // Live revocation, at the route level. The unit test proves the function does it;
    // this proves nothing between the socket and the function undoes it.
    const token = signSession('removed@example.com', GOOGLE_ENV.SESSION_SECRET);
    await withServer({ ...GOOGLE_ENV, ALLOWED_EMAILS: 'removed@example.com' }, async ({ request }) => {
        assert.equal((await request('/api/me', { cookies: { pageone_session: token } })).status, 200);
    });
    await withServer(GOOGLE_ENV, async ({ request }) => {
        assert.equal((await request('/api/me', { cookies: { pageone_session: token } })).status, 401);
    });
});

test('the allowlist is case-insensitive over the wire', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const token = signSession('second@example.com', GOOGLE_ENV.SESSION_SECRET);
        assert.equal((await request('/api/me', { cookies: { pageone_session: token } })).status, 200);
    });
});

// ─── The OAuth handshake ────────────────────────────────────────────────────────

test('/auth/google redirects to Google and sets a state cookie', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const res = await request('/auth/google');
        assert.equal(res.status, 302);
        assert.match(res.location, /^https:\/\/accounts\.google\.com\//);
        assert.match(res.location, /client_id=test-client-id/);
        // Both legs of the handshake must derive the SAME redirect_uri or Google
        // rejects the exchange with an error of its own; OAUTH_BASE_URL pins it.
        assert.ok(
            res.location.includes(encodeURIComponent('https://pageone.test/auth/google/callback')),
            'redirect_uri was not derived from OAUTH_BASE_URL'
        );

        const state = res.cookies.pageone_oauth_state;
        assert.ok(state?.value, 'no state cookie was set');
        assert.ok(state.attributes.some(a => /^httponly$/i.test(a)), 'state cookie is not httpOnly');
        // An https OAUTH_BASE_URL settles `secure` even when the proxy sent no
        // x-forwarded-proto — the request here is plain http and it must still be set.
        assert.ok(state.attributes.some(a => /^secure$/i.test(a)), 'state cookie is not marked secure');
        // The state in the cookie must be the state sent to Google, or the CSRF
        // check compares two unrelated values and can never pass.
        assert.ok(res.location.includes(`state=${state.value}`), 'cookie state does not match the redirect state');
    });
});

test('the callback rejects a state mismatch without calling Google', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const res = await request('/auth/google/callback?code=abc&state=attacker-state', {
            cookies: { pageone_oauth_state: 'the-real-state' }
        });
        assert.equal(res.status, 302);
        assert.equal(res.location, '/?auth=error');
        assert.equal(res.cookies.pageone_session, undefined, 'a session cookie was issued on a failed CSRF check');
    });
});

test('the callback rejects a missing state cookie, and clears it either way', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const res = await request('/auth/google/callback?code=abc&state=whatever');
        assert.equal(res.location, '/?auth=error');
        assert.equal(res.cookies.pageone_session, undefined);
        // Single-use: the state cookie is expired on the response whatever the outcome,
        // so a captured state cannot be replayed from the same browser.
        assert.ok(cookieIsCleared(res.cookies.pageone_oauth_state), 'state cookie was not cleared');
    });
});

test('the callback rejects a missing code', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const res = await request('/auth/google/callback?state=s', { cookies: { pageone_oauth_state: 's' } });
        assert.equal(res.location, '/?auth=error');
    });
});

test('the callback refuses to run when sessions cannot be signed', async () => {
    // Google enabled with no SESSION_SECRET and no APP_SECRET: signSession would mint
    // a token verifySession always rejects, so the writer completes the whole Google
    // handshake and lands back on the login screen with no clue why.
    //
    // ⚠️ Asserting `/?auth=error` here would pass against the unfixed code too — a
    // bad code makes the exchange throw and the catch block redirects to the same
    // place. The distinct `misconfigured` code is what makes this test able to fail:
    // it is only reachable from the pre-flight check, before Google is contacted.
    const noSecret = { ...GOOGLE_ENV, SESSION_SECRET: '', APP_SECRET: '' };
    await withServer(noSecret, async ({ request }) => {
        const res = await request('/auth/google/callback?code=abc&state=s', { cookies: { pageone_oauth_state: 's' } });
        assert.equal(res.location, '/?auth=misconfigured');
        assert.equal(res.cookies.pageone_session, undefined);
    });
});

test('the OAuth routes are 404 when Google is not configured', async () => {
    await withServer({ APP_SECRET: 'break-glass' }, async ({ request }) => {
        assert.equal((await request('/auth/google')).status, 404);
        assert.equal((await request('/auth/google/callback?code=a&state=b')).status, 404);
    });
});

test('/auth/logout expires the session cookie', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const token = signSession('writer@example.com', GOOGLE_ENV.SESSION_SECRET);
        const res = await request('/auth/logout', { method: 'POST', cookies: { pageone_session: token } });
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, { ok: true });
        assert.ok(cookieIsCleared(res.cookies.pageone_session), 'logout did not expire the session cookie');
    });
});

// ─── requireAuth, as actually wired in front of the routes ──────────────────────

test('an open server serves protected routes freely', async () => {
    await withServer({}, async ({ request }) => {
        assert.equal((await request('/api/projects')).status, 200);
    });
});

test('secret mode: 401 without the header, 200 with it, on both header spellings', async () => {
    await withServer({ APP_SECRET: 'break-glass' }, async ({ request }) => {
        assert.equal((await request('/api/projects')).status, 401);
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': 'wrong' } })).status, 401);
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': 'break-glass' } })).status, 200);
        assert.equal((await request('/api/projects', { headers: { authorization: 'Bearer break-glass' } })).status, 200);
    });
});

test('google mode: a session cookie works, and APP_SECRET stays valid as break-glass', async () => {
    await withServer({ ...GOOGLE_ENV, APP_SECRET: 'break-glass' }, async ({ request }) => {
        assert.equal((await request('/api/projects')).status, 401);

        const token = signSession('writer@example.com', GOOGLE_ENV.SESSION_SECRET);
        assert.equal((await request('/api/projects', { cookies: { pageone_session: token } })).status, 200);
        // Deliberate: maintenance scripts and recovery access must survive a Google
        // misconfiguration.
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': 'break-glass' } })).status, 200);
    });
});

test('/health needs no credential in any mode', async () => {
    await withServer({ ...GOOGLE_ENV, APP_SECRET: 'break-glass' }, async ({ request }) => {
        const res = await request('/health');
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);
    });
});

// ─── Cookie parsing, over a real socket ─────────────────────────────────────────

test('a duplicate cookie name cannot shadow the real session', async () => {
    // A browser legitimately sends two cookies of the same name when one was set on a
    // broader domain or path; RFC 6265 puts the more specific one first. Last-wins let
    // the broader one shadow a valid session and sign the writer out of their own app.
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const token = signSession('writer@example.com', GOOGLE_ENV.SESSION_SECRET);
        const res = await request('/api/me', {
            headers: { cookie: `pageone_session=${token}; pageone_session=garbage` }
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.email, 'writer@example.com');
    });
});

test('a quoted cookie value still verifies', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const token = signSession('writer@example.com', GOOGLE_ENV.SESSION_SECRET);
        const res = await request('/api/me', { headers: { cookie: `pageone_session="${token}"` } });
        assert.equal(res.status, 200);
    });
});

test('malformed cookie headers are ignored rather than throwing', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        for (const cookie of ['pageone_session', '=novalue', ';;;', 'pageone_session=%E0%A4%A', 'a=1; ; b=2']) {
            const res = await request('/api/me', { headers: { cookie } });
            assert.equal(res.status, 401, `expected 401 for cookie header ${JSON.stringify(cookie)}`);
        }
    });
});
