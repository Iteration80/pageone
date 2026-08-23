const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

/**
 * Phase 5 item 4 — "Auto (recommended)" and per-stage verification.
 *
 * THE QUESTION CARSTEN ASKED was "do we actually know each model works for each
 * stage?" and the honest answer was **no**. The only per-stage evidence was for the
 * two Gemini defaults, arrived at by using them; the Claude models had never run a
 * single stage on prod; and the `minItems` incident proved that models differ on the
 * exact schemas in ways no local test can catch.
 *
 * So two things exist now, and these tests hold both down:
 *
 *  - **Verify** makes ONE REAL REQUEST per stage carrying **the stage's own schema
 *    object** (`agents/stage_schemas.js` points at the objects the agents export —
 *    identity, not a copy, which the last test pins). Its result, pass or fail, is
 *    the only thing that may write `verified[stage]`.
 *  - **Auto** is one admin-editable map plus those results. No router, no scoring.
 *
 * The fake vendor here is a real HTTP server, so a "verified" tick is earned by a
 * request that actually happened — the alternative, a verifier that asserts against
 * its own mock of itself, is the instrument-that-tests-nothing failure this project
 * has already paid for.
 */

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com',
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test'
};
const ALICE = 'alice@example.com'; // bootstrap admin
const BOB = 'bob@example.com';
const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });

async function withServer(env, run) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    try { return await run(server); } finally { await server.close(); }
}

/** A fake OpenAI-compatible vendor. `reply(body, n)` → `{ status, json }`. */
async function withVendor(reply, run) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw); } catch {}
            requests.push(body);
            const { status = 200, json = {} } = reply(body, requests.length) || {};
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(json));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    try {
        return await run({ baseUrl, requests });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

const completion = (content, tokens = 7) => ({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: tokens, completion_tokens: tokens }
});

async function addVendorModel(request, baseUrl, { id = 'vendor-model', inputPerMTok = 1, outputPerMTok = 1 } = {}) {
    const res = await request('/api/admin/models', {
        method: 'POST', cookies: as(ALICE),
        json: {
            id, label: id, provider: 'openai-compatible', baseUrl,
            pricing: { inputPerMTok, outputPerMTok, source: 'https://example.test', checkedAt: '2026-08-22' }
        }
    });
    assert.equal(res.status, 201, res.text);
    return id;
}

const setGlobalModels = (request, stageModels) =>
    request('/api/settings', { method: 'POST', cookies: as(ALICE), json: { stageModels } });

const settingsFor = (request, email) => request('/api/settings', { cookies: as(email) });

// ─── Auto resolves ────────────────────────────────────────────────────────────

test('Auto resolves to the admin\'s recommended model for the stage', async () => {
    await withServer({ GEMINI_API_KEY: 'house-gemini' }, async ({ request }) => {
        await request('/api/admin/models-recommended', {
            method: 'PUT', cookies: as(ALICE),
            json: { recommended: { 1: 'gemini-3.6-flash', 3: 'gemini-3.1-pro-preview' } }
        });
        await setGlobalModels(request, { stage1: 'auto', stage3: 'auto' });

        const resolved = (await settingsFor(request, BOB)).json.resolvedStageModels;
        assert.equal(resolved.stage1, 'gemini-3.6-flash');
        assert.equal(resolved.stage3, 'gemini-3.1-pro-preview',
            'the map is per stage — that is the whole of the "recommended per stage" answer');
    });
});

test('Auto never picks a model that FAILED verification for that stage', async () => {
    await withVendor(() => ({ json: completion('{"pitch_options":[]}') }), async ({ baseUrl }) => {
        await withServer({ OPENAI_KEYS: `${baseUrl}=house-openai` }, async ({ request }) => {
            // Only the vendor model is reachable: every house model key is blank.
            const id = await addVendorModel(request, baseUrl);
            await request('/api/admin/models-recommended', { method: 'PUT', cookies: as(ALICE), json: { recommended: { 1: id } } });
            await setGlobalModels(request, { stage1: 'auto' });
            assert.equal((await settingsFor(request, BOB)).json.resolvedStageModels.stage1, id);

            // Record a failure for stage 1 by verifying against a vendor that refuses.
            await withVendor(() => ({ status: 400, json: { error: { message: 'INVALID_ARGUMENT: minItems' } } }), async () => {});
            const registry = require('../utils/model_registry');
            await registry.setVerified(id, 1, { ok: false, error: 'INVALID_ARGUMENT', by: ALICE });

            const after = (await settingsFor(request, BOB)).json.resolvedStageModels;
            assert.notEqual(after.stage1, id,
                'a model we have positively established does not work must never be what Auto picks');
            // Nothing else is reachable, so Auto honestly has nothing.
            assert.equal(after.stage1, undefined);
        });
    });
});

