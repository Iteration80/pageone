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

// Round 3 (2026-07-13): process instructions phrased WITHOUT schema tokens
// ("Tighten all beat descriptions...", "Preserve all sequence titles...") were
// still fabricated as beats. Pin the broader outline-machinery heuristic.
test('outline-machinery instructions never become checklist items or beats', () => {
    const notes = [
        'Run the format upgrade again.',
        '',
        'Tighten all beat descriptions to lean outline language of eighty words or fewer.',
        '',
        'Preserve all sequence titles, beat labels, and the existing beat order exactly.'
    ].join('\n');
    for (const item of buildRevisionChecklist(notes)) {
        assert.ok(!/beat descriptions|sequence titles|beat labels|lean outline/i.test(item), `process directive leaked into checklist: "${item}"`);
    }

    const outline = {
        outline: {
            act_1: [], act_2: [],
            act_3: [{
                sequence_number_and_title: 'Sequence H: A World That Remembers',
                beats: [
                    { beat_label: 'Closing Image - The Photo on the Wall', description: 'The photo hangs framed in the light.' },
                    { beat_label: 'Tighten All Beat Descriptions To Lean Outline', description: 'Tighten all beat descriptions to lean outline language of eighty words or fewer.' },
                    { beat_label: 'Preserve All Sequence Titles Beat Labels And', description: 'Preserve all sequence titles, beat labels, and the existing beat order exactly.' }
                ]
            }]
        }
    };
    sanitizeOutlineMetaBeats(outline);
    assert.deepEqual(outline.outline.act_3[0].beats.map(b => b.beat_label), ['Closing Image - The Photo on the Wall']);
});

test('duplicate same-label beats collapse to the annotated copy', async () => {
    const { agent2Outline } = require('../agents/agent_2_outline');
    const currentOutline = {
        act_1: [{
            sequence_number_and_title: 'Sequence E: The Wound Beneath the Suit',
            beats: [{ beat_label: 'Aftermath - A Quiet Reckoning', description: 'OLD long diner description with many extra words.' }]
        }],
        act_2: [], act_3: []
    };
    // Model result contains the same beat twice (as the safeguards produced on 07-13).
    const modelResult = {
        title: 'T', genre: 'G', logline: 'L', stc_genre_category: 'Superhero',
        outline: {
            act_1: [{
                sequence_number_and_title: 'Sequence E: The Wound Beneath the Suit',
                beats: [
                    { beat_label: 'Aftermath - A Quiet Reckoning', description: 'OLD long diner description with many extra words.' },
                    { beat_label: 'Aftermath - A Quiet Reckoning', description: 'NEW tightened diner beat.', beat_name: 'Bad Guys Close In', emotional_arc: 'Flaw resurfaces.', pacing_notes: 'Quiet, aching.' }
                ]
            }],
            act_2: [], act_3: []
        }
    };
    const { result } = await agent2Outline({ title: 'T', genre: 'G', logline: 'L' }, currentOutline, 'Tighten the diner beat.', null, {
        model: 'gemini-test', geminiApiKey: 'x',
        generateContentFn: async () => ({ text: JSON.stringify(modelResult), usage: {} })
    });
    const beats = result.outline.act_1[0].beats.filter(b => /Quiet Reckoning/.test(b.beat_label));
    assert.equal(beats.length, 1, 'same-label duplicates collapse');
    assert.equal(beats[0].beat_name, 'Bad Guys Close In', 'the annotated copy wins');
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

// Regression for 2026-07-13 (round 2): a beat-naming revision brief armed the
// scoped-merge safeguard, whose cloneBeat stripped every STC annotation the
// model had just added — the schema upgrade saved with zero annotations.
test('scoped-merge safeguard preserves model-supplied STC annotations', async () => {
    const { agent2Outline } = require('../agents/agent_2_outline');
    const currentOutline = {
        act_1: [{
            sequence_number_and_title: 'Sequence A: The Invisible World',
            beats: [
                { beat_label: 'The Moog Bust - A Repeat Offender', description: 'OLD long Moog description.' },
                { beat_label: 'Meet Rebecca - The Skeptic Mom', description: 'OLD Rebecca description.' },
                { beat_label: 'Pono at the Fence', description: 'OLD Pono description untargeted by the brief.' }
            ]
        }],
        act_2: [], act_3: []
    };
    const modelResult = {
        title: 'T', genre: 'G', logline: 'L', stc_genre_category: 'Superhero',
        outline: {
            act_1: [{
                sequence_number_and_title: 'Sequence A: The Invisible World',
                beats: [
                    { beat_label: 'The Moog Bust - A Repeat Offender', description: 'NEW tight Moog description.', beat_name: 'Set-Up', emotional_arc: 'Chaos to grief.', pacing_notes: 'Kinetic.' },
                    { beat_label: 'Meet Rebecca - The Skeptic Mom', description: 'NEW tight Rebecca description.', beat_name: 'Set-Up', emotional_arc: 'Love vs fear.', pacing_notes: 'Domestic hush.' },
                    { beat_label: 'Pono at the Fence', description: 'NEW Pono text.', beat_name: 'Debate', emotional_arc: 'Temptation refused.', pacing_notes: 'Eerie.' }
                ]
            }],
            act_2: [], act_3: []
        }
    };
    // Brief shape that arms the scoped-merge safeguard: bracketed labels naming
    // specific beats (exactly how the assistant writes revision briefs).
    const notes = 'Update the outline to the new format. [The Moog Bust - A Repeat Offender] and [Meet Rebecca - The Skeptic Mom] keep their events but tighten descriptions and add beat_name, emotional_arc, pacing_notes.';
    const { result } = await agent2Outline({ title: 'T', genre: 'G', logline: 'L' }, currentOutline, notes, null, {
        model: 'gemini-test', geminiApiKey: 'x',
        generateContentFn: async () => ({ text: JSON.stringify(modelResult), usage: {} })
    });
    const beats = result.outline.act_1[0].beats;
    for (const beat of beats) {
        assert.ok(beat.beat_name, `annotations must survive the safeguards on [${beat.beat_label}]`);
        assert.ok(beat.emotional_arc, `emotional_arc must survive on [${beat.beat_label}]`);
    }
    const moog = beats.find(b => b.beat_label === 'The Moog Bust - A Repeat Offender');
    assert.equal(moog.description, 'NEW tight Moog description.', 'targeted beat takes the revised text');
    assert.equal(moog.beat_name, 'Set-Up');
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
