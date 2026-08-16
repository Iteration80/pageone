const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// Multi-user Phase 3, the two non-style pieces: rate limits keyed to the person,
// and the per-user spend rollup.

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com', // Alice first = admin
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });

async function withServer(env, run) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    try { return await run(server); } finally { await server.close(); }
}

async function createProject(request, email, title, apiUsage = []) {
    const res = await request('/api/projects', { method: 'POST', cookies: as(email) });
    assert.equal(res.status, 201, res.text);
    const put = await request(`/api/projects/${res.json.id}`, {
        method: 'PUT', cookies: as(email), json: { title, data: { apiUsage } }
    });
    assert.equal(put.status, 200, put.text);
    return res.json.id;
}

// ─── Rate limits ────────────────────────────────────────────────────────────────

test('the strict AI limiter is per person: one tester exhausting it does not throttle another on the same IP', async () => {
    // Every request in this file comes from 127.0.0.1 — the shared-NAT case by
    // construction. /api/generate-trained-style is strictLimiter (10/min) and
    // 400s without files, so it can be hammered without a model or an upload.
    await withServer({}, async ({ request }) => {
        const hit = email => request('/api/generate-trained-style', { method: 'POST', cookies: as(email), json: {} });

        let aliceStatuses = [];
        for (let i = 0; i < 11; i += 1) aliceStatuses.push((await hit(ALICE)).status);
        assert.deepEqual(aliceStatuses.slice(0, 10), Array(10).fill(400), 'the first ten should reach the route');
        assert.equal(aliceStatuses[10], 429, 'the eleventh should be rate limited');

        // Bob, same IP, same minute: still served.
        const bob = await hit(BOB);
        assert.equal(bob.status, 400, `Bob was throttled by Alice's requests (got ${bob.status})`);

        // And Alice stays limited — the buckets are separate, not merely reset.
        assert.equal((await hit(ALICE)).status, 429);
    });
});

test('with no identity (break-glass) the limiter falls back to the IP bucket', async () => {
    await withServer({ APP_SECRET: 'break-glass' }, async ({ request }) => {
        const key = { 'x-api-key': 'break-glass' };
        const statuses = [];
        for (let i = 0; i < 11; i += 1) {
            statuses.push((await request('/api/generate-trained-style', { method: 'POST', headers: key, json: {} })).status);
        }
        assert.equal(statuses[10], 429, 'break-glass must still be rate limited, by IP');
    });
});

// ─── Spend rollup ───────────────────────────────────────────────────────────────

const USE = (model, inputTokens, outputTokens) => ({ timestamp: 1, model, inputTokens, outputTokens });

test('GET /api/usage sums only the caller’s own projects, per model and per project', async () => {
    await withServer({}, async ({ request }) => {
        await createProject(request, ALICE, 'Alice One', [USE('gemini-3-flash-preview', 1000, 200), USE('claude-opus-5', 10, 5)]);
        await createProject(request, ALICE, 'Alice Two', [USE('gemini-3-flash-preview', 500, 100)]);
        await createProject(request, BOB, 'Bob One', [USE('gemini-3-flash-preview', 99999, 99999)]);

        const alice = await request('/api/usage', { cookies: as(ALICE) });
        assert.equal(alice.status, 200, alice.text);
        assert.equal(alice.json.owner, ALICE);
        assert.equal(alice.json.projects, 2);
        assert.equal(alice.json.calls, 3);
        assert.equal(alice.json.inputTokens, 1510);
        assert.equal(alice.json.outputTokens, 305);
        assert.deepEqual(alice.json.byModel['gemini-3-flash-preview'], { calls: 2, inputTokens: 1500, outputTokens: 300 });
        assert.deepEqual(alice.json.byModel['claude-opus-5'], { calls: 1, inputTokens: 10, outputTokens: 5 });
        assert.deepEqual(alice.json.byProject.map(p => p.title), ['Alice One', 'Alice Two']);
        assert.ok(!JSON.stringify(alice.json).includes('Bob'), 'Bob’s project leaked into Alice’s rollup');

        const bob = await request('/api/usage', { cookies: as(BOB) });
        assert.equal(bob.json.projects, 1);
        assert.equal(bob.json.inputTokens, 99999);
    });
});

test('the all-owners rollup is admin-only', async () => {
    await withServer({}, async ({ request }) => {
        await createProject(request, ALICE, 'Alice One', [USE('gemini-3-flash-preview', 10, 1)]);
        await createProject(request, BOB, 'Bob One', [USE('gemini-3-flash-preview', 20, 2)]);

        assert.equal((await request('/api/maintenance/usage', { cookies: as(BOB) })).status, 403);

        const admin = await request('/api/maintenance/usage', { cookies: as(ALICE) });
        assert.equal(admin.status, 200, admin.text);
        const owners = Object.fromEntries(admin.json.owners.map(o => [o.owner, o.inputTokens]));
        assert.deepEqual(owners, { [ALICE]: 10, [BOB]: 20 });
    });
});

test('on an open server /api/usage is the whole store', async () => {
    const open = { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ALLOWED_EMAILS: '', SESSION_SECRET: '' };
    await withServer(open, async ({ request, dataRoot }) => {
        fs.writeFileSync(path.join(dataRoot, 'projects', '1700000000001.json'),
            JSON.stringify({ id: '1700000000001', title: 'Local', data: { apiUsage: [USE('gemini-3-flash-preview', 7, 3)] } }));
        const res = await request('/api/usage');
        assert.equal(res.status, 200);
        assert.equal(res.json.owner, null);
        assert.equal(res.json.inputTokens, 7);
    });
});
