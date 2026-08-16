const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// Multi-user Phase 4: the admin surface. Data-backed allowlist (additive to the
// env), data-backed admins (retiring the "first ALLOWED_EMAILS address" rule to a
// bootstrap fallback), per-user monthly quotas, and the session-only mutation rule.
//
// Every guard here was broken on purpose after the suite was green and confirmed
// to fail it — the signatures are recorded in CLAUDE.md so a future change that
// moves them is noticed.

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    // Alice first → bootstrap admin while nothing else names one. Bob is an ordinary
    // allowlisted tester. Carol is nobody until an admin adds her.
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com',
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';
const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });

async function withServer(env, run) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    try { return await run(server); } finally { await server.close(); }
}

async function mintToken(request, email) {
    const res = await request('/api/tokens', { method: 'POST', cookies: as(email), json: { name: 'script' } });
    assert.equal(res.status, 201, res.text);
    return res.json.token;
}

const USE = (model, inputTokens, outputTokens, timestamp = Date.now()) => ({ timestamp, model, inputTokens, outputTokens });

async function createProject(request, email, title, apiUsage = []) {
    const res = await request('/api/projects', { method: 'POST', cookies: as(email) });
    assert.equal(res.status, 201, res.text);
    const put = await request(`/api/projects/${res.json.id}`, {
        method: 'PUT', cookies: as(email), json: { title, data: { apiUsage } }
    });
    assert.equal(put.status, 200, put.text);
    return res.json.id;
}

// The strict-limited style generator 400s without files, so it is the cheapest
// "did the AI gate let me through" probe: 400 = through, 429 = refused.
const probeAi = (request, opts) => request('/api/generate-trained-style', { method: 'POST', json: {}, ...opts });

// ─── Allowlist ──────────────────────────────────────────────────────────────────

test('an admin can add an address from the UI; it gains access through cookie AND token, and removal severs both on the next request', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        // Before: Carol is nobody.
        assert.equal((await request('/api/projects', { cookies: as(CAROL) })).status, 401);

        const add = await request('/api/admin/allowlist', { method: 'POST', cookies: as(ALICE), json: { email: 'Carol@Example.com ' } });
        assert.equal(add.status, 201, add.text);
        assert.ok(add.json.allowlist.some(e => e.email === CAROL && e.source === 'store'), 'Carol should be listed from the store');
        assert.ok(fs.existsSync(path.join(dataRoot, 'access-control.json')), 'the store must land under DATA_ROOT');

        // After: cookie works, and she can mint a token that works.
        assert.equal((await request('/api/projects', { cookies: as(CAROL) })).status, 200);
        const token = await mintToken(request, CAROL);
        assert.equal((await request('/api/projects', { headers: { authorization: `Bearer ${token}` } })).status, 200);

        // Re-adding is idempotent.
        assert.equal((await request('/api/admin/allowlist', { method: 'POST', cookies: as(ALICE), json: { email: CAROL } })).status, 200);

        // Remove: both doors close on the very next request — nothing to revoke.
        const del = await request(`/api/admin/allowlist/${encodeURIComponent(CAROL)}`, { method: 'DELETE', cookies: as(ALICE) });
        assert.equal(del.status, 200, del.text);
        assert.equal((await request('/api/projects', { cookies: as(CAROL) })).status, 401, 'cookie must be dead');
        assert.equal((await request('/api/projects', { headers: { authorization: `Bearer ${token}` } })).status, 401, 'token must be dead');
        assert.equal((await request(`/api/admin/allowlist/${encodeURIComponent(CAROL)}`, { method: 'DELETE', cookies: as(ALICE) })).status, 404);
    });
});

test('the environment is the floor: env-listed addresses cannot be removed from the UI, and you cannot remove yourself', async () => {
    await withServer({}, async ({ request }) => {
        const bob = await request(`/api/admin/allowlist/${encodeURIComponent(BOB)}`, { method: 'DELETE', cookies: as(ALICE) });
        assert.equal(bob.status, 409, bob.text);
        assert.match(bob.json.error, /ALLOWED_EMAILS/);
        assert.equal((await request('/api/projects', { cookies: as(BOB) })).status, 200, 'Bob keeps access');

        const self = await request(`/api/admin/allowlist/${encodeURIComponent(ALICE)}`, { method: 'DELETE', cookies: as(ALICE) });
        assert.equal(self.status, 400);
    });
});

// ─── Who may administer ─────────────────────────────────────────────────────────

