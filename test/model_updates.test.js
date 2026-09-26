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
const REAL_BUNDLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'models.json'), 'utf8'));
// The rows the sources would discover on 2026-09-25 — stripped from the bundle in
// these tests so the "discover" path is what gets exercised, not the bundle merge.
const SOURCE_DISCOVERED = ['claude-fable-5-1', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];
const BUNDLE = { ...REAL_BUNDLE, models: REAL_BUNDLE.models.filter(m => !SOURCE_DISCOVERED.includes(m.id)) };

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

// ─── The CLI (what a Claude Code session runs) and the boot-time bundle merge ────
//
// Since 2026-09-26 the app never fetches the sources: `npm run models:check` does,
// against whatever DATA_ROOT points at (locally, the bundle itself). The app only
// merges the bundle at boot (`bundleOnly`). Both are exercised in a child process
// so DATA_ROOT is bound fresh.

const { execFileSync } = require('child_process');

function tempStore(mutate = store => store) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pageone-models-check-'));
    const store = JSON.parse(JSON.stringify(BUNDLE));
    fs.writeFileSync(path.join(dataRoot, 'models.json'), JSON.stringify(mutate(store), null, 2));
    return dataRoot;
}

function runCli(dataRoot, args = [], extraEnv = {}) {
    return execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'models-check.js'), ...args], {
        env: { ...process.env, DATA_ROOT: dataRoot, MODEL_UPDATES_FIXTURE_DIR: FIXTURES, ...extraEnv },
        encoding: 'utf8'
    });
}

test('npm run models:check adds agreed models and re-prices, and never touches a Verify result', () => {
    const dataRoot = tempStore(store => {
        store.models = store.models.filter(m => m.id !== 'claude-opus-5-5').map(m => (m.id === 'claude-sonnet-5'
            ? { ...m, pricing: { ...m.pricing, inputPerMTok: 3, outputPerMTok: 15, checkedAt: '2026-08-16' }, verified: { 1: { ok: true, at: 1, by: 'alice@example.com' } } }
            : m));
        return store;
    });
    try {
        const dry = runCli(dataRoot, ['--dry-run']);
        assert.match(dry, /would add/);
        const untouched = JSON.parse(fs.readFileSync(path.join(dataRoot, 'models.json'), 'utf8'));
        assert.equal(untouched.models.some(m => m.id === 'claude-fable-5-1'), false, '--dry-run writes nothing');

        const out = runCli(dataRoot);
        assert.match(out, /claude-fable-5-1/, 'named under whichever heading it arrived — bundle or sources');
        const after = JSON.parse(fs.readFileSync(path.join(dataRoot, 'models.json'), 'utf8'));
        assert.ok(after.models.some(m => m.id === 'claude-opus-5-5'), 'bundle row merged');
        const fable = after.models.find(m => m.id === 'claude-fable-5-1');
        assert.deepEqual([fable.pricing.inputPerMTok, fable.pricing.outputPerMTok], [10, 50]);
        assert.deepEqual(fable.verified, {});
        const sonnet = after.models.find(m => m.id === 'claude-sonnet-5');
        assert.deepEqual([sonnet.pricing.inputPerMTok, sonnet.pricing.outputPerMTok], [2, 10]);
        assert.deepEqual(sonnet.verified, { 1: { ok: true, at: 1, by: 'alice@example.com', error: null } }, 'a price refresh must not touch Verify');
        assert.equal(after.models.find(m => m.id === 'claude-opus-4-8').successor, 'claude-opus-5-5');
        assert.equal(after.models.find(m => m.id === 'claude-opus-5-5').order, 1, 'display order merged from the bundle');

        const again = runCli(dataRoot);
        assert.match(again, /New models with an agreed price \(added\): none/);
        assert.match(again, /Bundle rows missing on this store: none/, 'idempotent');
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('with fewer than two sources answering, the CLI writes nothing and says so', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pageone-one-source-'));
    fs.copyFileSync(path.join(FIXTURES, 'openrouter.json'), path.join(dir, 'openrouter.json'));
    const dataRoot = tempStore();
    try {
        let out = '';
        let code = 0;
        try { out = runCli(dataRoot, [], { MODEL_UPDATES_FIXTURE_DIR: dir }); } catch (err) { out = String(err.stdout || ''); code = err.status; }
        assert.equal(code, 2);
        assert.match(out, /Fewer than two sources answered/);
        const after = JSON.parse(fs.readFileSync(path.join(dataRoot, 'models.json'), 'utf8'));
        const bundleIds = new Set(REAL_BUNDLE.models.map(m => m.id));
        assert.ok(after.models.every(m => bundleIds.has(m.id)), 'nothing arrived from a single source — only the bundle merge may run');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('the boot-time merge is bundle-only: no source is read, bundle rows and links arrive, nothing is added from the internet', async () => {
    const dataRoot = tempStore(store => {
        store.models = store.models.filter(m => m.id !== 'claude-opus-5-5').map(m => ({ ...m, successor: null, order: null }));
        return store;
    });
    try {
        const out = execFileSync(process.execPath, ['-e', `
            const mu = require(${JSON.stringify(path.join(__dirname, '..', 'utils', 'model_updates.js'))});
            mu.checkForUpdates({ apply: true, bundleOnly: true, fetchImpl: () => { throw new Error('NETWORK TOUCHED'); } })
              .then(({ plan, applied }) => console.log(JSON.stringify({ bundleOnly: plan.bundleOnly, added: applied.added, priced: applied.priced, patched: applied.successorPatches.length, tooFew: plan.tooFewSources })))
              .catch(err => { console.error(err.message); process.exit(1); });
        `], { env: { ...process.env, DATA_ROOT: dataRoot, MODEL_UPDATES_FIXTURE_DIR: '' }, encoding: 'utf8' });
        const result = JSON.parse(out.trim().split('\n').pop());
        assert.equal(result.bundleOnly, true);
        assert.equal(result.tooFew, false, 'bundle-only is not a failed source check');
        const bundleIds = new Set(REAL_BUNDLE.models.map(m => m.id));
        assert.ok(result.added.includes('claude-opus-5-5'));
        assert.ok(result.added.every(id => bundleIds.has(id)), `only bundle rows: ${result.added}`);
        assert.deepEqual(result.priced, []);
        assert.ok(result.patched >= 8, `successor/order links merged: ${result.patched}`);
        const after = JSON.parse(fs.readFileSync(path.join(dataRoot, 'models.json'), 'utf8'));
        assert.ok(after.models.every(m => bundleIds.has(m.id)), 'no row outside the bundle');
        assert.equal(after.models.find(m => m.id === 'claude-opus-4-8').successor, 'claude-opus-5-5');
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
