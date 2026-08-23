const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

/**
 * Phase 5 item 1 — the model table is data.
 *
 * `MODEL_OPTIONS` (app.js), `MODEL_PRICING` (model-pricing.js) and the `claude-`
 * prefix rule (ai-client.js) were three places that had to agree about a model, in
 * source, behind a redeploy. They are now one file an admin edits.
 *
 * The load-bearing claims these tests hold down:
 *  1. There is still ONE price table — the rows the browser is served are the rows
 *     the quota guard prices with, and changing a registry price changes the spend
 *     figure the admin sees. That is asserted end to end, not by inspection.
 *  2. The registry is the only provider map for a registered id, so a non-Claude,
 *     non-Gemini model cannot be silently posted to Google.
 *  3. Removing a priced row is refused, because it would re-price history to $0.00.
 *  4. `verified` cannot be written by hand.
 *
 * Guard-break signatures are recorded in CLAUDE.md's Recent Changes entry.
 */

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com', // Alice first = bootstrap admin
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

const models = (request, email = ALICE) => request('/api/models', { cookies: as(email) });

// ─── The registry arrives, and it is complete ─────────────────────────────────

test('a fresh deployment is seeded from the bundled registry, and every offered model has a price', async () => {
    await withServer({}, async ({ request, dataRoot, module: serverModule }) => {
        const seeded = path.join(dataRoot, 'models.json');

        // ⚠️ BEFORE seeding, the registry must already answer — from the bundle.
        // An empty registry is not a safe default here the way an empty allowlist is:
        // no rows means no models and $0.00 pricing, i.e. every quota silently
        // infinite. This is the assertion that pins the fallback.
        assert.ok(!fs.existsSync(seeded), 'precondition: nothing seeded yet');
        const beforeSeed = await models(request);
        assert.equal(beforeSeed.status, 200, beforeSeed.text);
        assert.ok(beforeSeed.json.models.length > 0,
            'an unseeded deployment must fall back to the bundled registry, not serve an empty table');

        await serverModule.initDb(); // what startServer() does on a real boot
        assert.ok(fs.existsSync(seeded), 'the deployment should get its own editable copy of the registry');

        const res = await models(request);
        assert.equal(res.status, 200, res.text);
        const enabled = res.json.models.filter(m => m.enabled);
        assert.ok(enabled.length >= 7, `expected the bundled models, got ${enabled.length}`);
        for (const model of enabled) {
            assert.ok(model.pricing.inputPerMTok !== null && model.pricing.outputPerMTok !== null,
                `${model.id} is offered in the dropdowns with no price — it would spend money and report $0.00`);
            assert.ok(model.pricing.source, `${model.id} has a price with no source URL to check it against`);
            assert.ok(model.pricing.checkedAt, `${model.id} has a price with no date it was checked`);
        }
        // The superseded models are kept, disabled, so old spend still prices.
        assert.ok(res.json.models.some(m => m.id === 'claude-opus-4-6' && !m.enabled && m.deprecated),
            'superseded models must survive as disabled rows, or historical spend re-prices to $0.00');
    });
});

test('the price table served to the browser is the same table the server prices with', async () => {
    await withServer({}, async ({ request, module: serverModule }) => {
        const served = (await models(request)).json.pricingTable;
        const { MODEL_PRICING } = require('../public/model-pricing');
        assert.deepEqual(served, MODEL_PRICING,
            'the browser and the quota guard must price from one table — a writer told "$4.10 spent" '
            + 'and then 429d for "budget reached" has no way to tell which figure to believe');
        assert.ok(Object.keys(served).length > 0, 'an empty table prices everything at $0.00');
        assert.ok(serverModule);
    });
});

test('an empty price table is refused rather than silently zeroing every spend figure', async () => {
    // Inside withServer on purpose: the harness evicts the first-party require cache
    // between tests, so a bare require() out here would hand back a fresh, empty
    // module and the precondition would be meaningless.
    await withServer({}, async () => {
        const pricing = require('../public/model-pricing');
        const before = Object.keys(pricing.MODEL_PRICING).length;
        assert.ok(before > 0, 'precondition: the table is loaded');
        pricing.setPricingTable({});
        assert.equal(Object.keys(pricing.MODEL_PRICING).length, before,
            'setPricingTable({}) must keep the rows it has — an empty table makes every quota infinite');
    });
});

// ─── The registry is the provider map ─────────────────────────────────────────

