const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// "Send a copy" — handoff by COPY, never by link or transfer (Carsten's rule for
// styles, 2026-08-16, applied to projects on 2026-09-26). Guard breaks: spend
// copied along → test 1 · copy written under the sender → the write fails the
// creation chokepoint (test 1) · style pointer left at the sender's private style
// → test 1 · non-owner read not through the chokepoint → the 404 test · session
// check dropped → the token test · allowlist check dropped → the recipient test.

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

async function withServer(run, env = {}) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    try {
        await server.module.initDb(); // bundled styles, as prod seeds them
        return await run(server);
    } finally {
        await server.close();
    }
}

const onDisk = (dataRoot, id) => JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${id}.json`), 'utf-8'));

function seedStyle(dataRoot, { slug, owner, withReference = false }) {
    const dir = path.join(dataRoot, 'styles');
    fs.mkdirSync(dir, { recursive: true });
    const text = (tier, body) => `---\nname: "${slug}"\nslug: "${slug}"\ncreated: "2026-09-01"\ntier: "${tier}"\nowner: "${owner}"\n${withReference ? `paired_with: "${slug}-${tier === 'trained' ? 'directive' : 'reference'}"\n` : ''}---\n\n## Voice\n${body}\n`;
    fs.writeFileSync(path.join(dir, `${slug}-directive.md`), text(withReference ? 'trained' : 'conversational', 'Short sentences.'));
    if (withReference) fs.writeFileSync(path.join(dir, `${slug}-reference.md`), text('trained', 'Reference analysis.'));
}

async function createProject(request, email, data, title = 'COLD VECTOR') {
    const res = await request('/api/projects', { method: 'POST', cookies: as(email) });
    assert.equal(res.status, 201, res.text);
    const put = await request(`/api/projects/${res.json.id}`, { method: 'PUT', cookies: as(email), json: { title, author: 'C. K.', data } });
    assert.equal(put.status, 200, put.text);
    return res.json.id;
}

test('the recipient gets an independent copy: owned by them, spend excluded, history and sources kept, private style copied along', async () => {
    await withServer(async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, withReference: true });
        const id = await createProject(request, ALICE, {
            stage1_pitch: { pitch: { title: 'COLD VECTOR', logline: 'A deputy plays the tape.' } },
            stage2_outline: { title: 'COLD VECTOR', outline: { act1: [], act2: [], act3: [] }, protected_beats: ['Finale'] },
            stage7_style: 'alice-noir',
            apiUsage: [{ model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 500, at: 1 }],
            versionHistory: [{ id: 'v1', stage: 1, note: 'first pitch' }]
        });
        const sourceDir = path.join(dataRoot, 'source-files', id, 'src_1');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'novel.txt'), 'Chapter one.');
        const originalBefore = JSON.stringify(onDisk(dataRoot, id));

        const res = await request(`/api/projects/${id}/send-copy`, { method: 'POST', cookies: as(ALICE), json: { email: BOB } });
        assert.equal(res.status, 201, res.text);
        assert.equal(res.json.recipient, BOB);
        assert.equal(res.json.title, 'COLD VECTOR');
        assert.equal(res.json.styleCopied.from, 'alice-noir');
        assert.equal(res.json.sourceFilesCopied, true);
        const copyId = res.json.id;
        assert.notEqual(copyId, id);

        // Bob sees it and can open it; Alice's list does not contain the copy.
        const bobList = (await request('/api/projects', { cookies: as(BOB) })).json.projects;
        assert.ok(bobList.some(p => String(p.id) === String(copyId) && p.title === 'COLD VECTOR'), JSON.stringify(bobList));
        const bobOpens = await request(`/api/projects/${copyId}`, { cookies: as(BOB) });
        assert.equal(bobOpens.status, 200);
        const aliceList = (await request('/api/projects', { cookies: as(ALICE) })).json.projects;
        assert.equal(aliceList.some(p => String(p.id) === String(copyId)), false, 'the copy belongs to Bob, not to Alice');
        assert.equal((await request(`/api/projects/${copyId}`, { cookies: as(ALICE) })).status, 404, 'Alice cannot even see that Bob\'s copy exists');

        const copy = onDisk(dataRoot, copyId);
        assert.equal(copy.owner, BOB);
        assert.equal(copy.copied_from.id, String(id));
        assert.equal(copy.copied_from.owner, ALICE);
        assert.equal(copy.author, 'C. K.');
        assert.equal(copy.data.stage1_pitch.pitch.logline, 'A deputy plays the tape.');
        assert.deepEqual(copy.data.stage2_outline.protected_beats, ['Finale']);
        assert.equal('apiUsage' in copy.data, false, 'the sender\'s spend is the sender\'s — the recipient\'s budget starts clean');
        // The setup PUT derives Stage 4 beats and appends its own version entry; the seeded one must travel.
        assert.ok(copy.data.versionHistory.some(v => v.id === 'v1' && v.note === 'first pitch'), 'version history travels with the copy');
        assert.deepEqual(copy.data.versionHistory, onDisk(dataRoot, id).data.versionHistory, 'identical history to the original');
        assert.notEqual(copy.data.stage7_style, 'alice-noir', 'the copy must not point at Alice\'s private style');
        assert.equal(copy.data.stage7_style, res.json.styleCopied.to);

        // The style copy is Bob's, with both files; Alice's is untouched.
        const styleDir = path.join(dataRoot, 'styles');
        const bobDirective = fs.readFileSync(path.join(styleDir, `${copy.data.stage7_style}-directive.md`), 'utf-8');
        assert.match(bobDirective, new RegExp(`owner: "${BOB}"`));
        assert.match(bobDirective, /copied_from: "alice-noir"/);
        assert.ok(fs.existsSync(path.join(styleDir, `${copy.data.stage7_style}-reference.md`)), 'a trained style brings its reference');
        assert.match(fs.readFileSync(path.join(styleDir, 'alice-noir-directive.md'), 'utf-8'), new RegExp(`owner: "${ALICE}"`));
        const bobStyles = (await request('/api/styles', { cookies: as(BOB) })).json.styles.map(s => s.slug);
        assert.ok(bobStyles.includes(copy.data.stage7_style));
        assert.equal(bobStyles.includes('alice-noir'), false);

        // Uploaded sources travelled under the new id; the original directory is still there.
        assert.equal(fs.readFileSync(path.join(dataRoot, 'source-files', copyId, 'src_1', 'novel.txt'), 'utf-8'), 'Chapter one.');
        assert.ok(fs.existsSync(path.join(sourceDir, 'novel.txt')));

        // The original is byte-identical to before the send.
        assert.equal(JSON.stringify(onDisk(dataRoot, id)), originalBefore);
    });
});

