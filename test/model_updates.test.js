const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mu = require('../utils/model_updates');
const { startTestServer } = require('./helpers/route_harness');
const { signSession } = require('../utils/auth');

// Automatic model updates. The rule under test is the one that makes auto-ADDING a
// model safe: a price is written only when two independent sources agree. Fixtures
// are the three real payloads as fetched on 2026-09-25, trimmed to Anthropic and
// Google rows. Guard breaks: agreement rule dropped → the conflict test writes ·
// `:batch` filter dropped → the variants test · latest-per-family dropped → Opus 4.5
// appears in `added` · edited-today rule dropped → the price test overwrites ·
// verified touched → the route test · check route behind plain requireAuth → the
// token test.

const FIXTURES = path.join(__dirname, 'fixtures', 'model-sources');
const BUNDLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'models.json'), 'utf8'));

async function fixtureSources() {
    const { parsed, status } = await mu.loadSources({ fixtureDir: FIXTURES, now: Date.parse('2026-09-25T12:00:00Z') });
    assert.deepEqual(Object.values(status).map(s => s.ok), [true, true, true], JSON.stringify(status));
    return parsed;
}

test('the three parsers map provider ids onto PageOne ids and drop what PageOne must never call', async () => {
    const parsed = await fixtureSources();
    assert.deepEqual(parsed.openrouter.get('claude-opus-5-5'), { inputPerMTok: 4, outputPerMTok: 20, provider: 'anthropic', label: 'Claude Opus 5.5' });
    assert.equal(parsed.openrouter.has('claude-opus-5-5:batch'), false, 'batch variants are dropped');
    assert.equal([...parsed.openrouter.keys()].some(k => k.includes(':')), false);
    assert.deepEqual(parsed.litellm.get('gemini-3.6-flash'), { inputPerMTok: 0.75, outputPerMTok: 3.75, provider: 'gemini', retired: false });
    assert.equal(parsed.litellm.has('gemini-3.8-flash-tts'), false, 'non-chat modes are dropped');
    const docs = parsed['anthropic-docs'].get('claude-sonnet-5');
    assert.equal(docs.inputPerMTok, 2);
    assert.equal(docs.outputPerMTok, 10, 'the footnote superscript must not break the price cell');
    assert.equal(parsed['anthropic-docs'].get('claude-opus-4-1').retired, true);
    assert.equal(parsed['anthropic-docs'].get('claude-mythos-5-1').limited, true);
});