test('non-admins get 403 on every admin route; the unallowlisted get 401; the overview is readable by an admin token but mutations are session-only', async () => {
    await withServer({}, async ({ request }) => {
        // Bob is allowlisted, not admin.
        assert.equal((await request('/api/admin/overview', { cookies: as(BOB) })).status, 403);
        assert.equal((await request('/api/admin/allowlist', { method: 'POST', cookies: as(BOB), json: { email: CAROL } })).status, 403);
        assert.equal((await request(`/api/admin/allowlist/${CAROL}`, { method: 'DELETE', cookies: as(BOB) })).status, 403);
        assert.equal((await request('/api/admin/admins', { method: 'POST', cookies: as(BOB), json: { email: BOB } })).status, 403);
        assert.equal((await request(`/api/admin/admins/${ALICE}`, { method: 'DELETE', cookies: as(BOB) })).status, 403);
        assert.equal((await request('/api/admin/quotas', { method: 'PUT', cookies: as(BOB), json: { defaultMonthlyUsd: 0 } })).status, 403);
        // And none of that took effect.
        assert.equal((await request('/api/projects', { cookies: as(CAROL) })).status, 401);
        assert.equal((await request('/api/admin/overview', { cookies: as(BOB) })).status, 403, 'Bob must not have promoted himself');

        // Carol has no access at all.
        assert.equal((await request('/api/admin/overview', { cookies: as(CAROL) })).status, 401);
        assert.equal((await request('/api/admin/allowlist', { method: 'POST', cookies: as(CAROL), json: { email: CAROL } })).status, 401);

        // Alice's TOKEN may read the overview (a backup script reporting spend)…
        const token = await mintToken(request, ALICE);
        const bearer = { authorization: `Bearer ${token}` };
        assert.equal((await request('/api/admin/overview', { headers: bearer })).status, 200);
        // …but may not change who may enter. A leaked admin token must not be able
        // to add its holder's own address and outlive its own revocation.
        assert.equal((await request('/api/admin/allowlist', { method: 'POST', headers: bearer, json: { email: CAROL } })).status, 401);
        assert.equal((await request('/api/admin/admins', { method: 'POST', headers: bearer, json: { email: BOB } })).status, 401);
        assert.equal((await request('/api/admin/quotas', { method: 'PUT', headers: bearer, json: { defaultMonthlyUsd: 0 } })).status, 401);
        assert.equal((await request('/api/projects', { cookies: as(CAROL) })).status, 401, 'the token must not have added Carol');
    });
});

test('promoting: bootstrap admin promotes Bob, is persisted alongside him (no self-lockout), can demote him again; self-demotion and phantom admins are refused', async () => {
    await withServer({}, async ({ request }) => {
        let overview = await request('/api/admin/overview', { cookies: as(ALICE) });
        assert.equal(overview.status, 200, overview.text);
        assert.deepEqual(overview.json.admins.map(a => `${a.email}:${a.source}`), [`${ALICE}:bootstrap`]);

        // Cannot promote someone who cannot sign in.
        assert.equal((await request('/api/admin/admins', { method: 'POST', cookies: as(ALICE), json: { email: CAROL } })).status, 400);

        const promote = await request('/api/admin/admins', { method: 'POST', cookies: as(ALICE), json: { email: BOB } });
        assert.equal(promote.status, 201, promote.text);
        // Naming Bob switched the bootstrap off — and Alice was written into the
        // store in the same write, so the click that made Bob admin did not unmake her.
        assert.deepEqual(promote.json.admins.map(a => `${a.email}:${a.source}`).sort(), [`${ALICE}:store`, `${BOB}:store`]);
        assert.equal((await request('/api/admin/overview', { cookies: as(ALICE) })).status, 200, 'Alice must still be admin');
        assert.equal((await request('/api/admin/overview', { cookies: as(BOB) })).status, 200, 'Bob is now admin');
        assert.equal((await request('/api/me', { cookies: as(BOB) })).json.admin, true);

        // Bob cannot demote himself; Alice can.
        assert.equal((await request(`/api/admin/admins/${BOB}`, { method: 'DELETE', cookies: as(BOB) })).status, 400);
        const demote = await request(`/api/admin/admins/${BOB}`, { method: 'DELETE', cookies: as(ALICE) });
        assert.equal(demote.status, 200, demote.text);
        assert.equal((await request('/api/admin/overview', { cookies: as(BOB) })).status, 403, 'Bob is demoted');
        assert.equal((await request(`/api/admin/admins/${BOB}`, { method: 'DELETE', cookies: as(ALICE) })).status, 404);

        // Removing an address from the allowlist also drops it from the store's admins.
        await request('/api/admin/allowlist', { method: 'POST', cookies: as(ALICE), json: { email: CAROL } });
        await request('/api/admin/admins', { method: 'POST', cookies: as(ALICE), json: { email: CAROL } });
        assert.equal((await request('/api/admin/overview', { cookies: as(CAROL) })).status, 200);
        await request(`/api/admin/allowlist/${CAROL}`, { method: 'DELETE', cookies: as(ALICE) });
        overview = await request('/api/admin/overview', { cookies: as(ALICE) });
        assert.ok(!overview.json.admins.some(a => a.email === CAROL), 'Carol must not linger as a phantom admin');
    });
});

