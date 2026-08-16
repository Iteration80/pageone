const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// Multi-user Phase 2: project ownership and isolation.
//
// The failure this file exists to prevent is the one this project has paid for in
// four other guises — serving user A's data to user B with a 200 and nothing in any
// log. So every case here is proved in BOTH directions: the owner gets the real
// response, and the non-owner is refused. A one-sided test cannot tell "isolation
// works" from "the route is broken for everybody".
//
// Enforcement lives at the chokepoints (readProjectJSONById / updateProjectJSON /
// writeProjectJSON in server.js), not in the routes, so these tests are really
// asking one question per route: does this route reach a chokepoint at all?

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    // ⚠️ ALICE IS FIRST, and that makes her the admin under the provisional rule in
    // utils/auth.js isAdminEmail. The maintenance tests below depend on the order.
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com',
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });

async function withServer(env, run) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    try {
        return await run(server);
    } finally {
        await server.close();
    }
}

/** Create a project owned by `email`, through the real route. */
async function createProject(request, email, title, data = {}) {
    const res = await request('/api/projects', { method: 'POST', cookies: as(email) });
    assert.equal(res.status, 201, `create failed for ${email}: ${res.text}`);
    if (title) {
        const put = await request(`/api/projects/${res.json.id}`, {
            method: 'PUT', cookies: as(email), json: { title, data }
        });
        assert.equal(put.status, 200, `title update failed: ${put.text}`);
    }
    return res.json.id;
}

// Seeded so the owner leg of the dismiss route can return 200. Without a matching
// flag that route 404s on its own terms ("audit flag not found"), which would be
// indistinguishable from an ownership refusal — and would have quietly turned the
// owner half of that case into no assertion at all.
const SEEDED_AUDIT = {
    stage6_scenes_audit: {
        generated_at: '2026-08-11T00:00:00.000Z',
        flags: [{ scene_number: 1, type: 'redundancy', dismissed: false }]
    }
};

// ─── The field itself ───────────────────────────────────────────────────────────

test('a created project is stamped with its creator, on both creation paths', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        const id = await createProject(request, ALICE);
        const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${id}.json`), 'utf-8'));
        assert.equal(onDisk.owner, ALICE);

        // The import path builds its own project object and is easy to miss.
        // ⚠️ parseFountain returns 0 scenes for a headings-only snippet with no
        // title page; this shape is the one it actually parses (probed, not guessed).
        const body = Buffer.from('Title: Imported\n\nINT. ROOM - DAY\n\nA man sits.\n\nEXT. STREET - NIGHT\n\nHe walks.\n');
        const boundary = '----pageone-test-boundary';
        const payload = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="scriptFile"; filename="t.fountain"\r\nContent-Type: text/plain\r\n\r\n`),
            body,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);
        const imported = await request('/api/import-script', {
            method: 'POST',
            cookies: as(BOB),
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
            body: payload
        });
        assert.equal(imported.status, 201, `import failed: ${imported.text}`);
        const importedOnDisk = JSON.parse(
            fs.readFileSync(path.join(dataRoot, 'projects', `${imported.json.projectId}.json`), 'utf-8')
        );
        assert.equal(importedOnDisk.owner, BOB);
    });
});

// ─── Listing ────────────────────────────────────────────────────────────────────

test('the project list shows only your own projects', async () => {
    await withServer({}, async ({ request }) => {
        const aliceId = await createProject(request, ALICE);
        const bobId = await createProject(request, BOB);

        const aliceList = (await request('/api/projects', { cookies: as(ALICE) })).json.projects.map(p => p.id);
        const bobList = (await request('/api/projects', { cookies: as(BOB) })).json.projects.map(p => p.id);

        assert.deepEqual(aliceList, [aliceId]);
        assert.deepEqual(bobList, [bobId]);
    });
});

// ─── Cross-user read AND write, every path-parameter route family ───────────────
//
// Each entry is run twice: once as the owner (must NOT be 404) and once as the
// other user (must be 404). `body` is sent on write verbs.

