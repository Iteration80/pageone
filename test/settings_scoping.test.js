const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

/**
 * Phase 5 item 0 — settings are two layers, not one.
 *
 * Before this, `POST /api/settings` was plain `requireAuth` and `stageModels` lived
 * in ONE `data/settings.json`: any signed-in tester opening Settings and pressing
 * Save rewrote which model EVERY other writer's stages run on. Nothing logged it and
 * nothing failed; the only symptom would have been somebody else's Pitch quietly
 * changing model and cost.
 *
 * THE INSTRUMENT. `GET /api/settings.resolvedStageModels` is `resolveStageModel()`
 * — the exact function `getModelConfig()` calls — evaluated for the caller. So these
 * tests assert on the resolver's OUTPUT per identity rather than on a model call
 * happening, which the harness makes impossible anyway (it blanks the model keys on
 * purpose). The last test pins that the two share the resolver, so this instrument
 * cannot drift away from what actually runs.
 *
 * Guard-break signatures recorded in CLAUDE.md's Recent Changes entry.
 */

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com', // Alice first = bootstrap admin
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};
const ALICE = 'alice@example.com'; // admin
const BOB = 'bob@example.com';     // ordinary tester
const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });

async function withServer(env, run) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    try { return await run(server); } finally { await server.close(); }
}

const settingsFor = (request, email) => request('/api/settings', { cookies: as(email) });

async function setGlobal(request, email, stageModels) {
    return request('/api/settings', { method: 'POST', cookies: as(email), json: { stageModels } });
}

async function setMine(request, email, stageModels) {
    return request('/api/settings/my-models', { method: 'PUT', cookies: as(email), json: { stageModels } });
}

// ─── The bug this closes ──────────────────────────────────────────────────────

test('a tester cannot rewrite the deployment default models — and the attempt changes nothing', async () => {
    await withServer({}, async ({ request }) => {
        assert.equal((await setGlobal(request, ALICE, { stage1: 'gemini-3.6-flash' })).status, 200);

        const refused = await setGlobal(request, BOB, { stage1: 'claude-opus-5' });
        assert.equal(refused.status, 403, `Bob rewrote the deployment default (got ${refused.status})`);

        // Not merely refused at the door — the stored default is untouched, and
        // Alice, who never touched anything, still resolves to what she set.
        const alice = await settingsFor(request, ALICE);
        assert.equal(alice.json.globalStageModels.stage1, 'gemini-3.6-flash');
        assert.equal(alice.json.resolvedStageModels.stage1, 'gemini-3.6-flash');
    });
});

test("Bob's own model choice changes Bob's resolution and leaves Alice's alone", async () => {
    await withServer({}, async ({ request }) => {
        await setGlobal(request, ALICE, { stage1: 'gemini-3.6-flash', stage3: 'gemini-3.1-pro-preview' });

        const saved = await setMine(request, BOB, { stage1: 'claude-sonnet-5' });
        assert.equal(saved.status, 200, saved.text);
        assert.equal(saved.json.resolvedStageModels.stage1, 'claude-sonnet-5');

        const bob = await settingsFor(request, BOB);
        assert.equal(bob.json.myStageModels.stage1, 'claude-sonnet-5', "Bob's own choice should be stored");
        assert.equal(bob.json.resolvedStageModels.stage1, 'claude-sonnet-5');
        assert.equal(bob.json.resolvedStageModels.stage3, 'gemini-3.1-pro-preview',
            'a stage Bob never chose must still follow the deployment default');

        const alice = await settingsFor(request, ALICE);
        assert.equal(alice.json.resolvedStageModels.stage1, 'gemini-3.6-flash',
            "Bob's preference leaked into Alice's resolution");
        assert.deepEqual(alice.json.myStageModels, {}, 'Alice never chose anything of her own');
        assert.equal(alice.json.globalStageModels.stage1, 'gemini-3.6-flash',
            'the deployment default must survive a personal save');
    });
});

// ─── Sparse means sparse ──────────────────────────────────────────────────────

test('an inherited stage keeps following the default when the admin later changes it', async () => {
    await withServer({}, async ({ request }) => {
        await setGlobal(request, ALICE, { stage1: 'gemini-3.6-flash', stage8: 'gemini-3.6-flash' });
        await setMine(request, BOB, { stage1: 'claude-sonnet-5' }); // stage 8 left alone

        await setGlobal(request, ALICE, { stage1: 'gemini-3.6-flash', stage8: 'claude-opus-5' });

        const bob = await settingsFor(request, BOB);
        assert.equal(bob.json.resolvedStageModels.stage8, 'claude-opus-5',
            'an inherited stage must move with the default, not freeze at the value it had when Bob first saved');
        assert.equal(bob.json.resolvedStageModels.stage1, 'claude-sonnet-5',
            "Bob's explicit choice must NOT move with the default");
        assert.deepEqual(Object.keys(bob.json.myStageModels), ['stage1'],
            'only the stage Bob actually chose may be stored');
    });
});

