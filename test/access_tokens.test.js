const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// Route-level coverage for multi-user Phase 1 (personal access tokens).
//
// Every assertion here goes through a real HTTP request, because the thing being
// built is a NEW BRANCH IN requireAuth, and a source-string test cannot tell the
// difference between "the branch exists" and "the branch is reached". This project
// has paid for that distinction three times.
//
// The four claims that matter, in the order the handoff states them:
//   mint → use → revoke → 401, and allowlist removal kills a live token.

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'writer@example.com, second@example.com',
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};

const WRITER = 'writer@example.com';
const SECOND = 'second@example.com';

function sessionFor(email) {
    return { pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) };
}

async function withServer(env, run) {
    const server = await startTestServer({ env });
    try {
        return await run(server);
    } finally {
        await server.close();
    }
}

/**
 * A DATA_ROOT the caller owns, so a token minted by one boot is still on disk for
 * the next one. The harness's own throwaway root is per-boot by design; the
 * allowlist-revocation claim is specifically about a token that OUTLIVES a restart.
 */
async function withPersistentDataRoot(run) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pageone-tokens-'));
    fs.mkdirSync(path.join(dataRoot, 'projects'), { recursive: true });
    try {
        return await run(dataRoot);
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

async function mintToken(request, { email = WRITER, name = 'laptop backup script' } = {}) {
    const res = await request('/api/tokens', {
        method: 'POST',
        cookies: sessionFor(email),
        json: { name }
    });
    assert.equal(res.status, 201, `minting failed: ${res.text}`);
    assert.ok(res.json.token, 'no plaintext token in the create response');
    return res.json;
}

function readStore(dataRoot) {
    return JSON.parse(fs.readFileSync(path.join(dataRoot, 'access-tokens.json'), 'utf-8'));
}

// ─── The store keeps a hash, and only a hash ────────────────────────────────────

test('the minted plaintext is never written to disk; its hash is', async () => {
    await withPersistentDataRoot(async (dataRoot) => {
        await withServer({ ...GOOGLE_ENV, DATA_ROOT: dataRoot }, async ({ request }) => {
            const { token, id } = await mintToken(request);

            assert.ok(token.startsWith('pgo_'), `token has the wrong prefix: ${token.slice(0, 8)}`);

            // The whole file, not just the record — a plaintext copy anywhere in it
            // is the failure this design exists to prevent.
            const raw = fs.readFileSync(path.join(dataRoot, 'access-tokens.json'), 'utf-8');
            assert.ok(!raw.includes(token), 'the plaintext token was persisted');

            const record = readStore(dataRoot).tokens.find(t => t.id === id);
            const crypto = require('crypto');
            assert.equal(record.hash, crypto.createHash('sha256').update(token).digest('hex'));
            assert.equal(record.owner, WRITER);
        });
    });
});

test('listing returns metadata and never the hash', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        await mintToken(request, { name: 'backup' });
        const res = await request('/api/tokens', { cookies: sessionFor(WRITER) });
        assert.equal(res.status, 200);
        assert.equal(res.json.tokens.length, 1);
        const [entry] = res.json.tokens;
        assert.equal(entry.name, 'backup');
        assert.equal(entry.owner, WRITER);
        assert.equal(entry.lastUsed, null);
        assert.equal(entry.hash, undefined, 'the hash was exposed to the client');
        assert.equal(entry.token, undefined, 'a token value was exposed to the client');
    });
});

// ─── mint → use → revoke → 401 ──────────────────────────────────────────────────

test('a minted token authenticates a protected route, on both header spellings', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        // The negative first: without it, a passing positive proves only that the
        // route is reachable, not that the token is what made it reachable.
        assert.equal((await request('/api/projects')).status, 401);

        const { token } = await mintToken(request);

        assert.equal((await request('/api/projects', { headers: { authorization: `Bearer ${token}` } })).status, 200);
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 200);
    });
});

test('revoking a token kills it on the next request', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const { token, id } = await mintToken(request);
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 200);

        const del = await request(`/api/tokens/${id}`, { method: 'DELETE', cookies: sessionFor(WRITER) });
        assert.equal(del.status, 200);
        assert.deepEqual(del.json, { ok: true });

        assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 401);
        assert.equal((await request('/api/tokens', { cookies: sessionFor(WRITER) })).json.tokens.length, 0);
    });
});

test('a pgo_-shaped credential that was never minted is rejected', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const res = await request('/api/projects', { headers: { 'x-api-key': 'pgo_not-a-real-token' } });
        assert.equal(res.status, 401);
    });
});

