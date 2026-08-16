const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// ⚠️ The harness evicts and re-requires the first-party module graph per server, so
// utils/request_identity.js — and its AsyncLocalStorage — is a fresh instance each
// time. Require it AFTER startTestServer (this returns the instance server.js is
// using); a top-level require would hand back a store the server never reads, and
// every "as Alice" call below would silently run as a system call.
function identityOf() {
    return require('../utils/request_identity');
}

// Multi-user Phase 3: shared vs private styles.
//
// Bundled styles (data/styles in the repo, seeded into DATA_ROOT/styles at startup)
// are the shared library — visible to everyone, editable by no one signed in.
// User-created styles carry `owner:` in their front matter and are visible to, and
// editable by, their creator only. Every case is proved in BOTH directions, as in
// project_ownership.test.js: the owner gets the real response and the other user is
// refused — a one-sided test cannot tell isolation from a broken route.
//
// Enforcement lives in utils/style_store.js; every route here is really being asked
// one question: does it reach the store?

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    // ⚠️ ALICE IS FIRST — the provisional admin rule (utils/auth.js isAdminEmail).
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com',
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });

// Two bundled slugs, chosen to exercise the discriminator: a preset, and a TRAINED
// style that ships in the bundle. Both must behave as shared library — the tier
// line is not what decides.
const BUNDLED_PRESET = 'clean-studio-adventure';
const BUNDLED_TRAINED = 'alex-garland';

async function withServer(env, run) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    try {
        // The harness boots without startServer(); seed the bundle the way prod does.
        await server.module.initDb();
        return await run(server);
    } finally {
        await server.close();
    }
}

function styleText({ name, slug, owner, tier = 'conversational', body = 'Short sentences. No adverbs.' }) {
    return `---\nname: "${name}"\nslug: "${slug}"\ncreated: "2026-08-16"\ntier: "${tier}"\n${owner ? `owner: "${owner}"\n` : ''}---\n\n## Voice\n${body}\n`;
}

/** Write a user-created style straight to disk (no model needed). */
function seedStyle(dataRoot, { slug, owner, name = slug, tier, withReference = false, body }) {
    const dir = path.join(dataRoot, 'styles');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}-directive.md`), styleText({ name, slug, owner, tier, body }));
    if (withReference) {
        fs.writeFileSync(path.join(dir, `${slug}-reference.md`), styleText({ name, slug, owner, tier: 'trained', body: 'Reference analysis.' }));
    }
}

function readStyleFile(dataRoot, file) {
    return fs.readFileSync(path.join(dataRoot, 'styles', file), 'utf-8');
}

function styleFileExists(dataRoot, file) {
    return fs.existsSync(path.join(dataRoot, 'styles', file));
}

async function createProject(request, email, title = 'Script') {
    const res = await request('/api/projects', { method: 'POST', cookies: as(email) });
    assert.equal(res.status, 201, `create failed for ${email}: ${res.text}`);
    if (title) {
        await request(`/api/projects/${res.json.id}`, { method: 'PUT', cookies: as(email), json: { title, data: {} } });
    }
    return res.json.id;
}

function projectOnDisk(dataRoot, id) {
    return JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${id}.json`), 'utf-8'));
}

// ─── Listing ────────────────────────────────────────────────────────────────────

test('the style list is the shared library plus your own — never the other user’s', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, name: 'Alice Noir' });
        seedStyle(dataRoot, { slug: 'bob-farce', owner: BOB, name: 'Bob Farce' });

        const aliceList = (await request('/api/styles', { cookies: as(ALICE) })).json.styles;
        const bobList = (await request('/api/styles', { cookies: as(BOB) })).json.styles;
        const slugs = list => list.map(s => s.slug);

        assert.ok(slugs(aliceList).includes('alice-noir'));
        assert.ok(!slugs(aliceList).includes('bob-farce'), 'Alice can see Bob’s style');
        assert.ok(slugs(bobList).includes('bob-farce'));
        assert.ok(!slugs(bobList).includes('alice-noir'), 'Bob can see Alice’s style');

        // The bundle is in both lists, whatever its tier line says.
        for (const list of [aliceList, bobList]) {
            assert.ok(slugs(list).includes(BUNDLED_PRESET), 'preset missing from the shared library');
            assert.ok(slugs(list).includes(BUNDLED_TRAINED), 'bundled trained style missing from the shared library');
        }

        // Flags the UI keys Edit/Delete off: bundled = read-only, own = editable.
        const preset = aliceList.find(s => s.slug === BUNDLED_PRESET);
        const trained = aliceList.find(s => s.slug === BUNDLED_TRAINED);
        const own = aliceList.find(s => s.slug === 'alice-noir');
        assert.deepEqual([preset.bundled, preset.editable], [true, false]);
        assert.deepEqual([trained.bundled, trained.editable], [true, false]);
        assert.deepEqual([own.bundled, own.editable], [false, true]);
    });
});

