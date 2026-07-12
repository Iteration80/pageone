const test = require('node:test');
const assert = require('node:assert/strict');

const { outlineToHybridBeatSheet } = require('../utils/outline_to_beats');

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
