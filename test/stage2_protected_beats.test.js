const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// The Stage 2 shields (`data.stage2_outline.protected_beats`) have their own save
// route. Before it existed the toggle changed browser memory only, so on an
// approved project every shield vanished on refresh — found on prod 2026-09-22.
// Guard breaks: route removed → every test here fails with 404 · `_meta` not carried
// → test 1 · stampRevised added to the route → test 1 (stage 3 goes stale) ·
// normalizer dropped → test 2 · ownership check dropped → test 4.

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

const OUTLINE = {
    act1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening Image', description: 'Dawn.' }] }],
    act2: [],
    act3: [{ sequence_number_and_title: 'Sequence H', beats: [
        { beat_label: 'Break into Three', description: 'She chooses.' },
        { beat_label: 'Finale', description: 'The tape plays.' },
        { beat_label: "Final Image", description: 'Dusk.' }
    ] }]
};

async function withServer(run) {
    const server = await startTestServer({ env: GOOGLE_ENV });
    try { return await run(server); } finally { await server.close(); }
}

const readOnDisk = (dataRoot, id) => JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${id}.json`), 'utf-8'));

// Seeded on disk, not through `PUT /api/projects/:id`: that PUT stamps a fresh
// outline as a revision (Stage 3 → stale) before this route ever runs, which would
// make the "must not go stale" assertion below vacuous.
async function createApprovedProject(request, email, dataRoot) {
    const res = await request('/api/projects', { method: 'POST', cookies: as(email) });
    assert.equal(res.status, 201, res.text);
    const id = res.json.id;
    const file = path.join(dataRoot, 'projects', `${id}.json`);
    const project = JSON.parse(fs.readFileSync(file, 'utf-8'));
    project.data = {
        ...(project.data || {}),
        stage2_outline: { title: 'T', outline: OUTLINE, protected_beats: [], _meta: { generated_at: 1000, manually_revised_at: null, stale: false } },
        stage3_characters: { characters: [{ name: 'Mira' }], _meta: { generated_at: 2000, manually_revised_at: null, stale: false } }
    };
    fs.writeFileSync(file, JSON.stringify(project, null, 2));
    const check = readOnDisk(dataRoot, id);
    assert.equal(check.data.stage3_characters._meta.stale, false, 'precondition: Stage 3 starts fresh');
    return id;
}

test('a shield is persisted on its own: outline and _meta untouched, Stage 3 not stale, no version snapshot', async () => {
    await withServer(async ({ request, dataRoot }) => {
        const id = await createApprovedProject(request, ALICE, dataRoot);
        const before = readOnDisk(dataRoot, id);
        const versionsBefore = (before.data.versionHistory || []).length;

        const res = await request(`/api/projects/${id}/stage2-protected-beats`, {
            method: 'PUT',
            cookies: as(ALICE),
            json: { protected_beats: ['Break into Three', 'Finale', 'Final Image'] }
        });
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(res.json, { success: true, protected_beats: ['Break into Three', 'Finale', 'Final Image'] });

        const after = readOnDisk(dataRoot, id);
        assert.deepEqual(after.data.stage2_outline.protected_beats, ['Break into Three', 'Finale', 'Final Image']);
        assert.deepEqual(after.data.stage2_outline.outline, before.data.stage2_outline.outline, 'the outline must not change');
        assert.deepEqual(after.data.stage2_outline._meta, before.data.stage2_outline._meta, 'stage 2 provenance must be carried forward, not re-stamped');
        assert.equal(after.data.stage3_characters._meta.stale, false, 'a shield is not a revision — downstream must not go stale');
        assert.deepEqual(after.data.stage3_characters, before.data.stage3_characters);
        assert.equal((after.data.versionHistory || []).length, versionsBefore, 'a shield click must not snapshot a version');

        // A refresh reads the shields back — the whole point.
        const reloaded = await request(`/api/projects/${id}`, { cookies: as(ALICE) });
        assert.deepEqual(reloaded.json.data.stage2_outline.protected_beats, ['Break into Three', 'Finale', 'Final Image']);

        // Un-shielding is the same call with the label removed.
        const off = await request(`/api/projects/${id}/stage2-protected-beats`, { method: 'PUT', cookies: as(ALICE), json: { protected_beats: ['Finale'] } });
        assert.equal(off.status, 200);
        assert.deepEqual(readOnDisk(dataRoot, id).data.stage2_outline.protected_beats, ['Finale']);
    });
});

test('labels are normalized the way the generator reads them: trimmed, de-duplicated, objects accepted; non-arrays refused', async () => {
    await withServer(async ({ request, dataRoot }) => {
        const id = await createApprovedProject(request, ALICE, dataRoot);
        const res = await request(`/api/projects/${id}/stage2-protected-beats`, {
            method: 'PUT',
            cookies: as(ALICE),
            json: { protected_beats: ['  Finale ', 'finale', { label: 'Final Image' }, '', null] }
        });
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(readOnDisk(dataRoot, id).data.stage2_outline.protected_beats, ['Finale', 'Final Image']);

        for (const bad of [{ protected_beats: 'Finale' }, { protected_beats: null }, {}]) {
            const refused = await request(`/api/projects/${id}/stage2-protected-beats`, { method: 'PUT', cookies: as(ALICE), json: bad });
            assert.equal(refused.status, 400, `expected 400 for ${JSON.stringify(bad)}, got ${refused.status}: ${refused.text}`);
        }
        assert.deepEqual(readOnDisk(dataRoot, id).data.stage2_outline.protected_beats, ['Finale', 'Final Image'], 'a refusal must not write');
    });
});

test('a project with no Stage 2 outline refuses the shield with 400 and writes nothing', async () => {
    await withServer(async ({ request, dataRoot }) => {
        const res = await request('/api/projects', { method: 'POST', cookies: as(ALICE) });
        const id = res.json.id;
        const before = JSON.stringify(readOnDisk(dataRoot, id));
        const refused = await request(`/api/projects/${id}/stage2-protected-beats`, { method: 'PUT', cookies: as(ALICE), json: { protected_beats: ['Finale'] } });
        assert.equal(refused.status, 400, refused.text);
        assert.equal(JSON.stringify(readOnDisk(dataRoot, id)), before);
    });
});

test('the shield route is tenant-scoped like every other project write: another owner gets 404, never a write', async () => {
    await withServer(async ({ request, dataRoot }) => {
        const id = await createApprovedProject(request, ALICE, dataRoot);
        const res = await request(`/api/projects/${id}/stage2-protected-beats`, { method: 'PUT', cookies: as(BOB), json: { protected_beats: ['Finale'] } });
        assert.equal(res.status, 404, res.text);
        assert.deepEqual(readOnDisk(dataRoot, id).data.stage2_outline.protected_beats, []);
        const anon = await request(`/api/projects/${id}/stage2-protected-beats`, { method: 'PUT', json: { protected_beats: ['Finale'] } });
        assert.equal(anon.status, 401, anon.text);
    });
});