test('a bundled style keeps its slug — it is shared library, not the sender\'s file', async () => {
    await withServer(async ({ request, dataRoot }) => {
        const id = await createProject(request, ALICE, { stage7_style: 'clean-studio-adventure' });
        const res = await request(`/api/projects/${id}/send-copy`, { method: 'POST', cookies: as(ALICE), json: { email: BOB } });
        assert.equal(res.status, 201, res.text);
        assert.equal(res.json.styleCopied, null);
        assert.equal(onDisk(dataRoot, res.json.id).data.stage7_style, 'clean-studio-adventure');
    });
});

test('refusals: yourself, a stranger, someone else\'s project, a token, and an open server', async () => {
    await withServer(async ({ request }) => {
        const id = await createProject(request, ALICE, {});
        const self = await request(`/api/projects/${id}/send-copy`, { method: 'POST', cookies: as(ALICE), json: { email: ALICE } });
        assert.equal(self.status, 400, self.text);
        const stranger = await request(`/api/projects/${id}/send-copy`, { method: 'POST', cookies: as(ALICE), json: { email: 'carol@example.com' } });
        assert.equal(stranger.status, 400, stranger.text);
        assert.match(stranger.json.error, /allowlist/);
        const empty = await request(`/api/projects/${id}/send-copy`, { method: 'POST', cookies: as(ALICE), json: {} });
        assert.equal(empty.status, 400);
        const bob = await request(`/api/projects/${id}/send-copy`, { method: 'POST', cookies: as(BOB), json: { email: ALICE } });
        assert.equal(bob.status, 404, 'a non-owner cannot tell the project exists, let alone send it');

        const minted = await request('/api/tokens', { method: 'POST', cookies: as(ALICE), json: { name: 'script' } });
        const viaToken = await request(`/api/projects/${id}/send-copy`, { method: 'POST', headers: { Authorization: `Bearer ${minted.json.token}` }, json: { email: BOB } });
        assert.equal(viaToken.status, 401, 'a token must not be able to scatter its owner\'s work into other libraries');

        const bobList = (await request('/api/projects', { cookies: as(BOB) })).json.projects;
        assert.equal(bobList.length, 0, 'none of the refusals created anything');
    });

    // Open server: no identities, nobody to send to.
    const open = await startTestServer({ env: {} });
    try {
        const res = await open.request('/api/projects', { method: 'POST' });
        const send = await open.request(`/api/projects/${res.json.id}/send-copy`, { method: 'POST', json: { email: BOB } });
        assert.equal(send.status, 400, send.text);
    } finally {
        await open.close();
    }
});
