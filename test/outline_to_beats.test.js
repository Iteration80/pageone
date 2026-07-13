const test = require('node:test');
const assert = require('node:assert/strict');

const { outlineToHybridBeatSheet } = require('../utils/outline_to_beats');
const { STAGE_REVISION_ADAPTERS } = require('../utils/stage_revision_kernel');
const { buildRevisionChecklist } = require('../agents/agent_2_outline');
const { sanitizeOutlineMetaBeats } = require('../utils/outline_sanitizer');

test('outlineToHybridBeatSheet flattens Stage 2 acts into hybrid beat sequences', () => {
    const result = outlineToHybridBeatSheet({
        stc_genre_category: 'Golden Fleece',
        outline: {
            act_1: [{
                sequence_number_and_title: 'Sequence A: The Map',
                beats: [{
                    beat_label: 'Mara Finds the Key',
                    beat_name: 'Catalyst',
                    description: 'Mara discovers the blue key under the flooded arcade cabinet.',
                    emotional_arc: 'Curiosity turns into dread.',
                    pacing_notes: 'Start quiet, then snap into urgency.',
                    genre_variation_notes: 'The quest object is also a warning.'
                }]
            }],
            act_2: [{
                sequence_number_and_title: 'Sequence C: The Locked Pier',
                beats: [{
                    beat_label: 'Crossing the Pier',
                    beat_name: 'Break into Two',
                    description: 'Mara chooses to cross the flooded pier with June.',
                    emotional_arc: 'Hesitation becomes commitment.',
                    pacing_notes: 'Forward motion with a breath at the gate.'
                }]
            }],
            act_3: []
        }
    });

    assert.equal(result.stc_genre_category, 'Golden Fleece');
    assert.equal(result.hybrid_beat_sheet.length, 2);
    assert.equal(result.hybrid_beat_sheet[0].sequence_number, 1);
    assert.equal(result.hybrid_beat_sheet[0].sequence_title, 'The Map');
    assert.deepEqual(result.hybrid_beat_sheet[0].beats[0], {
        beat_title: 'Mara Finds the Key',
        beat_name: 'Catalyst',
        genre_variation_notes: 'The quest object is also a warning.',
        emotional_arc: 'Curiosity turns into dread.',
        pacing_notes: 'Start quiet, then snap into urgency.',
        detailed_action: 'Mara discovers the blue key under the flooded arcade cabinet.'
    });
    assert.equal(result.hybrid_beat_sheet[1].beats[0].beat_title, 'Crossing the Pier');
    assert.equal(result.hybrid_beat_sheet[1].beats[0].beat_name, 'Break into Two');
});

test('outlineToHybridBeatSheet passes legacy outline labels through as STC names', () => {
    const result = outlineToHybridBeatSheet({
        outline: {
            act_1: [{
                sequence_number_and_title: 'Sequence B: No Easy Exit',
                beats: [{
                    beat_label: 'The Door Seals',
                    description: 'The arcade door seals behind Mara.'
                }]
            }],
            act_2: [],
            act_3: []
        }
    });

    const beat = result.hybrid_beat_sheet[0].beats[0];
    assert.equal(beat.beat_title, 'The Door Seals');
    assert.equal(beat.beat_name, 'The Door Seals');
    assert.equal(beat.detailed_action, 'The arcade door seals behind Mara.');
    assert.equal(beat.emotional_arc, '');
    assert.equal(beat.pacing_notes, '');
    assert.equal(beat.genre_variation_notes, '');
});