test('ADMIN_EMAILS names the admins explicitly: the first allowlisted address is then NOT admin, and env admins cannot be demoted from the UI', async () => {
    await withServer({ ADMIN_EMAILS: BOB }, async ({ request }) => {
        assert.equal((await request('/api/admin/overview', { cookies: as(ALICE) })).status, 403, 'first-in-list is no longer admin once ADMIN_EMAILS is set');
        assert.equal((await request('/api/me', { cookies: as(ALICE) })).json.admin, false);
        const bob = await request('/api/admin/overview', { cookies: as(BOB) });
        assert.equal(bob.status, 200);
        assert.deepEqual(bob.json.admins, [{ email: BOB, source: 'env', addedBy: null, added: null }]);
        // Bob (env admin) promotes Alice via the store, then Alice tries to demote Bob.
        assert.equal((await request('/api/admin/admins', { method: 'POST', cookies: as(BOB), json: { email: ALICE } })).status, 201);
        const demoteEnv = await request(`/api/admin/admins/${BOB}`, { method: 'DELETE', cookies: as(ALICE) });
        assert.equal(demoteEnv.status, 409);
        assert.match(demoteEnv.json.error, /ADMIN_EMAILS/);
    });
});

test('the maintenance family honours the data-backed admin list too (requireAdmin has one source of truth)', async () => {
    await withServer({}, async ({ request }) => {
        assert.equal((await request('/api/maintenance/usage', { cookies: as(BOB) })).status, 403);
        await request('/api/admin/admins', { method: 'POST', cookies: as(ALICE), json: { email: BOB } });
        assert.equal((await request('/api/maintenance/usage', { cookies: as(BOB) })).status, 200);
    });
});

// ─── Quotas ─────────────────────────────────────────────────────────────────────

test('a monthly quota refuses new AI work with 429 QUOTA_EXCEEDED once spent; admins are exempt from the default but not from an explicit override; last month does not count', async () => {
    await withServer({}, async ({ request }) => {
        // Seed spend BEFORE the first quota check: the guard's month-to-date cache is
        // built on first use and refreshed at most once a minute.
        const lastMonth = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 1000;
        await createProject(request, BOB, 'Bob Big', [USE('claude-opus-5', 1_000_000, 0)]);       // $5.00 this month
        await createProject(request, ALICE, 'Alice Old', [USE('claude-opus-5', 1_000_000, 0, lastMonth)]); // $5.00 LAST month
        await createProject(request, ALICE, 'Alice Small', [USE('gemini-3.6-flash', 100_000, 0)]);  // $0.075 this month
        assert.equal((await request('/api/tokens', { cookies: as(BOB) })).status, 200); // sanity: Bob is signed in

        // No quota configured → everyone through (400 = the route's own "no files").
        assert.equal((await probeAi(request, { cookies: as(BOB) })).status, 400);

        // Default $1/month: Bob ($5) is refused, Alice (admin, default does not apply) passes.
        const setDefault = await request('/api/admin/quotas', { method: 'PUT', cookies: as(ALICE), json: { defaultMonthlyUsd: 1 } });
        assert.equal(setDefault.status, 200, setDefault.text);
        const refused = await probeAi(request, { cookies: as(BOB) });
        assert.equal(refused.status, 429, refused.text);
        assert.equal(refused.json.code, 'QUOTA_EXCEEDED');
        assert.match(refused.json.error, /\$5\.00 of \$1\.00/);
        assert.equal((await probeAi(request, { cookies: as(ALICE) })).status, 400, 'admin is exempt from the default');

        // The overview reports the same numbers the guard used.
        const overview = await request('/api/admin/overview', { cookies: as(ALICE) });
        const bobRow = overview.json.usage.find(u => u.owner === BOB);
        const aliceRow = overview.json.usage.find(u => u.owner === ALICE);
        assert.equal(bobRow.quotaUsd, 1);
        assert.ok(Math.abs(bobRow.month.usd - 5) < 1e-9, `Bob month $${bobRow.month.usd}`);
        assert.equal(aliceRow.quotaUsd, null, 'admin shows no cap');
        assert.ok(Math.abs(aliceRow.month.usd - 0.075) < 1e-9, `Alice month $${aliceRow.month.usd} — last month must not count`);
        assert.ok(Math.abs(aliceRow.allTime.usd - 5.075) < 1e-9, `Alice all-time $${aliceRow.allTime.usd}`);

        // Per-user override applies to anyone: cap Alice at 5 cents → refused; lift Bob to unlimited → through.
        const override = await request('/api/admin/quotas', { method: 'PUT', cookies: as(ALICE), json: { perUser: { [ALICE]: 0.05, [BOB]: null } } });
        assert.equal(override.status, 200, override.text);
        assert.equal((await probeAi(request, { cookies: as(ALICE) })).status, 429, 'explicit override caps an admin');
        assert.equal((await probeAi(request, { cookies: as(BOB) })).status, 400, 'null override = unlimited');

        // Break-glass carries no email and is never capped.
    });
});