test('using a token stamps lastUsed', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const { token } = await mintToken(request);
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 200);

        // The stamp is written outside the request's own response, so poll for it
        // rather than assuming it landed by the time the 200 came back.
        let entry;
        for (let attempt = 0; attempt < 20; attempt++) {
            entry = (await request('/api/tokens', { cookies: sessionFor(WRITER) })).json.tokens[0];
            if (entry.lastUsed) break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(entry.lastUsed, 'lastUsed was never stamped');
    });
});

// ─── Allowlist removal kills a live token ───────────────────────────────────────

test('removing the owner from ALLOWED_EMAILS kills their live token instantly', async () => {
    await withPersistentDataRoot(async (dataRoot) => {
        let token;

        // Boot 1: mint it and prove it works. Without this leg the second leg's 401
        // would be indistinguishable from "the token never worked in the first place".
        await withServer({ ...GOOGLE_ENV, DATA_ROOT: dataRoot }, async ({ request }) => {
            ({ token } = await mintToken(request));
            assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 200);
        });

        // Boot 2: same store, same token, owner no longer allowlisted. Nobody
        // revoked anything — the record is still sitting in the file.
        await withServer({ ...GOOGLE_ENV, ALLOWED_EMAILS: SECOND, DATA_ROOT: dataRoot }, async ({ request }) => {
            assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 401);
            assert.equal(readStore(dataRoot).tokens.length, 1, 'the record should still exist — the allowlist is what denied it');
        });

        // Boot 3: put the address back and the same token works again, which is what
        // proves the denial came from the allowlist check and not from a store that
        // got corrupted or emptied somewhere in between.
        await withServer({ ...GOOGLE_ENV, DATA_ROOT: dataRoot }, async ({ request }) => {
            assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 200);
        });
    });
});

test('an expired token is rejected', async () => {
    await withPersistentDataRoot(async (dataRoot) => {
        await withServer({ ...GOOGLE_ENV, DATA_ROOT: dataRoot }, async ({ request }) => {
            const { token } = await mintToken(request);
            assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 200);

            // Backdate the expiry only — the hash stays the real one, so what is
            // being tested is the expiry check and nothing else.
            const store = readStore(dataRoot);
            store.tokens[0].expires = new Date(Date.now() - 1000).toISOString();
            fs.writeFileSync(path.join(dataRoot, 'access-tokens.json'), JSON.stringify(store, null, 2));

            assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 401);
        });
    });
});

test('expiresInDays is honoured and validated', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const ok = await request('/api/tokens', {
            method: 'POST', cookies: sessionFor(WRITER), json: { name: 'ci', expiresInDays: 30 }
        });
        assert.equal(ok.status, 201);
        const days = (Date.parse(ok.json.expires) - Date.now()) / (24 * 60 * 60 * 1000);
        assert.ok(days > 29.9 && days < 30.1, `expiry landed at ${days} days`);

        for (const bad of [0, -5, 'soon']) {
            const res = await request('/api/tokens', {
                method: 'POST', cookies: sessionFor(WRITER), json: { name: 'x', expiresInDays: bad }
            });
            assert.equal(res.status, 400, `expiresInDays=${JSON.stringify(bad)} was accepted`);
        }
    });
});

// ─── Token management is session-only, and owner-scoped ─────────────────────────

test('a token cannot manage tokens — only a browser session can', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const { token, id } = await mintToken(request);

        // It authenticates the rest of the API...
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': token } })).status, 200);
        // ...and is refused at the token surface, on all three verbs. A stolen token
        // must not be able to mint its own successors or revoke the real ones.
        assert.equal((await request('/api/tokens', { headers: { 'x-api-key': token } })).status, 401);
        assert.equal((await request('/api/tokens', {
            method: 'POST', headers: { 'x-api-key': token }, json: { name: 'escalation' }
        })).status, 401);
        assert.equal((await request(`/api/tokens/${id}`, {
            method: 'DELETE', headers: { 'x-api-key': token }
        })).status, 401);

        // And nothing was created or destroyed by any of that.
        assert.equal((await request('/api/tokens', { cookies: sessionFor(WRITER) })).json.tokens.length, 1);
    });
});

test('the token surface needs a credential at all', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        assert.equal((await request('/api/tokens')).status, 401);
        assert.equal((await request('/api/tokens', { method: 'POST', json: { name: 'x' } })).status, 401);
    });
});

test('a session for an email no longer allowlisted cannot manage tokens', async () => {
    const stale = { pageone_session: signSession('removed@example.com', GOOGLE_ENV.SESSION_SECRET) };
    await withServer(GOOGLE_ENV, async ({ request }) => {
        assert.equal((await request('/api/tokens', { cookies: stale })).status, 401);
    });
});

