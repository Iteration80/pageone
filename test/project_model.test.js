const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// One model per project (2026-09-26). `data.model` outranks the per-person and the
// deployment layers, and it reaches the ~30 getModelConfig() call sites through the
// same request context the ownership chokepoints use — no agent was edited. The
// instrument is `resolved` on the model routes: the SAME resolveStageModel() that
// getModelConfig() calls, evaluated inside a request that opened the project.
// Guard breaks: chokepoint no longer notes the model → test 1 (resolved ignores it) ·
// resolver order changed → test 1 · validation dropped → test 2 · a system read
// leaking the model → test 3.

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com',
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });
const STAGES = ['stage1', 'stage2', 'stage3', 'stage5', 'stage6', 'stage7', 'stage8', 'stage9', 'stage10'];

async function withServer(run) {
    const server = await startTestServer({ env: GOOGLE_ENV });
    try { return await run(server); } finally { await server.close(); }
}

async function createProject(request, email) {
    const res = await request('/api/projects', { method: 'POST', cookies: as(email) });
    assert.equal(res.status, 201, res.text);
    return res.json.id;
}

test('the project model outranks the personal and the deployment layers, for every stage, and clears back to them', async () => {
    await withServer(async ({ request, dataRoot }) => {
        const id = await createProject(request, ALICE);
        // Deployment default: one model everywhere. Alice's personal layer: Stage 2 on Sonnet.
        const setGlobal = await request('/api/settings', { method: 'POST', cookies: as(ALICE), json: { stageModels: Object.fromEntries(STAGES.map(k => [k, 'gemini-3.6-flash'])) } });
        assert.equal(setGlobal.status, 200, setGlobal.text);
        await request('/api/settings/my-models', { method: 'PUT', cookies: as(ALICE), json: { stageModels: { stage2: 'claude-sonnet-5' } } });

        const before = await request(`/api/projects/${id}/model`, { cookies: as(ALICE) });
        assert.equal(before.status, 200, before.text);
        assert.equal(before.json.model, '');
        assert.equal(before.json.resolved.stage1, 'gemini-3.6-flash');
        assert.equal(before.json.resolved.stage2, 'claude-sonnet-5', 'the personal layer still applies when the project has no pick');

        const set = await request(`/api/projects/${id}/model`, { method: 'PUT', cookies: as(ALICE), json: { model: 'claude-opus-5-5' } });
        assert.equal(set.status, 200, set.text);
        assert.equal(set.json.model, 'claude-opus-5-5');
        for (const k of STAGES) assert.equal(set.json.resolved[k], 'claude-opus-5-5', `${k} runs on the project's model`);
        const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${id}.json`), 'utf-8'));
        assert.equal(onDisk.data.model, 'claude-opus-5-5');

        // A fresh request that opens the project resolves the same way — the chokepoint carries it.
        const again = await request(`/api/projects/${id}/model`, { cookies: as(ALICE) });
        for (const k of STAGES) assert.equal(again.json.resolved[k], 'claude-opus-5-5');

        // Clearing returns to the layers below.
        const clear = await request(`/api/projects/${id}/model`, { method: 'PUT', cookies: as(ALICE), json: { model: '' } });
        assert.equal(clear.status, 200);
        assert.equal(clear.json.model, '');
        assert.equal(clear.json.resolved.stage1, 'gemini-3.6-flash');
        assert.equal(clear.json.resolved.stage2, 'claude-sonnet-5');
        assert.equal('model' in JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${id}.json`), 'utf-8')).data, false);
    });
});

test('only a registered, enabled model can be picked; a non-owner gets 404', async () => {
    await withServer(async ({ request }) => {
        const id = await createProject(request, ALICE);
        const unknown = await request(`/api/projects/${id}/model`, { method: 'PUT', cookies: as(ALICE), json: { model: 'kimi-k9' } });
        assert.equal(unknown.status, 400, unknown.text);
        const disabled = await request(`/api/projects/${id}/model`, { method: 'PUT', cookies: as(ALICE), json: { model: 'claude-opus-4-8' } });
        assert.equal(disabled.status, 400, disabled.text);
        assert.match(disabled.json.error, /disabled/);
        const bob = await request(`/api/projects/${id}/model`, { method: 'PUT', cookies: as(BOB), json: { model: 'claude-opus-5-5' } });
        assert.equal(bob.status, 404);
        assert.equal((await request(`/api/projects/${id}/model`, { cookies: as(BOB) })).status, 404);
    });
});

test('the model is request-scoped: the deployment view never sees any project\'s pick', async () => {
    await withServer(async ({ request }) => {
        const id = await createProject(request, ALICE);
        await request(`/api/projects/${id}/model`, { method: 'PUT', cookies: as(ALICE), json: { model: 'claude-opus-5-5' } });
        // GET /api/settings resolves per person without a project in context.
        const settings = await request('/api/settings', { cookies: as(ALICE) });
        assert.notEqual(settings.json.resolvedStageModels.stage1, 'claude-opus-5-5', 'a project pick must not leak into the settings resolution of a request that never opened it');
    });
});

test('the chokepoint is where the model is noted, and the resolver reads it first', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /function assertProjectAccess\(project, notFoundMessage = 'Project not found'\) \{\s*if \(callerMayAccessProject\(project\)\) return noteProjectModel\(project\);/);
    assert.match(server, /const chosen = currentProjectModel\(\)\s*\|\| userSettings\.getUserStageModel\(email, stageNum\)/);
});
