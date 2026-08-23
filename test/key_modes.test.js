const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

/**
 * Phase 5 item 3 — house keys vs bring-your-own, per person.
 *
 * Carsten's brief of 2026-08-21: BYOK matters, but testers must not have to deal
 * with API keys. So `house` is the default (the deployment's keys, capped by that
 * person's monthly budget) and `byok` is opt-in per address (their keys, their
 * money, uncapped unless given an explicit budget).
 *
 * THE FAILURE THIS GUARDS AGAINST is the silent-200 family: a byok writer whose
 * request quietly runs on the house key. It would work perfectly, cost Carsten
 * money, and appear in no log. There is no assertion that can be made about a call
 * NOT happening, so these tests assert on the RESOLVER'S OUTPUT — which key object
 * comes back for which identity — and on the honest 4xx that replaces the provider's
 * 401. The harness blanking every house key is what makes a leak visible: a byok
 * resolution that fell through would return the (blank) house key, i.e. null, and
 * the "…must not be the house key" assertions below distinguish those two cases by
 * setting a house key that is a recognisable string.
 *
 * Guard-break signatures are recorded in CLAUDE.md's Recent Changes entry.
 */

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com, carol@example.com',
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};
const ALICE = 'alice@example.com'; // bootstrap admin
const BOB = 'bob@example.com';     // house
const CAROL = 'carol@example.com'; // byok
const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });

const HOUSE_GEMINI = 'house-gemini-key-DO-NOT-LEAK';

async function withServer(env, run) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    try { return await run(server); } finally { await server.close(); }
}

const setMode = (request, email, mode) =>
    request('/api/admin/key-mode', { method: 'PUT', cookies: as(ALICE), json: { email, mode } });

const putKey = (request, email, body) =>
    request('/api/my-keys', { method: 'PUT', cookies: as(email), json: body });

const myKeys = (request, email) => request('/api/my-keys', { cookies: as(email) });

/**
 * The resolver, asked directly inside the running server's module graph and inside
 * the caller's identity — which is the honest way to ask "what key would this
 * person's next request use?" without making a provider call the harness forbids.
 */
function resolveAs(serverModule, email, provider, baseUrl = null) {
    const { runWithIdentity } = require('../utils/request_identity');
    const apiKeys = require('../utils/api_keys');
    void serverModule;
    return runWithIdentity({ email, method: 'session' }, () => apiKeys.resolveKey(provider, { baseUrl }));
}

// ─── The default, and the point of it ─────────────────────────────────────────

test('everyone is on the house keys by default — a whitelisted tester never sees an API key', async () => {
    await withServer({ GEMINI_API_KEY: HOUSE_GEMINI }, async ({ request, module: serverModule }) => {
        const overview = await request('/api/admin/overview', { cookies: as(ALICE) });
        assert.equal(overview.status, 200, overview.text);
        for (const entry of overview.json.allowlist) {
            assert.equal(entry.keyMode, 'house', `${entry.email} should default to house keys`);
        }

        const resolved = resolveAs(serverModule, BOB, 'gemini');
        assert.equal(resolved.mode, 'house');
        assert.equal(resolved.key, HOUSE_GEMINI, 'a house writer runs on the deployment key');
    });
});

// ─── The leak this exists to prevent ──────────────────────────────────────────

test('a byok writer with no key of their own gets NULL — never the house key', async () => {
    await withServer({ GEMINI_API_KEY: HOUSE_GEMINI }, async ({ request, module: serverModule }) => {
        assert.equal((await setMode(request, CAROL, 'byok')).status, 200);

        const resolved = resolveAs(serverModule, CAROL, 'gemini');
        assert.equal(resolved.mode, 'byok');
        assert.notEqual(resolved.key, HOUSE_GEMINI,
            'THE LEAK: a byok writer running on the deployment key would work perfectly, '
            + "cost Carsten money, and appear in no log");
        assert.equal(resolved.key, null);

        // Bob, unchanged, in the same process — so this is the mode deciding, not
        // the deployment simply having no key.
        assert.equal(resolveAs(serverModule, BOB, 'gemini').key, HOUSE_GEMINI);
    });
});