// ─── Read ───────────────────────────────────────────────────────────────────────

test('GET /api/styles/:slug serves the owner and 404s the other user; the bundle serves both', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, name: 'Alice Noir', withReference: true });

        const owner = await request('/api/styles/alice-noir', { cookies: as(ALICE) });
        assert.equal(owner.status, 200);
        assert.match(owner.json.directive, /Alice Noir/);
        assert.match(owner.json.reference, /Reference analysis/);
        assert.equal(owner.json.editable, true);

        const intruder = await request('/api/styles/alice-noir', { cookies: as(BOB) });
        assert.equal(intruder.status, 404);
        assert.ok(!/Alice Noir|Short sentences|Reference analysis/.test(intruder.text), 'the refusal leaked style content');

        for (const email of [ALICE, BOB]) {
            for (const slug of [BUNDLED_PRESET, BUNDLED_TRAINED]) {
                const shared = await request(`/api/styles/${slug}`, { cookies: as(email) });
                assert.equal(shared.status, 200, `${email} could not read bundled ${slug}`);
                assert.equal(shared.json.bundled, true);
                assert.equal(shared.json.editable, false);
            }
        }
    });
});

test('a style that does not exist looks the same as one you may not see', async () => {
    // Otherwise the status code is an existence oracle for private slugs.
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE });
        const notOwned = await request('/api/styles/alice-noir', { cookies: as(BOB) });
        const notThere = await request('/api/styles/no-such-style', { cookies: as(BOB) });
        assert.equal(notOwned.status, notThere.status);
        assert.deepEqual(notOwned.json, { ...notThere.json, error: notOwned.json.error });
        assert.match(notOwned.json.error, /not found/i);
        assert.match(notThere.json.error, /not found/i);
    });
});

// ─── Write ──────────────────────────────────────────────────────────────────────

test('PUT: the owner may edit; the other user gets 404; a bundled style is 403 for everyone', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, name: 'Alice Noir' });
        const before = readStyleFile(dataRoot, 'alice-noir-directive.md');

        const intruder = await request('/api/styles/alice-noir', {
            method: 'PUT', cookies: as(BOB), json: { content: '---\nname: "Hijacked"\n---\n\nBob was here.' }
        });
        assert.equal(intruder.status, 404);
        assert.equal(readStyleFile(dataRoot, 'alice-noir-directive.md'), before, 'a refused PUT changed the file');

        const owner = await request('/api/styles/alice-noir', {
            method: 'PUT', cookies: as(ALICE), json: { content: styleText({ name: 'Alice Noir v2', slug: 'alice-noir', owner: ALICE, body: 'Longer sentences now.' }) }
        });
        assert.equal(owner.status, 200, owner.text);
        assert.match(readStyleFile(dataRoot, 'alice-noir-directive.md'), /Longer sentences now/);

        for (const email of [ALICE, BOB]) {
            for (const slug of [BUNDLED_PRESET, BUNDLED_TRAINED]) {
                const bundledBefore = readStyleFile(dataRoot, `${slug}-directive.md`);
                const res = await request(`/api/styles/${slug}`, {
                    method: 'PUT', cookies: as(email), json: { content: '---\nname: "Vandalised"\n---\n\nnope' }
                });
                assert.equal(res.status, 403, `${email} PUT ${slug}: got ${res.status}`);
                assert.match(res.json.error, /shared library/i);
                assert.equal(readStyleFile(dataRoot, `${slug}-directive.md`), bundledBefore, `${slug} was modified by a refused PUT`);
            }
        }
    });
});

