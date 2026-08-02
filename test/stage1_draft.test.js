const { test } = require('node:test');
const assert = require('node:assert');

const {
    STAGE1_DRAFT_KEY,
    readStage1Draft,
    applyStage1DraftPatch,
    clearStage1Draft,
} = require('../utils/stage1_draft');

// Regression suite for the 2026-07-30 finding, fixed 2026-08-02: visible Stage 1
// persisted nothing until a pitch was selected. The typed idea and the three
// generated options lived only in browser memory, while the generation had already
// been billed and written to apiUsage — so a click on Home threw away paid work.
//
// ⚠️ Every test round-trips through JSON deliberately. The draft is written by one
// request (the debounced idea save) and read back by another (project open), so
// asserting on the in-memory object would test a path production never takes.

const save = project => JSON.parse(JSON.stringify(project));

const OPTIONS = [
    { title: 'MIRAGE BEND', genre: 'Neo-noir', logline: 'A water inspector goes home.' },
    { title: 'TWO SUMMERS LEFT', genre: 'Drama', logline: 'A reservoir runs dry.' },
    { title: 'THE DRYING COVENANT', genre: 'Thriller', logline: 'Eleven years of lies.' },
];

const freshProject = () => ({ id: '1785433824227', data: { knowledge: {}, apiUsage: [] } });

test('generated pitch options survive a save/reload', () => {
    const project = applyStage1DraftPatch(freshProject(), {
        idea: 'A town poisons its own reservoir.',
        pitchOptions: OPTIONS,
        generatedAt: '2026-08-02T10:00:00.000Z',
    });

    const draft = readStage1Draft(save(project).data);
    assert.equal(draft.pitch_options.length, 3);
    assert.equal(draft.pitch_options[0].title, 'MIRAGE BEND');
    assert.equal(draft.idea, 'A town poisons its own reservoir.');
    assert.equal(draft.generated_at, '2026-08-02T10:00:00.000Z');
});

test('the idea alone is worth saving, before anything has been generated', () => {
    const project = applyStage1DraftPatch(freshProject(), { idea: 'Half a thought, typed and abandoned.' });

    const draft = readStage1Draft(save(project).data);
    assert.equal(draft.idea, 'Half a thought, typed and abandoned.');
    assert.deepEqual(draft.pitch_options, []);
});

test('a later idea keystroke does not erase already-generated options', () => {
    // The two writes are independent requests: the debounced idea save must not
    // clobber the options the generation route wrote, or vice versa.
    let project = applyStage1DraftPatch(freshProject(), { idea: 'first', pitchOptions: OPTIONS });
    project = applyStage1DraftPatch(save(project), { idea: 'first, revised' });

    const draft = readStage1Draft(save(project).data);
    assert.equal(draft.idea, 'first, revised');
    assert.equal(draft.pitch_options.length, 3);
});

test('regenerating with no idea text keeps the new options', () => {
    // Generating with an empty box is a real path — it produces random pitches.
    let project = applyStage1DraftPatch(freshProject(), { idea: 'something' });
    project = applyStage1DraftPatch(save(project), { idea: '', pitchOptions: OPTIONS });

    const draft = readStage1Draft(save(project).data);
    assert.equal(draft.idea, '');
    assert.equal(draft.pitch_options.length, 3);
});

test('a malformed options payload leaves the saved options alone', () => {
    let project = applyStage1DraftPatch(freshProject(), { idea: 'keep me', pitchOptions: OPTIONS });
    for (const junk of [null, undefined, [], 'three pitches', [null, 7, 'x']]) {
        project = applyStage1DraftPatch(save(project), { pitchOptions: junk });
        const draft = readStage1Draft(save(project).data);
        assert.equal(draft.pitch_options.length, 3, `lost the options on ${JSON.stringify(junk)}`);
    }
});

test('selecting a pitch clears the draft', () => {
    const project = applyStage1DraftPatch(freshProject(), { idea: 'x', pitchOptions: OPTIONS });
    clearStage1Draft(project);

    const reloaded = save(project);
    assert.equal(STAGE1_DRAFT_KEY in reloaded.data, false);
    assert.equal(readStage1Draft(reloaded.data), null);
});

test('an empty draft is removed rather than left as a husk', () => {
    const project = applyStage1DraftPatch(freshProject(), { idea: 'typed then deleted' });
    applyStage1DraftPatch(project, { idea: '   ' });

    assert.equal(STAGE1_DRAFT_KEY in save(project).data, false);
});

test('readStage1Draft tolerates absent, empty and malformed data', () => {
    assert.equal(readStage1Draft(undefined), null);
    assert.equal(readStage1Draft({}), null);
    assert.equal(readStage1Draft({ [STAGE1_DRAFT_KEY]: null }), null);
    assert.equal(readStage1Draft({ [STAGE1_DRAFT_KEY]: 'nonsense' }), null);
    assert.equal(readStage1Draft({ [STAGE1_DRAFT_KEY]: [] }), null);
    assert.equal(readStage1Draft({ [STAGE1_DRAFT_KEY]: { idea: 42 } }), null);
});

test('the draft is scratch state, not a stage artifact', () => {
    // It must stay out of the staleness tracker and the snapshot registry —
    // it carries no _meta, must never go stale, and must never enter version history.
    const { STAGE_ORDER } = require('../utils/stageMetadata');
    assert.equal(STAGE_ORDER.includes(STAGE1_DRAFT_KEY), false);

    const { stageConfig } = require('../utils/artifact_snapshots');
    if (typeof stageConfig === 'function') {
        assert.equal(stageConfig(STAGE1_DRAFT_KEY), undefined);
    }
});

test('the attachment name rides along, and blanks out cleanly', () => {
    let project = applyStage1DraftPatch(freshProject(), { idea: 'x', attachmentName: 'treatment.pdf' });
    assert.equal(readStage1Draft(save(project).data).attachment_name, 'treatment.pdf');

    project = applyStage1DraftPatch(save(project), { attachmentName: null });
    assert.equal(readStage1Draft(save(project).data).attachment_name, null);
});

test('a patch touching nothing preserves the whole draft', () => {
    const project = applyStage1DraftPatch(freshProject(), { idea: 'x', pitchOptions: OPTIONS });
    const before = save(project).data[STAGE1_DRAFT_KEY];

    applyStage1DraftPatch(project, {});
    assert.deepEqual(save(project).data[STAGE1_DRAFT_KEY], before);
});