test("a byok writer's own key is what resolves, and only theirs", async () => {
    await withServer({ GEMINI_API_KEY: HOUSE_GEMINI }, async ({ request, module: serverModule }) => {
        await setMode(request, CAROL, 'byok');
        const saved = await putKey(request, CAROL, { provider: 'gemini', key: 'carol-own-gemini-key' });
        assert.equal(saved.status, 200, saved.text);

        assert.equal(resolveAs(serverModule, CAROL, 'gemini').key, 'carol-own-gemini-key');
        assert.equal(resolveAs(serverModule, CAROL, 'anthropic').key, null,
            'a provider she has no key for stays null — no falling back per provider either');
        assert.equal(resolveAs(serverModule, BOB, 'gemini').key, HOUSE_GEMINI,
            "Carol's key must not become anyone else's");
    });
});

test('switching a writer to byok takes effect on their next request — the store is live', async () => {
    await withServer({ GEMINI_API_KEY: HOUSE_GEMINI }, async ({ request, module: serverModule }) => {
        assert.equal(resolveAs(serverModule, BOB, 'gemini').key, HOUSE_GEMINI);
        assert.equal((await setMode(request, BOB, 'byok')).status, 200);
        assert.equal(resolveAs(serverModule, BOB, 'gemini').key, null, 'no restart, no cache to wait out');
        assert.equal((await setMode(request, BOB, 'house')).status, 200);
        assert.equal(resolveAs(serverModule, BOB, 'gemini').key, HOUSE_GEMINI, '…and back again');
    });
});

// ─── The honest refusal ───────────────────────────────────────────────────────

// `POST /api/execute` (Stage 1 Pitch) validates nothing — "allows random pitch
// generation with no input" — so an empty body walks straight into getModelConfig.
// That makes it the one AI route that reaches key resolution without a fixture,
// which is exactly what a "did this get refused before any provider call" test needs.
const fireAiRoute = (request, email) => request('/api/execute', { method: 'POST', cookies: as(email), json: {} });

test('a byok writer with no key is refused BEFORE any provider call, with a message naming the provider', async () => {
    await withServer({ GEMINI_API_KEY: HOUSE_GEMINI, GEMINI_MODEL: 'gemini-3.6-flash' }, async ({ request }) => {
        await setMode(request, CAROL, 'byok');

        const refused = await fireAiRoute(request, CAROL);
        assert.equal(refused.status, 402, `expected an honest refusal, got ${refused.status}: ${refused.text}`);
        assert.equal(refused.json.code, 'NO_API_KEY');
        assert.match(refused.json.error, /Gemini/, 'the message must name the provider she needs a key for');
        assert.match(refused.json.error, /Settings/, '…and where to put it');
        assert.equal(/wrong|invalid/i.test(refused.json.error), false,
            'she has not entered a bad key — she has entered none, and the message must not imply otherwise');
    });
});

test('a house writer on a deployment with no key for that provider is told THAT, not blamed for it', async () => {
    // The harness blanks every key, so this is the "admin has not configured
    // Anthropic" case — a different sentence from the byok one, on purpose.
    await withServer({ GEMINI_MODEL: 'claude-opus-5' }, async ({ request }) => {
        const refused = await fireAiRoute(request, BOB);
        assert.equal(refused.status, 402, refused.text);
        assert.match(refused.json.error, /deployment has no Anthropic key/i);
        assert.match(refused.json.error, /administrator/i, 'a house writer cannot fix this themselves');
    });
});

// ─── The strongest proof: which key actually goes on the wire ─────────────────