test('clearing a stage back to the default removes the stored choice rather than storing an empty one', async () => {
    await withServer({}, async ({ request }) => {
        await setGlobal(request, ALICE, { stage1: 'gemini-3.6-flash' });
        await setMine(request, BOB, { stage1: 'claude-sonnet-5' });
        assert.equal((await settingsFor(request, BOB)).json.resolvedStageModels.stage1, 'claude-sonnet-5');

        const cleared = await setMine(request, BOB, { stage1: '' });
        assert.equal(cleared.status, 200, cleared.text);
        assert.deepEqual(cleared.json.myStageModels, {}, "'' means inherit — it must not be stored");
        assert.equal((await settingsFor(request, BOB)).json.resolvedStageModels.stage1, 'gemini-3.6-flash');
    });
});

// ─── The personal route cannot be aimed at anyone else ────────────────────────

test('PUT /api/settings/my-models writes only the caller, whatever the body claims', async () => {
    await withServer({}, async ({ request }) => {
        await setGlobal(request, ALICE, { stage1: 'gemini-3.6-flash' });

        const res = await request('/api/settings/my-models', {
            method: 'PUT',
            cookies: as(BOB),
            json: { email: ALICE, owner: ALICE, stageModels: { stage1: 'claude-opus-5' } }
        });
        assert.equal(res.status, 200, res.text);

        const alice = await settingsFor(request, ALICE);
        assert.deepEqual(alice.json.myStageModels, {}, 'Bob wrote a preference into Alice\'s row');
        assert.equal(alice.json.resolvedStageModels.stage1, 'gemini-3.6-flash');
        assert.equal((await settingsFor(request, BOB)).json.myStageModels.stage1, 'claude-opus-5');
    });
});

test('a junk stage key or a non-object map is refused, not half-stored', async () => {
    await withServer({}, async ({ request }) => {
        const bad = await request('/api/settings/my-models', {
            method: 'PUT', cookies: as(BOB), json: { stageModels: ['claude-opus-5'] }
        });
        assert.equal(bad.status, 400, bad.text);

        const junk = await setMine(request, BOB, { notAStage: 'claude-opus-5', stage2: 'claude-sonnet-5' });
        assert.equal(junk.status, 200, junk.text);
        assert.deepEqual(junk.json.myStageModels, { stage2: 'claude-sonnet-5' },
            'a key that is not stageN must be dropped, never passed through as a model id');
    });
});

// ─── Deployments without a signed-in person ───────────────────────────────────

test('break-glass and open dev keep the single global layer and are told so plainly', async () => {
    await withServer({ APP_SECRET: 'break-glass', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ALLOWED_EMAILS: '' },
        async ({ request }) => {
            const key = { 'x-api-key': 'break-glass' };
            const saved = await request('/api/settings', {
                method: 'POST', headers: key, json: { stageModels: { stage1: 'gemini-3.6-flash' } }
            });
            assert.equal(saved.status, 200, `break-glass must still be able to set the global layer (${saved.text})`);

            const view = await request('/api/settings', { headers: key });
            assert.equal(view.json.hasPersonalModels, false);
            assert.equal(view.json.canEditGlobalModels, true);
            assert.equal(view.json.resolvedStageModels.stage1, 'gemini-3.6-flash');

            const personal = await request('/api/settings/my-models', {
                method: 'PUT', headers: key, json: { stageModels: { stage1: 'claude-opus-5' } }
            });
            assert.equal(personal.status, 400, 'there is no person to store a preference for');
            assert.match(personal.json.error, /signed-in account/i);
        });
});

test('the settings view tells the client which layer it is editing', async () => {
    await withServer({}, async ({ request }) => {
        const alice = (await settingsFor(request, ALICE)).json;
        assert.equal(alice.hasPersonalModels, true);
        assert.equal(alice.canEditGlobalModels, true, 'Alice is the bootstrap admin');

        const bob = (await settingsFor(request, BOB)).json;
        assert.equal(bob.hasPersonalModels, true);
        assert.equal(bob.canEditGlobalModels, false, 'Bob must not be offered the deployment defaults');
    });
});

// ─── The instrument is the real resolver ──────────────────────────────────────

test('getModelConfig resolves through resolveStageModel and reads the caller from the async context', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    assert.match(serverJs, /function getModelConfig\(stageNum\)\s*\{[\s\S]*?resolveStageModel\(stageNum, currentUserEmail\(\)\)/,
        'getModelConfig must resolve through resolveStageModel with the async-context caller — '
        + 'if it reads appSettings.stageModels directly again, the personal layer is dead and '
        + 'resolvedStageModels stops describing what actually runs');
    assert.match(serverJs, /function resolveStageModel\(stageNum, email\)\s*\{[\s\S]*?userSettings\.getUserStageModel\(email, stageNum\)/,
        'resolveStageModel must consult the per-user store first');
});
