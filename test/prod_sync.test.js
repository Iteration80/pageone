const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');
const { pullAll, pushOne, projectHash, readManifest, Refusal } = require('../scripts/lib/prod_sync');

// `npm run backup:prod` / `npm run push:prod` — the library behind both scripts,
// driven against a REAL harness server with real personal access tokens. No test
// here ever talks to prod.

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com', // Alice = bootstrap admin
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });

async function withServer(env, run) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pageone-backup-'));
    try { return await run({ ...server, dir }); } finally {
        await server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function mintToken(request, email) {
    const res = await request('/api/tokens', { method: 'POST', cookies: as(email), json: { name: 'backup' } });
    assert.equal(res.status, 201, res.text);
    return res.json.token;
}

async function createProject(request, email, title, data = {}) {
    const res = await request('/api/projects', { method: 'POST', cookies: as(email) });
    assert.equal(res.status, 201, res.text);
    const put = await request(`/api/projects/${res.json.id}`, { method: 'PUT', cookies: as(email), json: { title, data } });
    assert.equal(put.status, 200, put.text);
    return res.json.id;
}

const readLocal = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'latest', 'projects', `${id}.json`), 'utf-8'));
const readOnDisk = (dataRoot, id) => JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${id}.json`), 'utf-8'));

// ─── pull ───────────────────────────────────────────────────────────────────────

test('backup pulls the token owner’s projects into latest/ + manifest + a snapshot; an admin token pulls everyone’s; --mine narrows it', async () => {
    await withServer({}, async ({ request, origin, dir, dataRoot }) => {
        const a1 = await createProject(request, ALICE, 'Alice One', { stage1_pitch: { logline: 'A' } });
        const b1 = await createProject(request, BOB, 'Bob One', { stage1_pitch: { logline: 'B' } });
        const bobToken = await mintToken(request, BOB);
        const aliceToken = await mintToken(request, ALICE);

        // Bob: only his.
        const logs = [];
        const bob = await pullAll({ url: origin, token: bobToken, dir, log: m => logs.push(m) });
        assert.equal(bob.scope, 'mine');
        assert.equal(bob.by, BOB);
        assert.deepEqual(bob.added, [String(b1)]);
        assert.deepEqual(readLocal(dir, b1), readOnDisk(dataRoot, b1), 'the local copy must be byte-for-byte what prod holds');
        assert.ok(!fs.existsSync(path.join(dir, 'latest', 'projects', `${a1}.json`)), 'Bob must not receive Alice’s project');
        const m1 = await readManifest(dir);
        assert.equal(m1.projects[b1].sha256, projectHash(readOnDisk(dataRoot, b1)));
        assert.equal(m1.projects[b1].owner, BOB);
        assert.ok(bob.snapshotDir && fs.existsSync(path.join(bob.snapshotDir, 'projects', `${b1}.json`)), 'snapshot written');
        assert.match(logs[0], /Signed in as bob@example.com — pulling your projects/);

        // Alice (admin): everyone's — through the maintenance export.
        const alice = await pullAll({ url: origin, token: aliceToken, dir, snapshot: false });
        assert.equal(alice.scope, 'everyone');
        assert.deepEqual(alice.added.sort(), [String(a1)].sort(), 'Alice’s own is new to this dir; Bob’s was already mirrored');
        assert.deepEqual(alice.unchanged, [String(b1)]);
        assert.deepEqual(readLocal(dir, a1), readOnDisk(dataRoot, a1));
        assert.deepEqual(readLocal(dir, b1), readOnDisk(dataRoot, b1));

        // Alice --mine: her own only, and latest/ is a mirror — Bob's file goes (kept in the earlier snapshot).
        const mine = await pullAll({ url: origin, token: aliceToken, dir, mine: true, snapshot: false });
        assert.equal(mine.scope, 'mine');
        assert.deepEqual(mine.removed, [String(b1)]);
        assert.ok(!fs.existsSync(path.join(dir, 'latest', 'projects', `${b1}.json`)));
        assert.ok(fs.existsSync(path.join(bob.snapshotDir, 'projects', `${b1}.json`)), 'earlier snapshot still holds it');
        assert.equal((await readManifest(dir)).projects[b1], undefined);
    });
});

test('a non-admin token cannot reach the cross-tenant export, and a bad token is a clean 401', async () => {
    await withServer({}, async ({ request, origin, dir }) => {
        const bobToken = await mintToken(request, BOB);
        assert.equal((await request('/api/maintenance/projects', { headers: { authorization: `Bearer ${bobToken}` } })).status, 403);
        await assert.rejects(pullAll({ url: origin, token: 'pgo_notreal', dir }), err => err.name === 'RemoteError' && err.status === 401);
    });
});

// ─── push ───────────────────────────────────────────────────────────────────────

test('push uploads a locally edited project; refuses when prod changed since the last pull; --force overrides; identical → no-op', async () => {
    await withServer({}, async ({ request, origin, dir, dataRoot }) => {
        const id = await createProject(request, ALICE, 'Alice One', { stage1_pitch: { logline: 'v1' }, notes: 'keep' });
        const token = await mintToken(request, ALICE);
        await pullAll({ url: origin, token, dir, snapshot: false });

        // Nothing changed anywhere → no-op.
        const same = await pushOne({ url: origin, token, dir, projectId: id });
        assert.deepEqual(same, { pushed: false, code: 'UNCHANGED', projectId: String(id) });

        // Edit the local copy → push lands on prod.
        const localPath = path.join(dir, 'latest', 'projects', `${id}.json`);
        const local = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
        local.title = 'Alice One (restored)';
        local.data.stage1_pitch = { logline: 'v2 from backup' };
        fs.writeFileSync(localPath, JSON.stringify(local, null, 2));
        const pushed = await pushOne({ url: origin, token, dir, projectId: id });
        assert.equal(pushed.pushed, true);
        const onDisk = readOnDisk(dataRoot, id);
        assert.equal(onDisk.title, 'Alice One (restored)');
        assert.equal(onDisk.data.stage1_pitch.logline, 'v2 from backup');
        assert.equal(onDisk.data.notes, 'keep', 'shallow merge keeps keys the push did not send');
        assert.equal(onDisk.owner, ALICE, 'owner is server-pinned');
        // And the manifest now describes prod's new state, so a second push is a no-op.
        assert.equal((await readManifest(dir)).projects[id].sha256, projectHash(onDisk));
        assert.equal((await pushOne({ url: origin, token, dir, projectId: id })).code, 'UNCHANGED');

        // Prod moves on (someone edits in the browser) → local edit is REFUSED.
        const drift = await request(`/api/projects/${id}`, { method: 'PUT', cookies: as(ALICE), json: { data: { stage1_pitch: { logline: 'v3 edited on prod' } } } });
        assert.equal(drift.status, 200);
        local.data.stage1_pitch = { logline: 'v2b local again' };
        fs.writeFileSync(localPath, JSON.stringify(local, null, 2));
        await assert.rejects(pushOne({ url: origin, token, dir, projectId: id }), err => err instanceof Refusal && err.code === 'CHANGED_ON_REMOTE');
        assert.equal(readOnDisk(dataRoot, id).data.stage1_pitch.logline, 'v3 edited on prod', 'a refusal must not write');

        // --force overwrites.
        const forced = await pushOne({ url: origin, token, dir, projectId: id, force: true });
        assert.equal(forced.pushed, true);
        assert.equal(readOnDisk(dataRoot, id).data.stage1_pitch.logline, 'v2b local again');
    });
});

test('push refuses what it cannot vouch for: never-pulled ids, missing local files, id mismatches, and projects prod does not have for this token', async () => {
    await withServer({}, async ({ request, origin, dir, dataRoot }) => {
        const aliceId = await createProject(request, ALICE, 'Alice One');
        const bobId = await createProject(request, BOB, 'Bob One');
        const token = await mintToken(request, ALICE);

        // Never pulled → refuse; --force with a --file → allowed (push blind, explicitly).
        const file = path.join(dir, 'restore.json');
        fs.writeFileSync(file, JSON.stringify({ id: aliceId, title: 'From elsewhere', data: { x: 1 } }));
        await assert.rejects(pushOne({ url: origin, token, dir, projectId: aliceId, file }), err => err.code === 'NEVER_PULLED');
        const blind = await pushOne({ url: origin, token, dir, projectId: aliceId, file, force: true });
        assert.equal(blind.pushed, true);
        assert.equal(readOnDisk(dataRoot, aliceId).title, 'From elsewhere');

        // No local file at all.
        await assert.rejects(pushOne({ url: origin, token, dir, projectId: '1700000000009', force: true }), err => err.code === 'LOCAL_MISSING');

        // A file whose `id` is another project.
        fs.writeFileSync(file, JSON.stringify({ id: bobId, title: 'Wrong', data: {} }));
        await assert.rejects(pushOne({ url: origin, token, dir, projectId: aliceId, file, force: true }), err => err.code === 'ID_MISMATCH');

        // Bob's project: Alice's token cannot see it, so push refuses rather than creating anything.
        fs.writeFileSync(file, JSON.stringify({ id: bobId, title: 'Hijack', data: {} }));
        await assert.rejects(pushOne({ url: origin, token, dir, projectId: bobId, file, force: true }), err => err.code === 'NOT_ON_REMOTE');
        assert.equal(readOnDisk(dataRoot, bobId).title, 'Bob One');
        assert.equal(readOnDisk(dataRoot, bobId).owner, BOB);
    });
});

test('PUT /api/projects/:id cannot re-own or re-id a project (server-pinned provenance)', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        const id = await createProject(request, ALICE, 'Alice One');
        const res = await request(`/api/projects/${id}`, { method: 'PUT', cookies: as(ALICE), json: { owner: BOB, id: '1', title: 'Given away?' } });
        assert.equal(res.status, 200, res.text);
        const onDisk = readOnDisk(dataRoot, id);
        assert.equal(onDisk.owner, ALICE, 'owner must not change via PUT');
        assert.equal(onDisk.id, String(id), 'id must not change via PUT');
        assert.equal(onDisk.title, 'Given away?');
        // Bob still cannot see it, Alice still can.
        assert.equal((await request(`/api/projects/${id}`, { cookies: as(BOB) })).status, 404);
        assert.equal((await request(`/api/projects/${id}`, { cookies: as(ALICE) })).status, 200);
    });
});