test('PUT cannot rename, disown or re-own a style — provenance is re-stamped from disk', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, name: 'Alice Noir' });

        // Alice tries (or a client bug tries on her behalf) to hand the style to Bob
        // and rename its slug in the front matter she sends back.
        const res = await request('/api/styles/alice-noir', {
            method: 'PUT', cookies: as(ALICE),
            json: { content: `---\nname: "Alice Noir"\nslug: "bob-noir"\nowner: "${BOB}"\ncreated: "1999-01-01"\n---\n\nEdited body.` }
        });
        assert.equal(res.status, 200, res.text);
        const onDisk = readStyleFile(dataRoot, 'alice-noir-directive.md');
        assert.match(onDisk, /^slug: "alice-noir"$/m);
        assert.match(onDisk, new RegExp(`^owner: "${ALICE}"$`, 'm'));
        assert.match(onDisk, /^created: "2026-08-16"$/m);
        assert.match(onDisk, /Edited body\./);

        // And she still owns it; Bob still does not.
        assert.equal((await request('/api/styles/alice-noir', { cookies: as(ALICE) })).status, 200);
        assert.equal((await request('/api/styles/alice-noir', { cookies: as(BOB) })).status, 404);
    });
});

test('DELETE: the owner may delete (both files); the other user gets 404; a bundled style is 403', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-trained', owner: ALICE, tier: 'trained', withReference: true });

        const intruder = await request('/api/styles/alice-trained', { method: 'DELETE', cookies: as(BOB) });
        assert.equal(intruder.status, 404);
        assert.ok(styleFileExists(dataRoot, 'alice-trained-directive.md'), 'a refused DELETE removed the directive');
        assert.ok(styleFileExists(dataRoot, 'alice-trained-reference.md'), 'a refused DELETE removed the reference');

        for (const email of [ALICE, BOB]) {
            const res = await request(`/api/styles/${BUNDLED_TRAINED}`, { method: 'DELETE', cookies: as(email) });
            assert.equal(res.status, 403, `${email} DELETE bundled: got ${res.status}`);
            assert.ok(styleFileExists(dataRoot, `${BUNDLED_TRAINED}-directive.md`));
            assert.ok(styleFileExists(dataRoot, `${BUNDLED_TRAINED}-reference.md`));
        }

        const owner = await request('/api/styles/alice-trained', { method: 'DELETE', cookies: as(ALICE) });
        assert.equal(owner.status, 200, owner.text);
        assert.ok(!styleFileExists(dataRoot, 'alice-trained-directive.md'));
        assert.ok(!styleFileExists(dataRoot, 'alice-trained-reference.md'));
    });
});

// ─── Using a style from a project ───────────────────────────────────────────────

test('a project cannot select another user’s private style by slug; the bundle and your own select fine', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE });
        const bobId = await createProject(request, BOB, 'Bob Script');
        const aliceId = await createProject(request, ALICE, 'Alice Script');

        const steal = await request('/api/select-style', { method: 'POST', cookies: as(BOB), json: { projectId: bobId, styleSlug: 'alice-noir' } });
        assert.equal(steal.status, 404);
        assert.equal(projectOnDisk(dataRoot, bobId).data?.stage7_style, undefined, 'the project now points at a style its owner may not see');

        const shared = await request('/api/select-style', { method: 'POST', cookies: as(BOB), json: { projectId: bobId, styleSlug: BUNDLED_PRESET } });
        assert.equal(shared.status, 200, shared.text);
        assert.equal(projectOnDisk(dataRoot, bobId).data.stage7_style, BUNDLED_PRESET);

        const own = await request('/api/select-style', { method: 'POST', cookies: as(ALICE), json: { projectId: aliceId, styleSlug: 'alice-noir' } });
        assert.equal(own.status, 200, own.text);
        assert.equal(projectOnDisk(dataRoot, aliceId).data.stage7_style, 'alice-noir');
    });
});