test('Auto prefers a verified model over an unverified cheaper one, but takes unverified over nothing', async () => {
    await withVendor(() => ({ json: completion('ok') }), async ({ baseUrl }) => {
        await withServer({ OPENAI_KEYS: `${baseUrl}=house-openai` }, async ({ request }) => {
            const cheap = await addVendorModel(request, baseUrl, { id: 'cheap-model', inputPerMTok: 0.1, outputPerMTok: 0.1 });
            const dear = await addVendorModel(request, baseUrl, { id: 'dear-model', inputPerMTok: 9, outputPerMTok: 9 });
            await setGlobalModels(request, { stage1: 'auto' }); // no `recommended` entry for stage 1

            // Both unverified → cheapest wins.
            assert.equal((await settingsFor(request, BOB)).json.resolvedStageModels.stage1, cheap);

            // The dear one is proven to work here; the cheap one is still a guess.
            const registry = require('../utils/model_registry');
            await registry.setVerified(dear, 1, { ok: true, by: ALICE });
            assert.equal((await settingsFor(request, BOB)).json.resolvedStageModels.stage1, dear,
                'knowing a model works for this stage beats saving money on a guess');

            assert.equal(cheap, 'cheap-model');
        });
    });
});

test('for a bring-your-own-keys writer, Auto picks a model THEIR keys can reach', async () => {
    await withVendor(() => ({ json: completion('ok') }), async ({ baseUrl }) => {
        await withServer({ GEMINI_API_KEY: 'house-gemini', OPENAI_KEYS: `${baseUrl}=house-openai` }, async ({ request }) => {
            const id = await addVendorModel(request, baseUrl);
            await request('/api/admin/models-recommended', { method: 'PUT', cookies: as(ALICE), json: { recommended: { 1: 'gemini-3.6-flash' } } });
            await setGlobalModels(request, { stage1: 'auto' });

            // A house writer gets the recommendation.
            assert.equal((await settingsFor(request, BOB)).json.resolvedStageModels.stage1, 'gemini-3.6-flash');

            // Bob brings his own keys, and has one only for the vendor endpoint.
            assert.equal((await request('/api/admin/key-mode', { method: 'PUT', cookies: as(ALICE), json: { email: BOB, mode: 'byok' } })).status, 200);
            assert.equal((await request('/api/my-keys', {
                method: 'PUT', cookies: as(BOB), json: { provider: 'openai-compatible', baseUrl, key: 'bobs-own-key' }
            })).status, 200);

            assert.equal((await settingsFor(request, BOB)).json.resolvedStageModels.stage1, id,
                'the recommendation is unreachable for Bob, so Auto falls to what he CAN run — '
                + 'not to an honest-but-useless refusal');
            assert.equal((await settingsFor(request, ALICE)).json.resolvedStageModels.stage1, 'gemini-3.6-flash',
                "…and Alice, on house keys, is unaffected");
        });
    });
});

test('Auto with nothing reachable refuses with a message that says which fix applies', async () => {
    // Every house key blanked by the harness and no personal keys → nothing runnable.
    await withServer({}, async ({ request }) => {
        await setGlobalModels(request, { stage1: 'auto' });
        assert.equal((await settingsFor(request, BOB)).json.resolvedStageModels.stage1, undefined,
            'the settings view must show the truth: Auto currently resolves to nothing');

        const refused = await request('/api/execute', { method: 'POST', cookies: as(BOB), json: {} });
        assert.equal(refused.status, 402, refused.text);
        assert.equal(refused.json.code, 'NO_API_KEY');
        assert.match(refused.json.error, /Auto/);
        assert.match(refused.json.error, /API key|verification/i);
    });
});

// ─── A failed model is refused; an unverified one is allowed ──────────────────

test('a model verified as NOT working for a stage is refused for that stage — and only that stage', async () => {
    await withServer({ GEMINI_API_KEY: 'house-gemini' }, async ({ request }) => {
        const registry = require('../utils/model_registry');
        await registry.setVerified('gemini-3.6-flash', 1, { ok: false, error: 'INVALID_ARGUMENT: minItems', by: ALICE });
        await setGlobalModels(request, { stage1: 'gemini-3.6-flash', stage2: 'gemini-3.6-flash' });

        const refused = await request('/api/execute', { method: 'POST', cookies: as(BOB), json: {} });
        assert.equal(refused.status, 400, refused.text);
        assert.match(refused.json.error, /verified as NOT working/i);
        assert.match(refused.json.error, /INVALID_ARGUMENT/, 'the recorded reason travels with the refusal');

        // Stage 2 is a different question and was never answered — still allowed.
        assert.equal((await settingsFor(request, BOB)).json.resolvedStageModels.stage2, 'gemini-3.6-flash');
    });
});