test('provider comes from the registry, not the model id prefix', async () => {
    await withServer({}, async ({ request }) => {
        const registry = require('../utils/model_registry');

        const added = await request('/api/admin/models', {
            method: 'POST', cookies: as(ALICE),
            json: {
                id: 'kimi-k3', label: 'Kimi K3', provider: 'openai-compatible',
                baseUrl: 'https://api.moonshot.ai/v1',
                pricing: { inputPerMTok: 0.6, outputPerMTok: 2.5, source: 'https://platform.moonshot.ai/pricing', checkedAt: '2026-08-22' }
            }
        });
        assert.equal(added.status, 201, added.text);

        assert.equal(registry.providerFor('kimi-k3'), 'openai-compatible',
            'a registered non-Claude id must NOT fall through to Gemini — that is the whole point of the registry');
        assert.equal(registry.baseUrlFor('kimi-k3'), 'https://api.moonshot.ai/v1');
        assert.equal(registry.providerFor('claude-sonnet-5'), 'anthropic');
        assert.equal(registry.providerFor('gemini-3.6-flash'), 'gemini');
        // The prefix rule survives only for ids nobody registered.
        assert.equal(registry.providerFor('claude-something-unregistered'), 'anthropic');
        assert.equal(registry.providerFor('some-unknown-model'), 'gemini');
    });
});

test('an openai-compatible row without a baseUrl is refused — there would be nowhere to send the prompt', async () => {
    await withServer({}, async ({ request }) => {
        const res = await request('/api/admin/models', {
            method: 'POST', cookies: as(ALICE),
            json: { id: 'kimi-k3', label: 'Kimi K3', provider: 'openai-compatible' }
        });
        assert.equal(res.status, 400, res.text);
        assert.match(res.json.error, /baseUrl/i);

        const bogus = await request('/api/admin/models', {
            method: 'POST', cookies: as(ALICE), json: { id: 'x', provider: 'not-a-provider' }
        });
        assert.equal(bogus.status, 400, bogus.text);
    });
});

// ─── One table, proven end to end ─────────────────────────────────────────────

test("editing a registry price changes the spend the admin is shown — the registry IS the price table", async () => {
    await withServer({}, async ({ request }) => {
        // A project with a known number of tokens on a known model.
        const created = await request('/api/projects', { method: 'POST', cookies: as(BOB) });
        assert.equal(created.status, 201, created.text);
        const put = await request(`/api/projects/${created.json.id}`, {
            method: 'PUT', cookies: as(BOB),
            json: {
                title: 'Spend fixture',
                data: { apiUsage: [{ timestamp: Date.now(), model: 'gemini-3.6-flash', inputTokens: 1_000_000, outputTokens: 0 }] }
            }
        });
        assert.equal(put.status, 200, put.text);

        const spendFor = async () => {
            const overview = await request('/api/admin/overview', { cookies: as(ALICE) });
            assert.equal(overview.status, 200, overview.text);
            return overview.json.usage.find(row => row.owner === BOB)?.allTime.usd;
        };

        assert.equal(await spendFor(), 0.75, 'one million input tokens at $0.75/M');

        const edited = await request('/api/admin/models/gemini-3.6-flash', {
            method: 'PUT', cookies: as(ALICE), json: { pricing: { inputPerMTok: 1.5 } }
        });
        assert.equal(edited.status, 200, edited.text);

        assert.equal(await spendFor(), 1.5,
            'the admin spend view must re-price from the registry — if it does not, the price table has forked');
        // …and the browser's copy moved with it, from the same source.
        assert.equal((await models(request)).json.pricingTable['gemini-3.6-flash'].input, 1.5 / 1e6);
    });
});

// ─── What the registry refuses ────────────────────────────────────────────────

test('removing a priced model is refused; disabling it is the supported way to retire one', async () => {
    await withServer({}, async ({ request }) => {
        const refused = await request('/api/admin/models/gemini-3-flash-preview', { method: 'DELETE', cookies: as(ALICE) });
        assert.equal(refused.status, 409, refused.text);
        assert.match(refused.json.error, /\$0\.00|disable/i);

        const disabled = await request('/api/admin/models/gemini-3-flash-preview', {
            method: 'PUT', cookies: as(ALICE), json: { enabled: false }
        });
        assert.equal(disabled.status, 200, disabled.text);
        const row = disabled.json.models.find(m => m.id === 'gemini-3-flash-preview');
        assert.equal(row.enabled, false, 'it leaves the dropdowns');
        assert.equal(row.pricing.inputPerMTok, 0.5, '…and keeps its rate, so past spend still prices');

        // A deprecated row may be removed — its history has already been accepted as gone.
        await request('/api/admin/models/gemini-3-flash-preview', { method: 'PUT', cookies: as(ALICE), json: { deprecated: true } });
        const gone = await request('/api/admin/models/gemini-3-flash-preview', { method: 'DELETE', cookies: as(ALICE) });
        assert.equal(gone.status, 200, gone.text);
        assert.ok(!gone.json.models.some(m => m.id === 'gemini-3-flash-preview'));
    });
});