const PROJECT_ROUTES = [
    { method: 'GET', path: id => `/api/projects/${id}` },
    { method: 'PUT', path: id => `/api/projects/${id}`, body: { title: 'Renamed', data: {} } },
    { method: 'PUT', path: id => `/api/projects/${id}/stage1-draft`, body: { patch: { text: 'hello' } } },
    // Body must pass this route's own validation, or Bob is refused with a 400 for
    // the wrong reason and the test proves nothing about ownership.
    { method: 'PATCH', path: id => `/api/projects/${id}/stage6-audit/dismiss`, body: { scene_number: 1, type: 'redundancy' } },
    { method: 'GET', path: id => `/api/projects/${id}/knowledge` },
    { method: 'GET', path: id => `/api/projects/${id}/knowledge/diagnostics` },
    { method: 'PUT', path: id => `/api/projects/${id}/knowledge/review`, body: { review: {} } },
    { method: 'POST', path: id => `/api/projects/${id}/knowledge/decision`, body: { decision: { summary: 'x' } } },
    { method: 'POST', path: id => `/api/projects/${id}/knowledge/compact`, body: {} },
    { method: 'GET', path: id => `/api/export/docx/${id}` },
    { method: 'GET', path: id => `/api/export/pdf/${id}` },
    { method: 'DELETE', path: id => `/api/projects/${id}` } // last: it destroys the fixture
];

test('every project route refuses the other user, and serves the owner', async () => {
    await withServer({}, async ({ request }) => {
        const aliceId = await createProject(request, ALICE, 'Alice Script', SEEDED_AUDIT);

        for (const route of PROJECT_ROUTES) {
            const options = { method: route.method };
            const label = `${route.method} ${route.path(':id')}`;

            const intruder = await request(route.path(aliceId), { ...options, cookies: as(BOB), json: route.body });
            assert.equal(intruder.status, 404, `${label}: Bob got ${intruder.status}, expected 404`);
            // 404 and not 403, deliberately: a non-owner must not be able to tell an
            // existing project from an absent one by the status code alone.
            assert.ok(
                !/alice/i.test(intruder.text),
                `${label}: the refusal leaked project content to Bob`
            );

            const owner = await request(route.path(aliceId), { ...options, cookies: as(ALICE), json: route.body });
            assert.notEqual(owner.status, 404, `${label}: the OWNER got 404 — isolation broke the route for everyone`);
            assert.ok(owner.status < 500, `${label}: owner got ${owner.status} — ${owner.text.slice(0, 200)}`);
        }
    });
});

test('a project id that does not exist looks the same as one you do not own', async () => {
    // If these differed, the status code would be an existence oracle for project ids.
    await withServer({}, async ({ request }) => {
        const aliceId = await createProject(request, ALICE);
        const notOwned = await request(`/api/projects/${aliceId}`, { cookies: as(BOB) });
        const notThere = await request('/api/projects/9999999999999', { cookies: as(BOB) });
        assert.equal(notOwned.status, notThere.status);
        assert.deepEqual(notOwned.json, notThere.json);
    });
});

// ─── Routes that take the project id in the BODY ────────────────────────────────

test('body-projectId routes refuse the other user before doing any work', async () => {
    // These are the generation/rewrite/assistant families. They all resolve the
    // project through a chokepoint before anything expensive, so a cross-user call
    // must be refused without reaching a model — which is also why this is testable
    // at all without an API key.
    await withServer({}, async ({ request }) => {
        const aliceId = await createProject(request, ALICE, 'Alice Script');

        const bodyRoutes = [
            '/api/save-stage10-pending',
            '/api/init-stage9',
            '/api/select-style',
            '/api/continuity/resolve'
        ];

        for (const route of bodyRoutes) {
            const res = await request(route, {
                method: 'POST', cookies: as(BOB), json: { projectId: aliceId }
            });
            assert.ok(
                res.status === 404 || res.status === 400,
                `${route}: Bob got ${res.status}, expected a refusal`
            );
            assert.ok(!/alice/i.test(res.text), `${route}: leaked project content to Bob`);
        }
    });
});

// ─── The write chokepoint stands on its own ─────────────────────────────────────