test('preview-style-scene refuses another user’s style before any model work', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE });
        const bobId = await createProject(request, BOB);
        const aliceId = await createProject(request, ALICE);

        const intruder = await request('/api/preview-style-scene', { method: 'POST', cookies: as(BOB), json: { projectId: bobId, styleSlug: 'alice-noir' } });
        assert.equal(intruder.status, 404);

        // Owner leg: the style read passes and the route gets as far as its own
        // "no scenes" validation — a 400, not a 404 — with no model call needed.
        const owner = await request('/api/preview-style-scene', { method: 'POST', cookies: as(ALICE), json: { projectId: aliceId, styleSlug: 'alice-noir' } });
        assert.equal(owner.status, 400, owner.text);
        assert.match(owner.json.error, /No scenes/);
    });
});

test('at draft time, a project pointing at a style you may not see drafts without it', async () => {
    // loadProjectStyle is what every generation route feeds into the prompt; it is
    // the read that would leak a private directive into another tenant's model call.
    await withServer({}, async ({ dataRoot, module: serverModule }) => {
        const { runWithIdentity } = identityOf();
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, body: 'ALICE PRIVATE DIRECTIVE', withReference: true });
        const projectData = { data: { stage7_style: 'alice-noir' } };

        const forAlice = await runWithIdentity({ email: ALICE, method: 'session' }, () => serverModule.loadProjectStyle(projectData));
        assert.match(forAlice.styleContent, /ALICE PRIVATE DIRECTIVE/);
        assert.match(forAlice.referenceContent, /Reference analysis/);
        assert.equal(forAlice.styleWarning, null);

        const forBob = await runWithIdentity({ email: BOB, method: 'session' }, () => serverModule.loadProjectStyle(projectData));
        assert.equal(forBob.styleContent, null);
        assert.equal(forBob.referenceContent, null);
        assert.match(forBob.styleWarning, /no longer available/);

        // The shared library still loads for both.
        const shared = { data: { stage7_style: BUNDLED_TRAINED } };
        for (const email of [ALICE, BOB]) {
            const loaded = await runWithIdentity({ email, method: 'session' }, () => serverModule.loadProjectStyle(shared));
            assert.ok(loaded.styleContent, `${email} could not draft with a bundled style`);
            assert.ok(loaded.referenceContent, `${email} lost the bundled reference`);
        }
    });
});

test('the assistant’s style-library context names only styles the caller may see', async () => {
    await withServer({}, async ({ dataRoot, module: serverModule }) => {
        const { runWithIdentity } = identityOf();
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, name: 'Alice Secret Voice' });
        seedStyle(dataRoot, { slug: 'bob-farce', owner: BOB, name: 'Bob Loud Voice' });

        const forAlice = await runWithIdentity({ email: ALICE, method: 'session' }, () => serverModule.buildGlobalStyleAssistantContext());
        assert.match(forAlice, /Alice Secret Voice/);
        assert.doesNotMatch(forAlice, /Bob Loud Voice/);

        const forBob = await runWithIdentity({ email: BOB, method: 'session' }, () => serverModule.buildGlobalStyleAssistantContext());
        assert.match(forBob, /Bob Loud Voice/);
        assert.doesNotMatch(forBob, /Alice Secret Voice/);
    });
});

// ─── Unowned (pre-migration) user styles fail CLOSED ────────────────────────────

test('a user style with no owner is hidden from everyone, and never silently claimed', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'legacy-voice', owner: null, name: 'Legacy Voice' });
        for (const email of [ALICE, BOB]) {
            assert.equal((await request('/api/styles/legacy-voice', { cookies: as(email) })).status, 404);
            const list = (await request('/api/styles', { cookies: as(email) })).json.styles.map(s => s.slug);
            assert.ok(!list.includes('legacy-voice'), `${email} can see an unowned style`);
        }
        assert.doesNotMatch(readStyleFile(dataRoot, 'legacy-voice-directive.md'), /^owner:/m, 'a read stamped an owner');
    });
});

// ─── The migration, driven the way it will be driven on prod ───────────────────