test('deterministic kernel edits preserve Save the Cat beat annotations', () => {
    const adapter = STAGE_REVISION_ADAPTERS.stage2_outline;
    const outline = {
        act_1: [{
            sequence_number_and_title: 'Sequence A: The Map',
            beats: [{
                beat_label: 'Mara Finds the Key',
                beat_name: 'Catalyst',
                description: 'Mara discovers the blue key under the flooded arcade cabinet.',
                emotional_arc: 'Curiosity turns into dread.',
                pacing_notes: 'Start quiet, then snap into urgency.',
                genre_variation_notes: 'The quest object is also a warning.'
            }]
        }],
        act_2: [],
        act_3: []
    };

    const result = adapter.applyOperation(outline, {
        type: 'replace_beat',
        oldLabel: 'Mara Finds the Key',
        newLabel: 'Mara Finds the Key',
        newBody: 'Mara pries the blue key from the flooded arcade cabinet as the water rises.'
    }, {});

    assert.equal(result.status, 'applied');
    const beat = outline.act_1[0].beats[0];
    assert.equal(beat.description, 'Mara pries the blue key from the flooded arcade cabinet as the water rises.');
    assert.equal(beat.beat_name, 'Catalyst', 'STC function survives a replace_beat edit');
    assert.equal(beat.emotional_arc, 'Curiosity turns into dread.');
    assert.equal(beat.pacing_notes, 'Start quiet, then snap into urgency.');
    assert.equal(beat.genre_variation_notes, 'The quest object is also a warning.');
});

// Regression for 2026-07-13: an upgrade-in-place revision note ("update every
// beat to include beat_name, emotional_arc, pacing_notes" + bracketed per-beat
// examples) was parsed into checklist items, flagged "uncovered" (the coverage
// scan reads beat text, not schema fields), and appended to the outline as
// literal story beats.

test('format/schema directives never become checklist items', () => {
    const notes = [
        'Keep every sequence and every beat exactly as they are.',
        '',
        '[Update Every Beat To Include] beat_name (Save the Cat), emotional_arc, and pacing_notes for the new outline format.',
        '',
        "[Moog Bust] beat_name: 'Set-up', emotional_arc: 'Chaos to Confusion', pacing_notes: 'Kinetic/Action'.",
        '',
        '[The Rally] Dapple reveals his manifesto to hundreds of recruited figments in the warehouse and unveils Elliot in a glass case on stage.'
    ].join('\n');
    const checklist = buildRevisionChecklist(notes);
    for (const item of checklist) {
        assert.ok(!/beat_name|emotional_arc|pacing_notes/i.test(item), `format directive leaked into checklist: "${item}"`);
    }
});

test('sanitizer strips schema-instruction beats but keeps real story beats', () => {
    const outline = {
        outline: {
            act_1: [],
            act_2: [],
            act_3: [{
                sequence_number_and_title: 'Sequence H: A World That Remembers',
                beats: [
                    { beat_label: 'Closing Image - The Photo on the Wall', description: 'The once face-down photo of young Becky and Dapple now hangs framed in the light.' },
                    { beat_label: 'Update Every Beat To Include', description: 'beat_name (Save the Cat), emotional_arc, and pacing_notes.' },
                    { beat_label: 'Moog Bust', description: "beat_name: 'Set-up', emotional_arc: 'Chaos to Confusion', pacing_notes: 'Kinetic/Action'." },
                    { beat_label: 'Pono', description: "beat_name: 'Set-up', emotional_arc: 'Melancholy to Suspicion', pacing_notes: 'Eerie'." }
                ]
            }]
        }
    };
    sanitizeOutlineMetaBeats(outline);
    const labels = outline.outline.act_3[0].beats.map(beat => beat.beat_label);
    assert.deepEqual(labels, ['Closing Image - The Photo on the Wall']);
});

test('outlineToHybridBeatSheet accepts raw outline objects', () => {
    const result = outlineToHybridBeatSheet({
        act_1: [],
        act_2: [],
        act_3: [{
            sequence_number_and_title: 'Sequence H: Sunrise',
            beats: [{ beat: 'Final Image', detailed_action: 'Mara returns the key.' }]
        }]
    });

    assert.equal(result.hybrid_beat_sheet.length, 1);
    assert.equal(result.hybrid_beat_sheet[0].sequence_title, 'Sunrise');
    assert.equal(result.hybrid_beat_sheet[0].beats[0].beat_name, 'Final Image');
    assert.equal(result.hybrid_beat_sheet[0].beats[0].detailed_action, 'Mara returns the key.');
});