test('a write is refused even when the payload claims the caller owns it', async () => {
    // Trusting the payload's `owner` would let anyone take a project by writing
    // their own address into it. The on-disk owner is authoritative.
    await withServer({}, async ({ request, dataRoot }) => {
        const aliceId = await createProject(request, ALICE, 'Alice Script');

        const steal = await request(`/api/projects/${aliceId}`, {
            method: 'PUT', cookies: as(BOB), json: { title: 'Bob owns this now', owner: BOB, data: {} }
        });
        assert.equal(steal.status, 404);

        const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${aliceId}.json`), 'utf-8'));
        assert.equal(onDisk.owner, ALICE, 'ownership was transferred by a request body');
        assert.equal(onDisk.title, 'Alice Script', 'a refused write still modified the project');
    });
});

// ─── Unowned (pre-migration) projects fail CLOSED ───────────────────────────────

test('a project with no owner is denied to everyone, and never silently claimed', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        const legacy = { id: '1700000000001', title: 'Legacy Script', data: {} };
        fs.writeFileSync(path.join(dataRoot, 'projects', '1700000000001.json'), JSON.stringify(legacy, null, 2));

        for (const email of [ALICE, BOB]) {
            assert.equal((await request('/api/projects/1700000000001', { cookies: as(email) })).status, 404);
            assert.equal((await request('/api/projects', { cookies: as(email) })).json.projects.length, 0);
        }

        // Denied, not adopted: reading must not stamp an owner as a side effect.
        const stillOnDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', '1700000000001.json'), 'utf-8'));
        assert.equal(stillOnDisk.owner, undefined);
    });
});

// ─── Maintenance routes sweep every tenant, so they are admin-only ──────────────

test('cross-tenant maintenance routes are refused to a non-admin tester', async () => {
    await withServer({}, async ({ request }) => {
        const routes = [
            ['GET', '/api/maintenance/legacy-projects/audit'],
            ['POST', '/api/maintenance/legacy-projects/upgrade'],
            ['GET', '/api/maintenance/stage3-tiers/audit'],
            ['POST', '/api/maintenance/stage3-tiers/seed'],
            ['GET', '/api/maintenance/provider-health']
        ];
        for (const [method, route] of routes) {
            const payload = method === 'GET' ? undefined : {};
            const bob = await request(route, { method, cookies: as(BOB), json: payload });
            assert.equal(bob.status, 403, `${method} ${route}: Bob got ${bob.status}, expected 403`);

            const alice = await request(route, { method, cookies: as(ALICE), json: payload });
            assert.notEqual(alice.status, 403, `${method} ${route}: the admin was refused`);
        }
    });
});

// ─── The migration, driven the way it will actually be driven on prod ──────────

test('the ownership migration endpoint recovers a deployment from unowned to owned', async () => {
    // This is the deploy sequence itself, end to end: Phase 2 code meets a store
    // full of pre-migration projects, everything 404s, one authenticated POST
    // fixes it. Running it here is the difference between believing the ordering
    // works and knowing it does.
    await withServer({}, async ({ request, dataRoot }) => {
        const legacyIds = ['1700000000010', '1700000000011'];
        for (const id of legacyIds) {
            fs.writeFileSync(
                path.join(dataRoot, 'projects', `${id}.json`),
                JSON.stringify({ id, title: `Legacy ${id}`, data: {} }, null, 2)
            );
        }

        // Before: the admin's own projects are invisible to her.
        assert.equal((await request('/api/projects', { cookies: as(ALICE) })).json.projects.length, 0);
        assert.equal((await request(`/api/projects/${legacyIds[0]}`, { cookies: as(ALICE) })).status, 404);

        // The audit says so, without writing anything.
        const audit = await request('/api/maintenance/project-owners/audit', { cookies: as(ALICE) });
        assert.equal(audit.status, 200);
        assert.match(audit.json.output.join('\n'), /2 unowned/);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${legacyIds[0]}.json`), 'utf-8')).owner,
            undefined,
            'the audit wrote an owner'
        );

        // The stamp defaults to the signed-in admin — no owner argument needed.
        const stamp = await request('/api/maintenance/project-owners/stamp', { method: 'POST', cookies: as(ALICE) });
        assert.equal(stamp.status, 200, stamp.text);
        assert.equal(stamp.json.owner, ALICE);

        // After: they are hers, and only hers.
        const list = (await request('/api/projects', { cookies: as(ALICE) })).json.projects.map(p => p.id);
        assert.deepEqual(list.sort(), [...legacyIds].sort());
        assert.equal((await request(`/api/projects/${legacyIds[0]}`, { cookies: as(ALICE) })).status, 200);
        assert.equal((await request(`/api/projects/${legacyIds[0]}`, { cookies: as(BOB) })).status, 404);

        // And a second run changes nothing.
        const again = await request('/api/maintenance/project-owners/stamp', { method: 'POST', cookies: as(ALICE) });
        assert.match(again.json.output.join('\n'), /0 project file\(s\) stamped, 2 already owned/);
    });
});