test('the key that reaches the provider is the caller\'s own — watched by the provider itself', async () => {
    // Everything above asserts on the resolver. This asserts on the WIRE: a real
    // HTTP server standing in for an OpenAI-compatible vendor records the
    // Authorization header of every request PageOne makes to it. Carol (byok) and
    // Bob (house) drive the same route on the same model, and the vendor is asked
    // which key each of them arrived with. There is no way to fake that.
    const http = require('node:http');
    const seen = [];
    const vendor = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            seen.push({ authorization: req.headers.authorization });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: '{"pitch_options":[]}' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 }
            }));
        });
    });
    await new Promise(resolve => vendor.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${vendor.address().port}/v1`;

    try {
        await withServer({ OPENAI_KEYS: `${baseUrl}=house-openai-key` }, async ({ request }) => {
            const added = await request('/api/admin/models', {
                method: 'POST', cookies: as(ALICE),
                json: {
                    id: 'test-vendor-model', label: 'Test Vendor', provider: 'openai-compatible', baseUrl,
                    pricing: { inputPerMTok: 1, outputPerMTok: 1, source: 'https://example.test', checkedAt: '2026-08-22' }
                }
            });
            assert.equal(added.status, 201, added.text);
            // Everyone's Stage 1 now runs on the fake vendor.
            assert.equal((await request('/api/settings', {
                method: 'POST', cookies: as(ALICE), json: { stageModels: { stage1: 'test-vendor-model' } }
            })).status, 200);

            await setMode(request, CAROL, 'byok');
            assert.equal((await putKey(request, CAROL, { provider: 'openai-compatible', baseUrl, key: 'carols-own-openai-key' })).status, 200);

            await fireAiRoute(request, BOB);
            await fireAiRoute(request, CAROL);

            assert.equal(seen.length, 2, `the vendor should have seen one request each, saw ${seen.length}`);
            assert.equal(seen[0].authorization, 'Bearer house-openai-key', 'the house writer arrived with the deployment key');
            assert.equal(seen[1].authorization, 'Bearer carols-own-openai-key',
                'THE LEAK, if this fails: the byok writer arrived on the house key — working, billed to Carsten, invisible');

            // And the reverse: switch her back to house and the wire changes with her.
            assert.equal((await setMode(request, CAROL, 'house')).status, 200);
            await fireAiRoute(request, CAROL);
            assert.equal(seen[2].authorization, 'Bearer house-openai-key');
        });
    } finally {
        await new Promise(resolve => vendor.close(resolve));
    }
});

// ─── The key store ────────────────────────────────────────────────────────────

test('a stored key never comes back — only a mask', async () => {
    await withServer({}, async ({ request, dataRoot }) => {
        await putKey(request, CAROL, { provider: 'gemini', key: 'sk-secret-value-1234' });

        const listed = await myKeys(request, CAROL);
        assert.equal(listed.status, 200, listed.text);
        assert.equal(listed.text.includes('sk-secret-value-1234'), false, 'the plaintext must never be served');
        const row = listed.json.keys.find(k => k.slot === 'gemini');
        assert.equal(row.mask, '••••1234');
        assert.equal(row.usable, true);

        // …and it is not sitting in the file in the clear either.
        const raw = fs.readFileSync(path.join(dataRoot, 'user-keys.json'), 'utf8');
        assert.equal(raw.includes('sk-secret-value-1234'), false, 'the store must be encrypted at rest');
        assert.ok(raw.includes('"ct"') && raw.includes('"iv"') && raw.includes('"tag"'), 'AES-GCM ciphertext, iv and tag');
    });
});

test('a key that will not decrypt is reported as unusable rather than looking absent', async () => {
    // The rotated-secret case. Written under one secret, read under another.
    const first = await startTestServer({ env: { ...GOOGLE_ENV } });
    let dataRoot;
    try {
        dataRoot = first.dataRoot;
        assert.equal((await first.request('/api/my-keys', { method: 'PUT', cookies: as(CAROL), json: { provider: 'gemini', key: 'sk-old-secret-9999' } })).status, 200);
    } finally {
        // Keep the data directory: the harness deletes it on close.
        const kept = fs.readFileSync(path.join(dataRoot, 'user-keys.json'), 'utf8');
        await first.close();
        const second = await startTestServer({ env: { ...GOOGLE_ENV, SESSION_SECRET: 'a-DIFFERENT-session-secret' } });
        try {
            fs.writeFileSync(path.join(second.dataRoot, 'user-keys.json'), kept);
            const rotatedAs = email => ({ pageone_session: signSession(email, 'a-DIFFERENT-session-secret') });
            const listed = await second.request('/api/my-keys', { cookies: rotatedAs(CAROL) });
            assert.equal(listed.status, 200, listed.text);
            const row = listed.json.keys.find(k => k.slot === 'gemini');
            assert.ok(row, 'the key must still be LISTED — telling her to add one she already added is a lie');
            assert.equal(row.usable, false, '…and marked unusable, so the UI can say why');
            assert.equal(row.mask, '••••9999', 'the mask survives because last4 is stored in the clear for exactly this');
        } finally {
            await second.close();
        }
    }
});

test('an OpenAI-compatible key belongs to one endpoint, not to the protocol', async () => {
    await withServer({}, async ({ request, module: serverModule }) => {
        await setMode(request, CAROL, 'byok');
        const moonshot = 'https://api.moonshot.ai/v1';
        const deepseek = 'https://api.deepseek.com/v1';

        assert.equal((await putKey(request, CAROL, { provider: 'openai-compatible', key: 'sk-moon' })).status, 400,
            'without an endpoint there is nothing to attach the key to');
        assert.equal((await putKey(request, CAROL, { provider: 'openai-compatible', baseUrl: moonshot, key: 'sk-moon' })).status, 200);

        assert.equal(resolveAs(serverModule, CAROL, 'openai-compatible', moonshot).key, 'sk-moon');
        assert.equal(resolveAs(serverModule, CAROL, 'openai-compatible', deepseek).key, null,
            'a key for one vendor must not be sent to another that happens to speak the same protocol');
    });
});

test('a token cannot write keys, and neither can anyone else on your behalf', async () => {
    await withServer({}, async ({ request }) => {
        const minted = await request('/api/tokens', { method: 'POST', cookies: as(CAROL), json: { name: 'ci' } });
        assert.equal(minted.status, 201, minted.text);
        const bearer = { authorization: `Bearer ${minted.json.token}` };

        for (const [method, body] of [['GET', undefined], ['PUT', { provider: 'gemini', key: 'x' }], ['DELETE', { provider: 'gemini' }]]) {
            const res = await request('/api/my-keys', { method, headers: bearer, json: body });
            assert.equal(res.status, 401,
                `${method} /api/my-keys accepted a token — a leaked token could then redirect that person's spend `
                + 'and survive its own revocation');
        }

        // There is no email parameter to abuse: the route writes the session's owner.
        await request('/api/my-keys', { method: 'PUT', cookies: as(BOB), json: { provider: 'gemini', key: 'bobs-key', email: CAROL, owner: CAROL } });
        assert.deepEqual((await myKeys(request, CAROL)).json.keys, [], "Bob wrote into Carol's keys");
        assert.equal((await myKeys(request, BOB)).json.keys.length, 1);
    });
});