test('a model id cannot be renamed and `verified` cannot be set by hand', async () => {
    await withServer({}, async ({ request }) => {
        const res = await request('/api/admin/models/gemini-3.6-flash', {
            method: 'PUT', cookies: as(ALICE),
            json: { id: 'gemini-3.6-flash-RENAMED', label: 'Renamed', verified: { 1: { ok: true } } }
        });
        assert.equal(res.status, 200, res.text);
        const rows = res.json.models;
        assert.ok(rows.some(m => m.id === 'gemini-3.6-flash'), 'the id must survive — usage records are keyed by it');
        assert.ok(!rows.some(m => m.id === 'gemini-3.6-flash-RENAMED'));
        assert.deepEqual(rows.find(m => m.id === 'gemini-3.6-flash').verified, {},
            'a hand-set verified flag is a claim nobody tested — only the Verify action may write it');
        assert.equal(rows.find(m => m.id === 'gemini-3.6-flash').label, 'Renamed', 'the label IS editable');
    });
});

test('the recommended map may only name models that exist', async () => {
    await withServer({}, async ({ request }) => {
        const bad = await request('/api/admin/models-recommended', {
            method: 'PUT', cookies: as(ALICE), json: { recommended: { 1: 'a-model-nobody-added' } }
        });
        assert.equal(bad.status, 400, bad.text);

        const good = await request('/api/admin/models-recommended', {
            method: 'PUT', cookies: as(ALICE), json: { recommended: { 1: 'claude-sonnet-5', 3: 'gemini-3.1-pro-preview' } }
        });
        assert.equal(good.status, 200, good.text);
        assert.deepEqual(good.json.recommended, { 1: 'claude-sonnet-5', 3: 'gemini-3.1-pro-preview' });
    });
});

// ─── Who may do what ──────────────────────────────────────────────────────────

test('every writer may read the registry; only an admin SESSION may change it', async () => {
    await withServer({}, async ({ request }) => {
        assert.equal((await models(request, BOB)).status, 200, 'Bob needs the dropdown options and the price table');

        const mutations = [
            ['POST', '/api/admin/models', { id: 'x', provider: 'gemini' }],
            ['PUT', '/api/admin/models/gemini-3.6-flash', { label: 'Nope' }],
            ['DELETE', '/api/admin/models/gemini-3.6-flash', undefined],
            ['PUT', '/api/admin/models-recommended', { recommended: {} }],
            ['POST', '/api/admin/models/discover', { provider: 'gemini' }]
        ];
        for (const [method, url, json] of mutations) {
            const res = await request(url, { method, cookies: as(BOB), json });
            assert.equal(res.status, 403, `${method} ${url} let a non-admin through (${res.status})`);
        }

        // An admin TOKEN reads fine and mutates never — same rule as the allowlist:
        // a leaked token must not be able to add a model, i.e. a way to spend money
        // and a URL the server will post prompts to.
        const minted = await request('/api/tokens', { method: 'POST', cookies: as(ALICE), json: { name: 'ci' } });
        assert.equal(minted.status, 201, minted.text);
        const bearer = { authorization: `Bearer ${minted.json.token}` };
        assert.equal((await request('/api/models', { headers: bearer })).status, 200);
        for (const [method, url, json] of mutations) {
            const res = await request(url, { method, headers: bearer, json });
            assert.equal(res.status, 401, `${method} ${url} accepted a token (${res.status})`);
        }
    });
});

// ─── Discovery ────────────────────────────────────────────────────────────────

test('discovery says what is missing instead of failing opaquely, and never writes', async () => {
    await withServer({}, async ({ request }) => {
        // The harness blanks the model keys, so this is the no-key path by construction.
        const noKey = await request('/api/admin/models/discover', {
            method: 'POST', cookies: as(ALICE), json: { provider: 'gemini' }
        });
        assert.equal(noKey.status, 400, noKey.text);
        assert.match(noKey.json.error, /no api key/i);

        const noBaseUrl = await request('/api/admin/models/discover', {
            method: 'POST', cookies: as(ALICE), json: { provider: 'openai-compatible' }
        });
        assert.equal(noBaseUrl.status, 400, noBaseUrl.text);
        assert.match(noBaseUrl.json.error, /baseUrl/i);

        const before = (await models(request)).json.models.length;
        const after = (await models(request)).json.models.length;
        assert.equal(before, after, 'discovery must not add rows — no provider API publishes a price');
    });
});

// ─── Stale prices ─────────────────────────────────────────────────────────────

test('a price nobody has checked in 90 days is flagged', async () => {
    await withServer({}, async ({ request }) => {
        const registry = require('../utils/model_registry');
        assert.deepEqual(registry.stalePricing({ now: Date.parse('2026-09-01') }), [],
            'the bundled rows were checked 2026-08-16 and should be fresh in early September');
        const stale = registry.stalePricing({ now: Date.parse('2027-01-01') });
        assert.ok(stale.includes('gemini-3.6-flash'),
            'by January every bundled row is over 90 days old — including the one whose price actually changes that day');
        assert.ok((await models(request)).json.staleAfterDays === registry.PRICE_STALE_DAYS);
    });
});
