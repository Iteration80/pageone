const { test } = require('node:test');
const assert = require('node:assert');

const {
    stampGenerated,
    stampRevised,
    getRevisedUpstreamStages,
    readStageMeta,
    writeStageMeta,
} = require('../utils/stageMetadata');

// Regression suite for the 2026-08-01 finding: `stage6_scenes` (visible Stage 5,
// Scene Blueprint) is stored as a bare ARRAY of sequences, and JSON.stringify
// serializes only an array's INDEX properties. So `blueprint._meta = {...}` was set
// in memory and silently dropped on the next save — every stamp for the blueprint
// was thrown away, and visible Stage 5 could never be marked stale.
//
// ⚠️ Every test here round-trips through JSON deliberately. Asserting on the
// in-memory object passes even with the bug present; the whole defect lives in the
// gap between "assigned" and "persisted", so a test that never saves cannot see it.

const save = project => JSON.parse(JSON.stringify(project));

function projectWithBlueprint() {
    return {
        data: {
            stage2_outline: { outline: {} },
            stage3_characters: { characters: [] },
            stage5_treatment: { act_1: 'act one' },
            stage6_scenes: [{ sequence_number: 1, scenes: [{ scene_number: 1 }] }],
            stage7_style: { directive: 'noir' },
        },
    };
}

test('a generated blueprint keeps its stamp across a save', () => {
    const project = projectWithBlueprint();
    stampGenerated(project, 'stage6_scenes');
    const reloaded = save(project);
    const meta = readStageMeta(reloaded, 'stage6_scenes');
    assert.ok(meta, 'blueprint metadata must survive JSON serialization');
    assert.ok(typeof meta.generated_at === 'number');
    assert.strictEqual(meta.stale, false);
});

test('revising an upstream stage marks the blueprint stale, and it survives a save', () => {
    const project = projectWithBlueprint();
    stampGenerated(project, 'stage6_scenes');
    stampGenerated(project, 'stage7_style');
    // The writer goes back and revises the Treatment after building the blueprint.
    stampRevised(project, 'stage5_treatment');

    const reloaded = save(project);
    assert.strictEqual(readStageMeta(reloaded, 'stage6_scenes')?.stale, true,
        'blueprint must be flagged stale — this is the badge/banner the writer sees');
    assert.strictEqual(readStageMeta(reloaded, 'stage7_style')?.stale, true,
        'object-valued stages keep working exactly as before');
});

test('the blueprint still carries generated_at after being marked stale', () => {
    const project = projectWithBlueprint();
    stampGenerated(project, 'stage6_scenes');
    const generatedAt = readStageMeta(project, 'stage6_scenes').generated_at;
    stampRevised(project, 'stage2_outline');
    const meta = readStageMeta(save(project), 'stage6_scenes');
    assert.strictEqual(meta.generated_at, generatedAt, 'provenance must not be lost when staleness is stamped');
    assert.strictEqual(meta.stale, true);
});

test('a manually revised blueprint reports itself to downstream stages after a save', () => {
    const project = projectWithBlueprint();
    stampRevised(project, 'stage6_scenes');
    const reloaded = save(project);
    assert.ok(readStageMeta(reloaded, 'stage6_scenes')?.manually_revised_at,
        'blueprint revision timestamp must persist');
    assert.deepStrictEqual(
        getRevisedUpstreamStages(reloaded, 'stage7_style'),
        ['stage6_scenes'],
        'SOURCE_AUTHORITY for downstream stages must see the revised blueprint'
    );
});

test('object-valued stages keep their metadata INLINE (no migration, no behaviour change)', () => {
    const project = projectWithBlueprint();
    stampGenerated(project, 'stage5_treatment');
    const reloaded = save(project);
    assert.ok(reloaded.data.stage5_treatment._meta, 'must still be inline for object stages');
    assert.strictEqual(reloaded.data.stage_meta?.stage5_treatment, undefined,
        'object stages must not be diverted to the sibling map');
});

test('an existing project with inline metadata is read unchanged', () => {
    // Backwards compatibility: projects saved before this fix carry inline _meta.
    const legacy = { data: { stage5_treatment: { act_1: 'x', _meta: { generated_at: 1, stale: true } } } };
    assert.strictEqual(readStageMeta(legacy, 'stage5_treatment').stale, true);
});

test('writeStageMeta is a no-op for a stage that does not exist', () => {
    const project = { data: {} };
    writeStageMeta(project, 'stage6_scenes', { stale: true });
    assert.strictEqual(project.data.stage_meta, undefined);
    assert.strictEqual(readStageMeta(project, 'stage6_scenes'), undefined);
});