test('the style-owner migration endpoint recovers unowned user styles and leaves the bundle alone', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'legacy-voice', owner: null, name: 'Legacy Voice' });
        seedStyle(dataRoot, { slug: 'legacy-trained', owner: null, name: 'Legacy Trained', tier: 'trained', withReference: true });
        const bundledBefore = readStyleFile(dataRoot, `${BUNDLED_TRAINED}-directive.md`);

        // Before: hidden, even from the admin.
        assert.equal((await request('/api/styles/legacy-voice', { cookies: as(ALICE) })).status, 404);

        const audit = await request('/api/maintenance/style-owners/audit', { cookies: as(ALICE) });
        assert.equal(audit.status, 200, audit.text);
        // Three FILES unowned (directive + directive + reference); the bundle is not counted.
        assert.match(audit.json.output.join('\n'), /3 unowned/);
        assert.doesNotMatch(readStyleFile(dataRoot, 'legacy-voice-directive.md'), /^owner:/m, 'the audit wrote an owner');

        const stamp = await request('/api/maintenance/style-owners/stamp', { method: 'POST', cookies: as(ALICE) });
        assert.equal(stamp.status, 200, stamp.text);
        assert.equal(stamp.json.owner, ALICE);
        assert.match(stamp.json.output.join('\n'), /3 style file\(s\) stamped/);

        // After: the admin's, and only the admin's; both halves of the trained one.
        assert.equal((await request('/api/styles/legacy-voice', { cookies: as(ALICE) })).status, 200);
        assert.equal((await request('/api/styles/legacy-voice', { cookies: as(BOB) })).status, 404);
        const trained = await request('/api/styles/legacy-trained', { cookies: as(ALICE) });
        assert.equal(trained.status, 200);
        assert.match(trained.json.reference, new RegExp(`^owner: "${ALICE}"$`, 'm'));

        // The bundle: byte-identical, still shared, still read-only.
        assert.equal(readStyleFile(dataRoot, `${BUNDLED_TRAINED}-directive.md`), bundledBefore, 'the migration touched a bundled style');
        assert.equal((await request(`/api/styles/${BUNDLED_TRAINED}`, { cookies: as(BOB) })).status, 200);

        // Idempotent.
        const again = await request('/api/maintenance/style-owners/stamp', { method: 'POST', cookies: as(ALICE) });
        assert.match(again.json.output.join('\n'), /0 style file\(s\) stamped, 3 already owned/);
    });
});

test('the style migration endpoints are admin-only and never reassign', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'legacy-voice', owner: null });
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE });

        assert.equal((await request('/api/maintenance/style-owners/audit', { cookies: as(BOB) })).status, 403);
        assert.equal((await request('/api/maintenance/style-owners/stamp', { method: 'POST', cookies: as(BOB) })).status, 403);
        assert.doesNotMatch(readStyleFile(dataRoot, 'legacy-voice-directive.md'), /^owner:/m, 'a non-admin stamped the store');

        await request('/api/maintenance/style-owners/stamp', { method: 'POST', cookies: as(ALICE), json: { owner: BOB } });
        assert.match(readStyleFile(dataRoot, 'legacy-voice-directive.md'), new RegExp(`^owner: "${BOB}"$`, 'm'));
        assert.match(readStyleFile(dataRoot, 'alice-noir-directive.md'), new RegExp(`^owner: "${ALICE}"$`, 'm'), 'an existing owner was reassigned');
    });
});

// ─── The other credential types ─────────────────────────────────────────────────

test('break-glass sees and may edit every style — it is the deployment, not a person', async () => {
    await withServer({ APP_SECRET: 'break-glass' }, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE });
        seedStyle(dataRoot, { slug: 'legacy-voice', owner: null });
        const key = { 'x-api-key': 'break-glass' };
        const list = (await request('/api/styles', { headers: key })).json.styles;
        const slugs = list.map(s => s.slug);
        assert.ok(slugs.includes('alice-noir') && slugs.includes('legacy-voice') && slugs.includes(BUNDLED_PRESET));
        assert.ok(list.every(s => s.editable), 'break-glass should be able to edit everything');
    });
});

