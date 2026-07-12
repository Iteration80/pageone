const ACT_KEYS = ['act_1', 'act_2', 'act_3'];

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeOutlinePayload(stage2Outline = {}) {
    if (!stage2Outline || typeof stage2Outline !== 'object') return {};
    if (stage2Outline.outline && typeof stage2Outline.outline === 'object' && !Array.isArray(stage2Outline.outline)) {
        return stage2Outline;
    }
    return { outline: stage2Outline };
}

function sequenceTitle(sequence = {}, fallbackNumber = 1) {
    const raw = String(sequence.sequence_title || sequence.sequence_number_and_title || `Sequence ${fallbackNumber}`).trim();
    const withoutPrefix = raw.replace(/^\s*sequence\s*(?:[A-H]|\d+)\s*[:.-]\s*/i, '').trim();
    return withoutPrefix || raw || `Sequence ${fallbackNumber}`;
}

function flattenOutlineSequences(outline = {}) {
    const sequences = [];
    for (const actKey of ACT_KEYS) {
        const act = Array.isArray(outline[actKey]) ? outline[actKey] : [];
        for (const sequence of act) {
            if (sequence && typeof sequence === 'object') sequences.push(sequence);
        }
    }
    return sequences;
}

function outlineToHybridBeatSheet(stage2Outline = {}) {
    const payload = normalizeOutlinePayload(stage2Outline);
    const outline = payload.outline || {};
    const hybrid_beat_sheet = flattenOutlineSequences(outline).map((sequence, sequenceIndex) => ({
        sequence_number: sequenceIndex + 1,
        sequence_title: sequenceTitle(sequence, sequenceIndex + 1),
        beats: (Array.isArray(sequence.beats) ? sequence.beats : []).map((beat, beatIndex) => {
            const beatTitle = String(beat?.beat_label || beat?.beat_title || beat?.beat || beat?.beat_name || `Beat ${beatIndex + 1}`).trim();
            const stcName = String(beat?.beat_name || beatTitle || `Beat ${beatIndex + 1}`).trim();
            return {
                beat_title: beatTitle,
                beat_name: stcName,
                genre_variation_notes: String(beat?.genre_variation_notes || '').trim(),
                emotional_arc: String(beat?.emotional_arc || '').trim(),
                pacing_notes: String(beat?.pacing_notes || '').trim(),
                detailed_action: String(beat?.description || beat?.detailed_action || '').trim()
            };
        })
    }));

    return {
        stc_genre_category: String(payload.stc_genre_category || '').trim(),
        hybrid_beat_sheet,
        derived_from: 'stage2_outline'
    };
}

module.exports = {
    outlineToHybridBeatSheet,
    flattenOutlineSequences,
    normalizeOutlinePayload,
    sequenceTitle,
    cloneValue
};