test('deleting a key removes it', async () => {
    await withServer({}, async ({ request, module: serverModule }) => {
        await setMode(request, CAROL, 'byok');
        await putKey(request, CAROL, { provider: 'gemini', key: 'sk-gone-soon' });
        assert.equal(resolveAs(serverModule, CAROL, 'gemini').key, 'sk-gone-soon');

        const removed = await request('/api/my-keys?provider=gemini', { method: 'DELETE', cookies: as(CAROL) });
        assert.equal(removed.status, 200, removed.text);
        assert.deepEqual(removed.json.keys, []);
        assert.equal(resolveAs(serverModule, CAROL, 'gemini').key, null);
        assert.equal((await request('/api/my-keys?provider=gemini', { method: 'DELETE', cookies: as(CAROL) })).status, 404);
    });
});

// ─── Quotas ───────────────────────────────────────────────────────────────────

test("the default budget does not apply to someone spending their own money, but an explicit one does", async () => {
    await withServer({}, async ({ request }) => {
        const accessControl = require('../utils/access_control');
        await request('/api/admin/quotas', { method: 'PUT', cookies: as(ALICE), json: { defaultMonthlyUsd: 5 } });

        assert.equal(accessControl.effectiveQuotaFor(BOB), 5, 'a house writer gets the default');
        await setMode(request, CAROL, 'byok');
        assert.equal(accessControl.effectiveQuotaFor(CAROL), null,
            "the deployment's default budget is not the deployment's business when it is her money");

        await request('/api/admin/quotas', { method: 'PUT', cookies: as(ALICE), json: { perUser: { [CAROL]: 20 } } });
        assert.equal(accessControl.effectiveQuotaFor(CAROL), 20, 'an explicit budget still caps her — the escape hatch');
    });
});