test('an access token is scoped to its owner exactly like the cookie', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE });
        seedStyle(dataRoot, { slug: 'bob-farce', owner: BOB });
        const minted = await request('/api/tokens', { method: 'POST', cookies: as(BOB), json: { name: 'bob script' } });
        assert.equal(minted.status, 201);
        const key = { 'x-api-key': minted.json.token };
        assert.equal((await request('/api/styles/bob-farce', { headers: key })).status, 200);
        assert.equal((await request('/api/styles/alice-noir', { headers: key })).status, 404);
    });
});

test('an open server is unaffected: unowned styles are visible and editable', async () => {
    const open = { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ALLOWED_EMAILS: '', SESSION_SECRET: '' };
    await withServer(open, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'legacy-voice', owner: null });
        const res = await request('/api/styles/legacy-voice');
        assert.equal(res.status, 200);
        assert.equal(res.json.editable, true);
        const put = await request('/api/styles/legacy-voice', { method: 'PUT', json: { content: '---\nname: "Legacy"\n---\n\nedited' } });
        assert.equal(put.status, 200, put.text);
        // No identity to stamp — the file must not gain a bogus owner line.
        assert.doesNotMatch(readStyleFile(dataRoot, 'legacy-voice-directive.md'), /^owner:/m);
    });
});

// ─── Sharing: view for everyone, use and edit for the owner, copy to use ────────
//
// Carsten's design (2026-08-16): sharing is COPY-based, never link-based. Another
// tester's shared style is visible, but a project can only be attached to a style
// you own or a bundled one — so un-sharing can never break someone else's drafts.

test('the owner may share a style; others can then see it but not edit, delete or attach it', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, name: 'Alice Noir', withReference: true });
        const bobId = await createProject(request, BOB, 'Bob Script');

        // Bob cannot share Alice's style for her.
        const hijack = await request('/api/styles/alice-noir/visibility', { method: 'PATCH', cookies: as(BOB), json: { visibility: 'shared' } });
        assert.equal(hijack.status, 404);
        assert.doesNotMatch(readStyleFile(dataRoot, 'alice-noir-directive.md'), /^visibility:/m);

        const share = await request('/api/styles/alice-noir/visibility', { method: 'PATCH', cookies: as(ALICE), json: { visibility: 'shared' } });
        assert.equal(share.status, 200, share.text);
        assert.equal(share.json.visibility, 'shared');
        // Both halves say so — sharing a trained style shares its reference.
        assert.match(readStyleFile(dataRoot, 'alice-noir-directive.md'), /^visibility: "shared"$/m);
        assert.match(readStyleFile(dataRoot, 'alice-noir-reference.md'), /^visibility: "shared"$/m);

        // Bob can now SEE it, with the flags the UI keys off.
        const seen = await request('/api/styles/alice-noir', { cookies: as(BOB) });
        assert.equal(seen.status, 200);
        assert.equal(seen.json.owner, ALICE);
        assert.equal(seen.json.visibility, 'shared');
        assert.deepEqual([seen.json.editable, seen.json.usable], [false, false]);
        assert.match(seen.json.reference, /Reference analysis/);
        const listed = (await request('/api/styles', { cookies: as(BOB) })).json.styles.find(s => s.slug === 'alice-noir');
        assert.ok(listed, 'shared style missing from Bob’s list');
        assert.deepEqual([listed.usable, listed.editable, listed.owner], [false, false, ALICE]);

        // ...but not EDIT, DELETE, or ATTACH it. These are 403 (he can see it exists).
        const before = readStyleFile(dataRoot, 'alice-noir-directive.md');
        assert.equal((await request('/api/styles/alice-noir', { method: 'PUT', cookies: as(BOB), json: { content: '---\nname: x\n---\nnope' } })).status, 403);
        assert.equal((await request('/api/styles/alice-noir', { method: 'DELETE', cookies: as(BOB) })).status, 403);
        assert.equal(readStyleFile(dataRoot, 'alice-noir-directive.md'), before, 'a refused write changed the shared style');
        assert.ok(styleFileExists(dataRoot, 'alice-noir-reference.md'));
        const attach = await request('/api/select-style', { method: 'POST', cookies: as(BOB), json: { projectId: bobId, styleSlug: 'alice-noir' } });
        assert.equal(attach.status, 403, attach.text);
        assert.match(attach.json.error, /copy it to your library/i);
        assert.equal(projectOnDisk(dataRoot, bobId).data?.stage7_style, undefined);
        const preview = await request('/api/preview-style-scene', { method: 'POST', cookies: as(BOB), json: { projectId: bobId, styleSlug: 'alice-noir' } });
        assert.equal(preview.status, 403);

        // The owner still uses and edits it as before.
        const aliceId = await createProject(request, ALICE, 'Alice Script');
        assert.equal((await request('/api/select-style', { method: 'POST', cookies: as(ALICE), json: { projectId: aliceId, styleSlug: 'alice-noir' } })).status, 200);
        const edit = await request('/api/styles/alice-noir', { method: 'PUT', cookies: as(ALICE), json: { content: styleText({ name: 'Alice Noir', slug: 'alice-noir', owner: ALICE, body: 'Still mine.' }) } });
        assert.equal(edit.status, 200, edit.text);
        // And the edit did not un-share it (provenance re-stamped from disk).
        assert.match(readStyleFile(dataRoot, 'alice-noir-directive.md'), /^visibility: "shared"$/m);

        // Taking it private again hides it from Bob at once.
        assert.equal((await request('/api/styles/alice-noir/visibility', { method: 'PATCH', cookies: as(ALICE), json: { visibility: 'private' } })).status, 200);
        assert.equal((await request('/api/styles/alice-noir', { cookies: as(BOB) })).status, 404);

        // Bundled styles cannot be re-shared or privatised by anyone.
        assert.equal((await request(`/api/styles/${BUNDLED_PRESET}/visibility`, { method: 'PATCH', cookies: as(ALICE), json: { visibility: 'private' } })).status, 403);
        assert.equal((await request('/api/styles/alice-noir/visibility', { method: 'PATCH', cookies: as(ALICE), json: { visibility: 'public' } })).status, 400);
    });
});