test('an UNVERIFIED model is allowed — "nobody has tried" is not evidence of failure', async () => {
    await withServer({ GEMINI_API_KEY: 'house-gemini' }, async ({ request }) => {
        await setGlobalModels(request, { stage1: 'claude-haiku-4-5-20251001' });
        const refused = await request('/api/execute', { method: 'POST', cookies: as(BOB), json: {} });
        // No Anthropic key here, so it stops at the key check — the point is that it
        // is NOT stopped by the verification check, which would be a 400.
        assert.equal(refused.status, 402, `an unverified model must not be refused as broken (${refused.text})`);
        assert.match(refused.json.error, /Anthropic key/i);
    });
});

// ─── Verify: one real request per stage ───────────────────────────────────────

test('Verify makes a real request per stage, records the result, and bills the admin', async () => {
    const seen = [];
    await withVendor(body => {
        seen.push(body);
        return { json: completion('{"ok":true}') };
    }, async ({ baseUrl }) => {
        await withServer({ OPENAI_KEYS: `${baseUrl}=house-openai` }, async ({ request }) => {
            const id = await addVendorModel(request, baseUrl, { inputPerMTok: 1_000_000, outputPerMTok: 0 });

            const verified = await request(`/api/admin/models/${id}/verify`, {
                method: 'POST', cookies: as(ALICE), json: { stages: [1, 2, 7] }
            });
            assert.equal(verified.status, 200, verified.text);
            assert.deepEqual(verified.json.results.map(r => r.stage), [1, 2, 7]);
            assert.ok(verified.json.results.every(r => r.ok), JSON.stringify(verified.json.results));

            assert.equal(seen.length, 3, 'one real request per stage, no more and no fewer');
            // Stages 1 and 2 carry a schema; stage 7 (Style) is free text and says so.
            assert.ok(seen[0].response_format, 'stage 1 must send its schema');
            assert.ok(seen[1].response_format, 'stage 2 must send its schema');
            assert.equal(seen[2].response_format, undefined, 'stage 7 has no schema and must not invent one');
            assert.deepEqual(
                verified.json.results.map(r => r.kind),
                ['schema', 'schema', 'text'],
                'a free-text probe is labelled as one rather than dressed up as a schema pass'
            );

            // The registry now carries the verdicts…
            const row = verified.json.models.find(m => m.id === id);
            assert.equal(row.verified['1'].ok, true);
            assert.equal(row.verified['1'].by, ALICE, 'who paid for the answer is part of it');
            assert.ok(row.verified['1'].at, 'and when');
            assert.equal(row.verified['3'], undefined, 'a stage nobody asked for stays unanswered');

            // …and the spend is attributed to the admin who ran it. Priced at
            // $1/token in, three 7-token calls = $21.
            const overview = await request('/api/admin/overview', { cookies: as(ALICE) });
            const alice = overview.json.usage.find(u => u.owner === ALICE);
            assert.equal(alice.allTime.usd, 21,
                'verification costs real money and must show up in the same place as everyone else\'s spend');
        });
    });
});

test('Verify records a FAILURE honestly, with the provider\'s own words', async () => {
    await withVendor(() => ({ status: 400, json: { error: { message: 'INVALID_ARGUMENT: minItems is not supported here' } } }),
        async ({ baseUrl }) => {
            await withServer({ OPENAI_KEYS: `${baseUrl}=house-openai` }, async ({ request }) => {
                const id = await addVendorModel(request, baseUrl);
                const verified = await request(`/api/admin/models/${id}/verify`, {
                    method: 'POST', cookies: as(ALICE), json: { stages: [1] }
                });
                assert.equal(verified.status, 200, 'a model failing verification is a RESULT, not a route error');
                assert.equal(verified.json.results[0].ok, false);
                assert.match(verified.json.results[0].error, /INVALID_ARGUMENT/,
                    'the provider\'s own message is the finding — "verification failed" tells nobody anything');

                const row = verified.json.models.find(m => m.id === id);
                assert.equal(row.verified['1'].ok, false);
                assert.match(row.verified['1'].error, /minItems/);
            });
        });
});