// ─── Who may change a mode ────────────────────────────────────────────────────

test('only an admin SESSION may change a key mode', async () => {
    await withServer({}, async ({ request }) => {
        const notAdmin = await request('/api/admin/key-mode', { method: 'PUT', cookies: as(BOB), json: { email: BOB, mode: 'byok' } });
        assert.equal(notAdmin.status, 403, notAdmin.text);

        const minted = await request('/api/tokens', { method: 'POST', cookies: as(ALICE), json: { name: 'ci' } });
        const byToken = await request('/api/admin/key-mode', {
            method: 'PUT', headers: { authorization: `Bearer ${minted.json.token}` }, json: { email: BOB, mode: 'byok' }
        });
        assert.equal(byToken.status, 401, 'an admin token must not change who pays');

        const unknown = await setMode(request, 'nobody@example.com', 'byok');
        assert.equal(unknown.status, 400, 'a mode for someone who cannot sign in is a phantom setting');

        const badMode = await setMode(request, BOB, 'freeloader');
        assert.equal(badMode.status, 400, badMode.text);
        assert.equal((await request('/api/admin/overview', { cookies: as(ALICE) })).json.allowlist.find(e => e.email === BOB).keyMode, 'house',
            'a rejected mode must not have half-applied');
    });
});

test('an unrecognised key mode in the store resolves to house, not byok', async () => {
    // Fail-safe direction: `byok` for someone who has no keys locks them out of a
    // deployment that is working perfectly.
    await withServer({ GEMINI_API_KEY: HOUSE_GEMINI }, async ({ dataRoot, module: serverModule }) => {
        fs.writeFileSync(path.join(dataRoot, 'access-control.json'), JSON.stringify({
            version: 1, allowed: [], admins: [], quotas: { defaultMonthlyUsd: null, perUser: {} },
            keyModes: { [BOB]: 'somethingElse' }
        }));
        assert.equal(resolveAs(serverModule, BOB, 'gemini').mode, 'house');
        assert.equal(resolveAs(serverModule, BOB, 'gemini').key, HOUSE_GEMINI);
    });
});

test('removing someone from the allowlist forgets their key mode but keeps their keys', async () => {
    await withServer({}, async ({ request }) => {
        const accessControl = require('../utils/access_control');
        const userKeys = require('../utils/user_keys');
        const DAVE = 'dave@example.com';
        assert.equal((await request('/api/admin/allowlist', { method: 'POST', cookies: as(ALICE), json: { email: DAVE } })).status, 201);
        assert.equal((await setMode(request, DAVE, 'byok')).status, 200);
        assert.equal((await putKey(request, DAVE, { provider: 'gemini', key: 'daves-own-key' })).status, 200);

        assert.equal((await request(`/api/admin/allowlist/${encodeURIComponent(DAVE)}`, { method: 'DELETE', cookies: as(ALICE) })).status, 200);
        assert.equal(accessControl.keyModeFor(DAVE), 'house',
            're-adding someone must not resurrect a byok setting nobody remembers making');
        assert.equal(userKeys.getKey(DAVE, 'gemini'), 'daves-own-key',
            'his key is his property and useless without access — a temporary removal should not cost him re-entering it');
    });
});