test('at draft time, another tester’s shared style is not used even if a project points at it', async () => {
    // Defence in depth for the link-free rule: select-style already refuses, but a
    // slug could land in a project some other way (import, old data). It must draft
    // as "no longer available" for anyone but the owner.
    await withServer({}, async ({ dataRoot, module: serverModule }) => {
        const { runWithIdentity } = identityOf();
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, body: 'ALICE SHARED DIRECTIVE' });
        fs.writeFileSync(path.join(dataRoot, 'styles', 'alice-noir-directive.md'),
            readStyleFile(dataRoot, 'alice-noir-directive.md').replace('---\n\n## Voice', 'visibility: "shared"\n---\n\n## Voice'));
        const projectData = { data: { stage7_style: 'alice-noir' } };
        const forAlice = await runWithIdentity({ email: ALICE, method: 'session' }, () => serverModule.loadProjectStyle(projectData));
        assert.match(forAlice.styleContent, /ALICE SHARED DIRECTIVE/);
        const forBob = await runWithIdentity({ email: BOB, method: 'session' }, () => serverModule.loadProjectStyle(projectData));
        assert.equal(forBob.styleContent, null);
        assert.match(forBob.styleWarning, /no longer available/);
    });
});

test('copying a shared style (or a bundled one) yields a private style of your own, both files, usable and editable', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        seedStyle(dataRoot, { slug: 'alice-noir', owner: ALICE, name: 'Alice Noir', withReference: true });
        const bobId = await createProject(request, BOB, 'Bob Script');

        // Private: Bob cannot even see it, so he cannot copy it.
        assert.equal((await request('/api/styles/alice-noir/copy', { method: 'POST', cookies: as(BOB) })).status, 404);

        await request('/api/styles/alice-noir/visibility', { method: 'PATCH', cookies: as(ALICE), json: { visibility: 'shared' } });
        const copy = await request('/api/styles/alice-noir/copy', { method: 'POST', cookies: as(BOB) });
        assert.equal(copy.status, 201, copy.text);
        const newSlug = copy.json.slug;
        assert.notEqual(newSlug, 'alice-noir');
        assert.equal(copy.json.copiedFrom, 'alice-noir');
        assert.deepEqual([copy.json.editable, copy.json.usable], [true, true]);

        // On disk: Bob's, private, both halves, paired to each other, provenance recorded.
        const dir = readStyleFile(dataRoot, `${newSlug}-directive.md`);
        const ref = readStyleFile(dataRoot, `${newSlug}-reference.md`);
        for (const text of [dir, ref]) {
            assert.match(text, new RegExp(`^owner: "${BOB}"$`, 'm'));
            assert.match(text, /^visibility: "private"$/m);
            assert.match(text, /^copied_from: "alice-noir"$/m);
            assert.match(text, new RegExp(`^slug: "${newSlug}"$`, 'm'));
        }
        assert.match(dir, new RegExp(`^paired_with: "${newSlug}-reference"$`, 'm'));
        assert.match(ref, new RegExp(`^paired_with: "${newSlug}-directive"$`, 'm'));

        // Bob can now use and edit HIS copy; Alice cannot see it; the original is untouched.
        assert.equal((await request('/api/select-style', { method: 'POST', cookies: as(BOB), json: { projectId: bobId, styleSlug: newSlug } })).status, 200);
        assert.equal(projectOnDisk(dataRoot, bobId).data.stage7_style, newSlug);
        assert.equal((await request(`/api/styles/${newSlug}`, { cookies: as(ALICE) })).status, 404);
        assert.match(readStyleFile(dataRoot, 'alice-noir-directive.md'), new RegExp(`^owner: "${ALICE}"$`, 'm'));

        // Alice un-sharing afterwards does not touch Bob's copy or his project.
        await request('/api/styles/alice-noir/visibility', { method: 'PATCH', cookies: as(ALICE), json: { visibility: 'private' } });
        assert.equal((await request(`/api/styles/${newSlug}`, { cookies: as(BOB) })).status, 200);

        // A bundled preset copies too — an editable duplicate for whoever wants one.
        const presetCopy = await request(`/api/styles/${BUNDLED_PRESET}/copy`, { method: 'POST', cookies: as(BOB) });
        assert.equal(presetCopy.status, 201, presetCopy.text);
        assert.equal(presetCopy.json.editable, true);
        assert.match(readStyleFile(dataRoot, `${presetCopy.json.slug}-directive.md`), new RegExp(`^owner: "${BOB}"$`, 'm'));
        assert.equal((await request(`/api/styles/${BUNDLED_PRESET}`, { cookies: as(ALICE) })).json.editable, false, 'copying changed the bundled original');
    });
});