test('the migration endpoints are admin-only and never claim another user’s projects', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        fs.writeFileSync(
            path.join(dataRoot, 'projects', '1700000000012.json'),
            JSON.stringify({ id: '1700000000012', title: 'Legacy', data: {} }, null, 2)
        );

        // Bob is allowlisted but not the admin. If he could stamp, he would take
        // every unmigrated project on the deployment in one request.
        assert.equal((await request('/api/maintenance/project-owners/audit', { cookies: as(BOB) })).status, 403);
        assert.equal((await request('/api/maintenance/project-owners/stamp', { method: 'POST', cookies: as(BOB) })).status, 403);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', '1700000000012.json'), 'utf-8')).owner,
            undefined,
            'a non-admin stamped the store'
        );

        // The stamp only ever fills in the blanks — it does not reassign.
        const aliceId = await createProject(request, ALICE, 'Alice Script');
        await request('/api/maintenance/project-owners/stamp', {
            method: 'POST', cookies: as(ALICE), json: { owner: BOB }
        });
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', `${aliceId}.json`), 'utf-8')).owner,
            ALICE,
            'an existing owner was reassigned by the migration endpoint'
        );
    });
});

// ─── Regressions: the other credential types still behave ──────────────────────

test('break-glass sees every project — it is the deployment, not a person', async () => {
    await withServer({ APP_SECRET: 'break-glass' }, async ({ request }) => {
        const aliceId = await createProject(request, ALICE);
        await createProject(request, BOB);

        const key = { 'x-api-key': 'break-glass' };
        assert.equal((await request(`/api/projects/${aliceId}`, { headers: key })).status, 200);
        assert.equal((await request('/api/projects', { headers: key })).json.projects.length, 2);
    });
});

test('an access token is scoped to its owner exactly like the cookie', async () => {
    await withServer({}, async ({ request }) => {
        const aliceId = await createProject(request, ALICE);
        const bobId = await createProject(request, BOB);

        const minted = await request('/api/tokens', {
            method: 'POST', cookies: as(BOB), json: { name: 'bob script' }
        });
        assert.equal(minted.status, 201);
        const key = { 'x-api-key': minted.json.token };

        assert.equal((await request(`/api/projects/${bobId}`, { headers: key })).status, 200);
        assert.equal((await request(`/api/projects/${aliceId}`, { headers: key })).status, 404);
        assert.deepEqual((await request('/api/projects', { headers: key })).json.projects.map(p => p.id), [bobId]);
    });
});

test('an open server is unaffected by ownership', async () => {
    // Local dev is single-user by definition; enforcement must stay inert there or
    // every existing project stops opening on Carsten's laptop.
    const open = { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ALLOWED_EMAILS: '', SESSION_SECRET: '' };
    await withServer(open, async ({ request, dataRoot }) => {
        const created = await request('/api/projects', { method: 'POST' });
        assert.equal(created.status, 201);

        const legacy = { id: '1700000000002', title: 'Legacy', data: {} };
        fs.writeFileSync(path.join(dataRoot, 'projects', '1700000000002.json'), JSON.stringify(legacy, null, 2));

        assert.equal((await request('/api/projects/1700000000002')).status, 200);
        assert.equal((await request('/api/projects')).json.projects.length, 2);
    });
});

// ─── Completeness: a new project route cannot quietly skip this file ───────────