test('agreement: two sources within tolerance write, one source is not enough, disagreement is a conflict', () => {
    const m = (obj) => new Map(Object.entries(obj));
    const { agreed, conflicts, single } = mu.agreePrices({
        openrouter: m({ 'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, provider: 'anthropic' }, 'gemini-9-flash': { inputPerMTok: 1, outputPerMTok: 2, provider: 'gemini' }, 'claude-opus-9': { inputPerMTok: 5, outputPerMTok: 25, provider: 'anthropic' } }),
        litellm: m({ 'claude-opus-5-5': { inputPerMTok: 4.001, outputPerMTok: 20, provider: 'anthropic' }, 'claude-opus-9': { inputPerMTok: 7, outputPerMTok: 35, provider: 'anthropic' } }),
        'anthropic-docs': m({ 'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, provider: 'anthropic' } })
    });
    assert.deepEqual(agreed.get('claude-opus-5-5').agreedBy.sort(), ['anthropic-docs', 'litellm', 'openrouter']);
    assert.equal(agreed.get('claude-opus-5-5').inputPerMTok, 4, 'the first-party value is the one written');
    assert.ok(single.has('gemini-9-flash'), 'one source is not agreement');
    assert.equal(agreed.has('claude-opus-9'), false);
    assert.deepEqual(conflicts.get('claude-opus-9').values.map(v => v.inputPerMTok).sort(), [5, 7], 'a disagreement lists every value and writes nothing');
});

test('eligibility and families: newest per family, chat models only, no Mythos, no dated ids', () => {
    assert.equal(mu.isEligibleForAutoAdd('claude-opus-5-5', {}), true);
    assert.equal(mu.isEligibleForAutoAdd('claude-mythos-5-1', { limited: true }), false);
    assert.equal(mu.isEligibleForAutoAdd('claude-haiku-4-5-20251001', {}), false, 'dated ids are registry spellings, not source spellings');
    assert.equal(mu.isEligibleForAutoAdd('gemini-3.8-flash-tts', {}), false);
    assert.equal(mu.isEligibleForAutoAdd('gemini-3.1-pro-preview', {}), true);
    assert.equal(mu.isEligibleForAutoAdd('claude-opus-4-1', { retired: true }), false);
    assert.equal(mu.familyOf('gemini-3.5-flash-lite'), 'gemini-flash-lite');
    assert.equal(mu.familyOf('gemini-3.8-flash'), 'gemini-flash');
    assert.ok(mu.compareVersions('claude-opus-5-5', 'claude-opus-5') > 0);
    assert.ok(mu.compareVersions('gemini-3.1-pro', 'gemini-3.1-pro-preview') > 0, 'GA outranks preview at the same version');
    assert.ok(mu.compareVersions('gemini-3.1-pro-preview', 'gemini-3-pro') > 0, 'a newer preview outranks an older GA');
});

test('reconcile against a prod-shaped registry: adds the newest of each family, re-prices, links successors, offers a retirement', async () => {
    const parsed = await fixtureSources();
    const registry = {
        models: BUNDLE.models
            .filter(m => m.id !== 'claude-opus-5-5')
            .map(m => (m.id === 'claude-sonnet-5'
                ? { ...m, pricing: { ...m.pricing, inputPerMTok: 3, outputPerMTok: 15, checkedAt: '2026-08-16' } }
                : { ...m, successor: null })),
        recommended: BUNDLE.recommended
    };
    const stageModels = { stage1: 'claude-opus-4-8', stage2: 'claude-opus-4-8', stage3: 'gemini-3.1-pro-preview' };
    const plan = mu.reconcile({ registry, bundle: BUNDLE, parsed, stageModels, now: Date.parse('2026-09-25T12:00:00Z') });

    assert.deepEqual(plan.bundleAdds.map(r => r.id), ['claude-opus-5-5'], 'a bundle row the deployment lacks is merged, price and all');
    const added = plan.added.map(r => r.id).sort();
    assert.ok(added.includes('claude-fable-5-1'), `Fable 5.1 is the newest Fable and three sources agree: ${added}`);
    assert.ok(added.includes('gemini-3.8-flash'), `Gemini 3.8 Flash is the newest Flash: ${added}`);
    assert.equal(added.includes('claude-opus-4-5'), false, 'an older Opus is never added just because a table lists it');
    assert.equal(added.includes('claude-opus-5-5'), false, 'the bundle already supplied it — no duplicate');
    assert.equal(added.includes('claude-mythos-5-1'), false);
    assert.equal(added.some(id => id.includes(':')), false);
    const fable = plan.added.find(r => r.id === 'claude-fable-5-1');
    assert.deepEqual([fable.pricing.inputPerMTok, fable.pricing.outputPerMTok], [10, 50]);
    assert.match(fable.pricing.source, /^auto: .*agree/);
    assert.equal(fable.enabled, true);
    assert.equal(fable.label, 'Claude Fable 5.1');

    assert.deepEqual(plan.priced.map(p => [p.id, p.to.inputPerMTok, p.to.outputPerMTok, p.skipped || null]), [['claude-sonnet-5', 2, 10, null]], 'the stale Sonnet 5 row is re-priced; every other row already agrees');
    assert.ok(plan.successorPatches.some(p => p.id === 'claude-opus-4-8' && p.patch.successor === 'claude-opus-5-5'));
    assert.deepEqual(plan.retirements.map(r => [r.id, r.successor, r.stages, r.autoStages]), [['claude-opus-4-8', 'claude-opus-5-5', ['stage1', 'stage2'], []]]);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.awaitingSecondSource, [], 'nothing newer than the families already have is known to one source only');
});

test('a row checked or edited today is never overwritten by the sources', async () => {
    const parsed = await fixtureSources();
    const today = '2026-09-25';
    const registry = { models: BUNDLE.models.map(m => (m.id === 'claude-sonnet-5' ? { ...m, pricing: { ...m.pricing, inputPerMTok: 9, outputPerMTok: 99, checkedAt: today } } : m)), recommended: {} };
    const plan = mu.reconcile({ registry, bundle: BUNDLE, parsed, now: Date.parse(`${today}T15:00:00Z`) });
    const sonnet = plan.priced.find(p => p.id === 'claude-sonnet-5');
    assert.equal(sonnet.skipped, 'edited today');
});

// ─── Route harness ─────────────────────────────────────────────────────────────

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_EMAILS: 'alice@example.com, bob@example.com',
    SESSION_SECRET: 'test-session-secret',
    OAUTH_BASE_URL: 'https://pageone.test',
    MODEL_UPDATES_FIXTURE_DIR: FIXTURES
};
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const as = email => ({ pageone_session: signSession(email, GOOGLE_ENV.SESSION_SECRET) });

async function withServer(run, env = {}) {
    const server = await startTestServer({ env: { ...GOOGLE_ENV, ...env } });
    try { return await run(server); } finally { await server.close(); }
}

async function mintToken(request, email) {
    const res = await request('/api/tokens', { method: 'POST', cookies: as(email), json: { name: 'script' } });
    assert.equal(res.status, 201, res.text);
    return res.json.token;
}

test('the check route adds agreed models to a real deployment registry, records them as unseen, and never touches Verify results', async () => {
    await withServer(async ({ request, dataRoot }) => {
        // Prod-shaped deployment copy: no Opus 5.5, a stale Sonnet price, one Verify result to protect.
        const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'models.json'), 'utf8'));
        store.models = store.models.filter(m => m.id !== 'claude-opus-5-5').map(m => {
            if (m.id === 'claude-sonnet-5') return { ...m, pricing: { ...m.pricing, inputPerMTok: 3, outputPerMTok: 15, checkedAt: '2026-08-16' }, verified: { 1: { ok: true, at: 1, by: ALICE } } };
            return m;
        });
        fs.writeFileSync(path.join(dataRoot, 'models.json'), JSON.stringify(store, null, 2));

        const before = await request('/api/admin/models/updates', { cookies: as(ALICE) });
        assert.equal(before.status, 200, before.text);
        assert.equal(before.json.lastCheckedAt, null, 'nothing has run — the harness keeps the boot check off');

        const res = await request('/api/admin/models/updates/check', { method: 'POST', cookies: as(ALICE), json: {} });
        assert.equal(res.status, 200, res.text);
        assert.ok(res.json.applied.added.includes('claude-opus-5-5'), 'bundle row merged');
        assert.ok(res.json.applied.added.includes('claude-fable-5-1'), 'agreed new model added');
        assert.ok(res.json.applied.priced.includes('claude-sonnet-5'));
        assert.deepEqual(res.json.applied.errors, []);

        const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, 'models.json'), 'utf8'));
        const fable = onDisk.models.find(m => m.id === 'claude-fable-5-1');
        assert.deepEqual([fable.pricing.inputPerMTok, fable.pricing.outputPerMTok], [10, 50]);
        assert.deepEqual(fable.verified, {}, 'an added row starts unverified');
        const sonnet = onDisk.models.find(m => m.id === 'claude-sonnet-5');
        assert.deepEqual([sonnet.pricing.inputPerMTok, sonnet.pricing.outputPerMTok], [2, 10]);
        assert.deepEqual(sonnet.verified, { 1: { ok: true, at: 1, by: ALICE, error: null } }, 'a price refresh must not touch Verify');
        assert.equal(onDisk.models.find(m => m.id === 'claude-opus-4-8').successor, 'claude-opus-5-5', 'successor links merged from the bundle');

        // The registry the dropdowns read now offers the new rows.
        const models = await request('/api/models', { cookies: as(BOB) });
        assert.ok(models.json.models.some(m => m.id === 'claude-fable-5-1' && m.enabled));

        // Unseen until acknowledged; acknowledged clears the list but keeps the rows.
        const after = await request('/api/admin/models/updates', { cookies: as(ALICE) });
        assert.ok(after.json.unacknowledged.added.map(a => a.id).includes('claude-fable-5-1'));
        assert.ok(after.json.unacknowledged.priced.map(p => p.id).includes('claude-sonnet-5'));
        const ack = await request('/api/admin/models/updates/acknowledge', { method: 'POST', cookies: as(ALICE), json: {} });
        assert.equal(ack.status, 200);
        const cleared = await request('/api/admin/models/updates', { cookies: as(ALICE) });
        assert.deepEqual(cleared.json.unacknowledged, { added: [], priced: [] });
        assert.ok(JSON.parse(fs.readFileSync(path.join(dataRoot, 'models.json'), 'utf8')).models.some(m => m.id === 'claude-fable-5-1'));

        // Running it again is a no-op — nothing new, nothing re-added.
        const again = await request('/api/admin/models/updates/check', { method: 'POST', cookies: as(ALICE), json: {} });
        assert.deepEqual(again.json.applied.added, []);
        assert.deepEqual(again.json.applied.priced, []);
    });
});