// ─── Completeness: a new style route cannot quietly skip this file ─────────────

const COVERED_STYLE_ROUTES = new Set([
    'GET /api/styles',
    'GET /api/styles/:slug',
    'PUT /api/styles/:slug',
    'DELETE /api/styles/:slug',
    'POST /api/select-style',
    'POST /api/preview-style-scene',
    // Creation paths call the model; the owner stamp on them is exercised by the
    // real-request browser pass and by style_store's ownerStampForNewStyle. Their
    // READ of the previous style goes through the store (refine guard).
    'POST /api/generate-stage7-style',
    'POST /api/generate-trained-style',
    'GET /api/maintenance/style-owners/audit',
    'POST /api/maintenance/style-owners/stamp',
    'PATCH /api/styles/:slug/visibility',
    'POST /api/styles/:slug/copy'
]);

test('every style-bearing route is covered by an explicit cross-user case', async () => {
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
        const styleRoutes = found.filter(r => /style/i.test(r));
        const uncovered = styleRoutes.filter(r => !COVERED_STYLE_ROUTES.has(r));
        assert.deepEqual(uncovered, [], `style routes with no ownership coverage:\n  ${uncovered.join('\n  ')}`);
        // And the list is not vacuous.
        assert.ok(styleRoutes.length >= 8, `only ${styleRoutes.length} style routes found — did the walk break?`);
    });
});