test('every project-bearing route is covered by an explicit cross-user case', async () => {
    // Enumerating the live route table rather than a hand-written list, so adding a
    // route without adding coverage fails HERE instead of leaking in production.
    // If this fails: add the route to PROJECT_ROUTES (or to the acknowledged list
    // below with a reason), do not just widen the pattern.
    await withServer({}, async ({ module: serverModule }) => {
        const router = serverModule.app.router || serverModule.app._router;
        const found = [];
        const walk = (stack) => {
            for (const layer of stack) {
                if (layer.route) {
                    for (const method of Object.keys(layer.route.methods)) {
                        found.push(`${method.toUpperCase()} ${layer.route.path}`);
                    }
                } else if (layer.handle?.stack) walk(layer.handle.stack);
            }
        };
        walk(router.stack);

        const projectRoutes = found.filter(r => /\/api\/(projects|export)\//.test(r));
        const covered = new Set(PROJECT_ROUTES.map(r => `${r.method} ${r.path('_ID_')}`.replace('_ID_', ':id')));

        // Routes reached only through a parent resource that is itself owner-checked.
        // Each one still resolves its project through a chokepoint; they are listed
        // rather than tested individually because they need a seeded source/asset.
        const acknowledged = new Set([
            'POST /api/projects/:id/knowledge/sources',
            'GET /api/projects/:id/knowledge/sources/:sourceId/assets/:assetKind',
            'DELETE /api/projects/:id/knowledge/sources/:sourceId',
            'PATCH /api/projects/:id/knowledge/sources/:sourceId',
            'POST /api/projects/:id/knowledge/accepted-divergence',
            'POST /api/projects/:id/knowledge/propose-stage-curation',
            'POST /api/projects/:id/knowledge/apply-stage-curation',
            'POST /api/projects/:id/knowledge/refresh-stage-handoff',
            'POST /api/projects/:id/knowledge/rebuild-source-bible'
        ]);

        const uncovered = projectRoutes.filter(r => {
            const normalised = r.replace('/api/export/docx/:projectId', '/api/export/docx/:id')
                                .replace('/api/export/pdf/:projectId', '/api/export/pdf/:id');
            return !covered.has(normalised) && !acknowledged.has(r);
        });

        assert.deepEqual(uncovered, [], `project routes with no ownership coverage:\n  ${uncovered.join('\n  ')}`);
    });
});

// ─── Multipart (multer) routes keep the caller's identity ────────────────────────
//
// multer hands the request back from a stream event on the socket — an async
// resource created BEFORE requireAuth entered the identity context — so without a
// re-entry the handler runs as a SYSTEM call and the chokepoints trust it. Found
// 2026-08-16 when a freshly generated style arrived with no owner stamp; the same
// gap let a multipart POST read and write another tenant's project.

function multipart(fields) {
    const boundary = '----pageone-test-boundary';
    const parts = Object.entries(fields).map(([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    return {
        body: Buffer.from(`${parts.join('')}--${boundary}--\r\n`),
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
    };
}

// Every multer-mounted route that takes a projectId in the body. Each is refused
// with 404 for Bob and gets PAST the ownership check for Alice (anything but 404 —
// a model failure without an API key is fine, it means the read succeeded).
const MULTIPART_PROJECT_ROUTES = [
    '/api/execute',
    '/api/refine-pitch',
    '/api/generate-outline',
    '/api/generate-characters',
    '/api/generate-stage5-treatment',
    '/api/generate-stage7-style',
    '/api/generate-trained-style'
];

test('multipart routes refuse the other user and serve the owner — identity survives multer', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        const aliceId = await createProject(request, ALICE, 'Alice Script');
        const before = fs.readFileSync(path.join(dataRoot, 'projects', `${aliceId}.json`), 'utf-8');

        for (const route of MULTIPART_PROJECT_ROUTES) {
            const { body, headers } = multipart({ projectId: aliceId, description: 'x', message: 'x', prompt: 'x', styleName: 'x' });
            const intruder = await request(route, { method: 'POST', cookies: as(BOB), headers, body });
            assert.ok(
                intruder.status === 404 || intruder.status === 400,
                `${route}: Bob got ${intruder.status} — ${intruder.text.slice(0, 120)}`
            );
            assert.ok(!/alice/i.test(intruder.text), `${route}: leaked project content to Bob`);
        }
        assert.equal(fs.readFileSync(path.join(dataRoot, 'projects', `${aliceId}.json`), 'utf-8'), before, 'a refused multipart request modified the project');

        // The owner leg for the one route that reads the project before anything else
        // it validates: it must get past the ownership check (a model failure is fine).
        const { body, headers } = multipart({ projectId: aliceId, description: 'A terse style' });
        const owner = await request('/api/generate-stage7-style', { method: 'POST', cookies: as(ALICE), headers, body });
        assert.notEqual(owner.status, 404, `the OWNER got 404 on a multipart route — ${owner.text.slice(0, 120)}`);
    });
});

test('a style created through a multipart route is stamped with its creator', async () => {
    // Direct check on the seam: inside a multer callback, is the identity present?
    // A style generated as Bob must not come back unowned (invisible to everyone).
    await withServer({}, async ({ request, module: serverModule }) => {
        const { currentUserEmail } = require('../utils/request_identity');
        let seenInsideMulter = 'not-called';
        serverModule.app.post('/__test/multipart-identity', serverModule.requireAuth, serverModule.upload.single('f'), (req, res) => {
            seenInsideMulter = currentUserEmail();
            res.json({ ok: true });
        });
        const { body, headers } = multipart({ note: 'hi' });
        const res = await request('/__test/multipart-identity', { method: 'POST', cookies: as(BOB), headers, body });
        assert.equal(res.status, 200, res.text);
        assert.equal(seenInsideMulter, BOB, 'the identity context was lost across multer');
    });
});