test('tokens are listed and revoked per owner, never across owners', async () => {
    // The Phase 2 failure mode in miniature: serving or mutating one identity's data
    // for another, 200 OK. Proving it at the token surface now sets the shape.
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const mine = await mintToken(request, { email: WRITER, name: 'writer token' });
        await mintToken(request, { email: SECOND, name: 'second token' });

        const writerList = (await request('/api/tokens', { cookies: sessionFor(WRITER) })).json.tokens;
        assert.equal(writerList.length, 1);
        assert.equal(writerList[0].name, 'writer token');

        const secondList = (await request('/api/tokens', { cookies: sessionFor(SECOND) })).json.tokens;
        assert.equal(secondList.length, 1);
        assert.equal(secondList[0].name, 'second token');

        // Second tries to revoke Writer's token by id.
        const cross = await request(`/api/tokens/${mine.id}`, { method: 'DELETE', cookies: sessionFor(SECOND) });
        assert.equal(cross.status, 404);
        // The 404 has to mean "not deleted", not merely "not reported" — check the
        // credential still works, not just what the response said.
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': mine.token } })).status, 200);
    });
});

test('a token name is required', async () => {
    await withServer(GOOGLE_ENV, async ({ request }) => {
        const res = await request('/api/tokens', { method: 'POST', cookies: sessionFor(WRITER), json: {} });
        assert.equal(res.status, 400);
    });
});

// ─── The store never rewrites itself for nothing ────────────────────────────────

test('an updater that changes nothing does not rewrite the store', async () => {
    // Regression, 2026-08-11. `updateStore` used to write the whole file even when
    // the updater was a no-op, which gave every fire-and-forget `touchToken` a
    // lost-update window over any concurrent write. It showed up as a token that
    // was minted with a 201 and then failed to authenticate — the classic silent
    // success. Asserting on mtime, not just content: a byte-identical rewrite is
    // still a rewrite, and it is the rewrite that does the damage.
    await withPersistentDataRoot(async (dataRoot) => {
        const previous = process.env.DATA_ROOT;
        process.env.DATA_ROOT = dataRoot;
        delete require.cache[require.resolve('../utils/tokens')];
        const tokens = require('../utils/tokens');
        try {
            const { record } = await tokens.createToken({ name: 'race', owner: WRITER });
            const file = path.join(dataRoot, 'access-tokens.json');

            await tokens.touchToken(record.id);           // first stamp: a real write
            const afterFirst = fs.statSync(file).mtimeMs;
            assert.ok(readStore(dataRoot).tokens[0].lastUsed, 'the first touch should have stamped lastUsed');

            await new Promise(resolve => setTimeout(resolve, 20));
            await tokens.touchToken(record.id);           // throttled: must not write
            assert.equal(fs.statSync(file).mtimeMs, afterFirst, 'a throttled touch rewrote the store');

            await tokens.touchToken('an-id-that-is-not-here'); // the clobber path
            assert.equal(fs.statSync(file).mtimeMs, afterFirst, 'a touch for an unknown id rewrote the store');
            assert.equal(readStore(dataRoot).tokens.length, 1);
        } finally {
            if (previous === undefined) delete process.env.DATA_ROOT;
            else process.env.DATA_ROOT = previous;
            delete require.cache[require.resolve('../utils/tokens')];
        }
    });
});

// ─── Dormancy: the feature is absent unless Google auth is configured ───────────

test('the token routes are 404 when Google sign-in is not configured', async () => {
    await withServer({ APP_SECRET: 'break-glass' }, async ({ request }) => {
        assert.equal((await request('/api/tokens')).status, 404);
        assert.equal((await request('/api/tokens', { method: 'POST', json: { name: 'x' } })).status, 404);
    });
});

test('APP_SECRET break-glass still works alongside tokens', async () => {
    // The new branch sits between the cookie and APP_SECRET; a regression here would
    // lock maintenance scripts out of production.
    await withServer({ ...GOOGLE_ENV, APP_SECRET: 'break-glass' }, async ({ request }) => {
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': 'break-glass' } })).status, 200);
        assert.equal((await request('/api/projects', { headers: { authorization: 'Bearer break-glass' } })).status, 200);
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': 'wrong' } })).status, 401);
    });
});

test('an open server is not made stricter by the token branch', async () => {
    await withServer({}, async ({ request }) => {
        assert.equal((await request('/api/projects')).status, 200);
        assert.equal((await request('/api/projects', { headers: { 'x-api-key': 'pgo_whatever' } })).status, 200);
    });
});