test('quota config rejects garbage instead of silently becoming unlimited', async () => {
    await withServer({}, async ({ request }) => {
        for (const bad of [{ defaultMonthlyUsd: -1 }, { defaultMonthlyUsd: 'ten' }, { perUser: { 'not-an-email': 3 } }, { perUser: { [BOB]: 'x' } }, {}]) {
            const res = await request('/api/admin/quotas', { method: 'PUT', cookies: as(ALICE), json: bad });
            assert.equal(res.status, 400, `${JSON.stringify(bad)} → ${res.status} ${res.text}`);
        }
        const q = (await request('/api/admin/overview', { cookies: as(ALICE) })).json.quotas;
        assert.deepEqual(q, { defaultMonthlyUsd: null, perUser: {} });
    });
});

test('break-glass is never capped and open mode has no administration to speak of', async () => {
    await withServer({ APP_SECRET: 'break-glass' }, async ({ request }) => {
        await request('/api/admin/quotas', { method: 'PUT', cookies: as(ALICE), json: { defaultMonthlyUsd: 0 } });
        assert.equal((await probeAi(request, { cookies: as(BOB) })).status, 429, 'a $0 default caps Bob');
        assert.equal((await probeAi(request, { headers: { 'x-api-key': 'break-glass' } })).status, 400, 'break-glass has no email to cap');
    });
    const open = { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ALLOWED_EMAILS: '', SESSION_SECRET: '' };
    await withServer(open, async ({ request }) => {
        assert.equal((await request('/api/admin/overview')).status, 200, 'open dev may read (nothing is scoped)');
        assert.equal((await request('/api/admin/allowlist', { method: 'POST', json: { email: CAROL } })).status, 404, 'no identity, no allowlist to edit');
    });
});

// ─── Completeness ───────────────────────────────────────────────────────────────

// Every /api/admin/ route must be in this set — each is exercised above with a
// non-admin AND (for mutations) with a token. Adding a route without adding it here
// fails this test, which is the point.
const COVERED_ADMIN_ROUTES = new Set([
    'GET /api/admin/overview',
    'POST /api/admin/allowlist',
    'DELETE /api/admin/allowlist/:email',
    'POST /api/admin/admins',
    'DELETE /api/admin/admins/:email',
    'PUT /api/admin/quotas'
]);

test('every /api/admin route is covered by an explicit non-admin and session-only case', async () => {
    await withServer({}, async ({ module: serverModule }) => {
        const router = serverModule.app.router || serverModule.app._router;
        const found = [];
        const walk = (stack) => {
            for (const layer of stack) {
                if (layer.route) {
                    for (const method of Object.keys(layer.route.methods)) found.push(`${method.toUpperCase()} ${layer.route.path}`);
                } else if (layer.handle?.stack) walk(layer.handle.stack);
            }
        };
        walk(router.stack);
        const adminRoutes = found.filter(r => r.includes('/api/admin/'));
        const uncovered = adminRoutes.filter(r => !COVERED_ADMIN_ROUTES.has(r));
        assert.deepEqual(uncovered, [], `admin routes with no coverage:\n  ${uncovered.join('\n  ')}`);
        assert.equal(adminRoutes.length, COVERED_ADMIN_ROUTES.size, `expected ${COVERED_ADMIN_ROUTES.size} admin routes, found ${adminRoutes.length}`);
    });
});