test('retirements are offered from the live defaults, and the check is session-only', async () => {
    await withServer(async ({ request }) => {
        await request('/api/admin/models/updates/check', { method: 'POST', cookies: as(ALICE), json: {} });
        const set = await request('/api/settings', { method: 'POST', cookies: as(ALICE), json: { stageModels: { stage1: 'claude-opus-4-8', stage2: 'claude-opus-4-8' } } });
        assert.equal(set.status, 200, set.text);
        const state = await request('/api/admin/models/updates', { cookies: as(ALICE) });
        assert.deepEqual(state.json.retirements.map(r => [r.id, r.successor, r.stages]), [['claude-opus-4-8', 'claude-opus-5-5', ['stage1', 'stage2']]]);

        const token = await mintToken(request, ALICE);
        const viaToken = await request('/api/admin/models/updates/check', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, json: {} });
        assert.equal(viaToken.status, 401, 'a token must not be able to write registry rows');
        const bob = await request('/api/admin/models/updates/check', { method: 'POST', cookies: as(BOB), json: {} });
        assert.equal(bob.status, 403);
        const bobReads = await request('/api/admin/models/updates', { cookies: as(BOB) });
        assert.equal(bobReads.status, 403);
        const readViaToken = await request('/api/admin/models/updates', { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(readViaToken.status, 200, 'an admin token may read, like the overview');
    });
});

test('with fewer than two sources answering, nothing is written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pageone-one-source-'));
    fs.copyFileSync(path.join(FIXTURES, 'openrouter.json'), path.join(dir, 'openrouter.json'));
    try {
        await withServer(async ({ request }) => {
            const res = await request('/api/admin/models/updates/check', { method: 'POST', cookies: as(ALICE), json: {} });
            assert.equal(res.status, 200, res.text);
            assert.equal(res.json.plan.tooFewSources, true);
            assert.deepEqual(res.json.applied.added, [], 'nothing from the sources, and the bundle is already the deployment copy here');
            assert.deepEqual(res.json.applied.priced, []);
            assert.equal(res.json.sources.openrouter.ok, true);
            assert.equal(res.json.sources.litellm.ok, false);
        }, { MODEL_UPDATES_FIXTURE_DIR: dir });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