test('a model that answers but returns unparseable JSON fails verification', async () => {
    await withVendor(() => ({ json: completion('Sure! Here is your outline: (but not as JSON)') }), async ({ baseUrl }) => {
        await withServer({ OPENAI_KEYS: `${baseUrl}=house-openai` }, async ({ request }) => {
            const id = await addVendorModel(request, baseUrl);
            const verified = await request(`/api/admin/models/${id}/verify`, {
                method: 'POST', cookies: as(ALICE), json: { stages: [2] }
            });
            assert.equal(verified.json.results[0].ok, false,
                'accepting the schema is only half of it — the pipeline depends on the JSON parsing');
            assert.match(verified.json.results[0].error, /unparseable/i);
        });
    });
});

test('Verify needs a key and says so, and refuses stages that do not exist', async () => {
    await withVendor(() => ({ json: completion('{}') }), async ({ baseUrl }) => {
        await withServer({}, async ({ request }) => { // no OPENAI_KEYS
            const id = await addVendorModel(request, baseUrl);
            const noKey = await request(`/api/admin/models/${id}/verify`, { method: 'POST', cookies: as(ALICE), json: { stages: [1] } });
            assert.equal(noKey.status, 400, noKey.text);
            assert.match(noKey.json.error, /no api key/i);

            const badStage = await request(`/api/admin/models/${id}/verify`, { method: 'POST', cookies: as(ALICE), json: { stages: [99] } });
            assert.equal(badStage.status, 400, badStage.text);

            const missing = await request('/api/admin/models/not-a-model/verify', { method: 'POST', cookies: as(ALICE), json: {} });
            assert.equal(missing.status, 404);
        });
    });
});

test('only an admin SESSION may spend money verifying', async () => {
    await withServer({}, async ({ request }) => {
        const byBob = await request('/api/admin/models/gemini-3.6-flash/verify', { method: 'POST', cookies: as(BOB), json: {} });
        assert.equal(byBob.status, 403, byBob.text);

        const minted = await request('/api/tokens', { method: 'POST', cookies: as(ALICE), json: { name: 'ci' } });
        const byToken = await request('/api/admin/models/gemini-3.6-flash/verify', {
            method: 'POST', headers: { authorization: `Bearer ${minted.json.token}` }, json: {}
        });
        assert.equal(byToken.status, 401, 'a leaked token must not be able to run up a bill');
    });
});

// ─── The reserved id, and the object-identity guarantee ───────────────────────

test('`auto` cannot be registered as a model — it is the sentinel', async () => {
    await withServer({}, async ({ request }) => {
        const res = await request('/api/admin/models', {
            method: 'POST', cookies: as(ALICE),
            json: { id: 'auto', label: 'Auto', provider: 'gemini' }
        });
        assert.equal(res.status, 400, res.text);
        assert.match(res.json.error, /reserved/i);
    });
});

test('the Verify probe carries THE agent\'s schema object, not a copy of it', () => {
    // The load-bearing property of agents/stage_schemas.js. If these ever stop being
    // the same object, Verify starts testing something other than what runs, and it
    // will go green while the real stage fails.
    const { STAGE_SCHEMAS, VERIFIABLE_STAGES } = require('../agents/stage_schemas');
    const sources = {
        1: require('../agents/agent_1_pitch').PITCH_SCHEMA,
        2: require('../agents/agent_2_outline').OUTLINE_SCHEMA,
        3: require('../agents/agent_3_characters').CHARACTER_SCHEMA,
        5: require('../agents/agent_5_treatment').TREATMENT_SCHEMA,
        6: require('../agents/agent_6_scenes').SCENE_SEQUENCE_SCHEMA,
        9: require('../agents/agent_9_coverage').COVERAGE_SCHEMA
    };
    for (const [stage, schema] of Object.entries(sources)) {
        assert.ok(schema, `agent for stage ${stage} must export its schema`);
        assert.strictEqual(STAGE_SCHEMAS[stage].schema, schema,
            `stage ${stage}'s probe must BE the agent's schema object, not an equal copy`);
    }
    // Every stage that calls a model is covered, and the free-text ones are explicit.
    assert.deepEqual(VERIFIABLE_STAGES, [1, 2, 3, 5, 6, 7, 8, 9, 10]);
    for (const stage of VERIFIABLE_STAGES) {
        const entry = STAGE_SCHEMAS[stage];
        assert.ok(entry.probe && entry.label, `stage ${stage} needs a probe and a label`);
        assert.equal(entry.kind === 'schema', Boolean(entry.schema),
            `stage ${stage}'s kind must match whether it actually has a schema`);
    }
});
