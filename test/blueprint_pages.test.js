const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { sumScenePages, deriveBlueprintPageCounts, blueprintTotalPages } = require('../utils/blueprint_pages');

// Regression for 2026-07-15: total_estimated_pages was a model-generated
// required field — i.e. the LLM was asked to do arithmetic. On the real
// I.M.A.G.I.N.E. blueprint ALL 8 sequences disagreed with the sum of their own
// scenes, overstating the film by 14.5 pages (159.5 declared vs 145.0 actual).

test('sequence page totals are derived from scenes, overriding whatever the model claimed', () => {
    // The exact shape of the observed bug: a sequence claiming more than its scenes.
    const sequences = [
        { sequence_title: 'The Invisible World', total_estimated_pages: 24.5, scenes: [{ estimated_page_count: 2.5 }, { estimated_page_count: 2 }, { estimated_page_count: 3 }] },
        { sequence_title: 'The Bonded Key', total_estimated_pages: 11.5, scenes: [{ estimated_page_count: 1 }, { estimated_page_count: 1.5 }] }
    ];
    deriveBlueprintPageCounts(sequences);
    assert.equal(sequences[0].total_estimated_pages, 7.5, 'model claim of 24.5 replaced by the real sum');
    assert.equal(sequences[1].total_estimated_pages, 2.5, 'model claim of 11.5 replaced by the real sum');
    assert.equal(blueprintTotalPages(sequences), 10, 'feature total reconciles');
});

test('derived totals always equal the sum of their scenes (the invariant that broke)', () => {
    const sequences = [
        { total_estimated_pages: 99, scenes: [{ estimated_page_count: 1.25 }, { estimated_page_count: 2.5 }, { estimated_page_count: 0.8 }] },
        { total_estimated_pages: 0, scenes: [{ estimated_page_count: 3 }] }
    ];
    deriveBlueprintPageCounts(sequences);
    for (const sequence of sequences) {
        const trueSum = sequence.scenes.reduce((s, sc) => s + sc.estimated_page_count, 0);
        assert.ok(Math.abs(sequence.total_estimated_pages - trueSum) < 0.05,
            `declared ${sequence.total_estimated_pages} must equal scene sum ${trueSum}`);
    }
});

test('page arithmetic survives junk values without producing NaN', () => {
    assert.equal(sumScenePages([{ estimated_page_count: 2 }, { estimated_page_count: 'oops' }, {}, { estimated_page_count: -5 }, { estimated_page_count: 1.5 }]), 3.5);
    assert.equal(sumScenePages([]), 0);
    assert.equal(sumScenePages(null), 0);
    assert.equal(sumScenePages(undefined), 0);
    // Float noise must not leak into the document (24.499999999999996).
    assert.equal(sumScenePages([{ estimated_page_count: 0.1 }, { estimated_page_count: 0.2 }]), 0.3);
});

test('derivation tolerates malformed sequences instead of throwing', () => {
    const sequences = [null, { scenes: null }, 'nonsense', { scenes: [{ estimated_page_count: 2 }] }];
    assert.doesNotThrow(() => deriveBlueprintPageCounts(sequences));
    assert.equal(sequences[3].total_estimated_pages, 2);
    assert.equal(deriveBlueprintPageCounts(null), null);
});

// ─── Source guards: the model must not own this arithmetic again ─────────────

test('Stage 6 agents derive page totals and do not require them from the model', () => {
    for (const file of ['agent_6_scenes.js', 'agent_6_revise.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', 'agents', file), 'utf8');
        assert.ok(source.includes('deriveBlueprintPageCounts'), `${file} must derive page totals`);
        assert.ok(!/required:\s*\[[^\]]*'total_estimated_pages'/.test(source),
            `${file} must not require total_estimated_pages from the model — code derives it`);
    }
});
