function normalizedMetaLabel(label = '') {
    return String(label || '')
        .trim()
        .toLowerCase()
        .replace(/[\u2018\u2019`]/g, "'")
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function isOutlineMetaBeat(beat = {}) {
    const label = normalizedMetaLabel(beat.beat_label || beat.beat || '');
    const description = String(beat.description || '').trim();
    if (!label || !description) return false;

    // Schema-field leakage: a real story beat never carries raw schema tokens
    // like "beat_name: 'Set-up'" in its description. These appear when format
    // instructions or per-beat annotations get emitted/appended as beats
    // (observed 2026-07-13 during the outline schema upgrade).
    if (/\b(beat_name|emotional_arc|pacing_notes|genre_variation_notes|stc_genre_category)\b\s*[:=]/i.test(description)) return true;

    // Instruction-shaped labels: "Update Every Beat To Include", "Apply New Format", etc.
    if (/^(update every beat|update all beats|include in every beat|schema update|format update|apply new format|new format)\b/.test(label)) return true;

    const metaLabel = /^(tone|style|tone style|format|formatting|notes?|revision notes?|writer notes?|author notes?|model notes?|ai notes?|cleanup|polish|guidance|instructions?|constraints?|reminders?)$/.test(label);
    if (!metaLabel) return false;

    return /\b(?:ensure|remove|avoid|do not|don't|keep|maintain|make sure|style|tone|jargon|ai[-\s]?style|likeability|architectural glitches|identity absorption)\b/i.test(description);
}

function sanitizeOutlineMetaBeats(outline = {}) {
    if (!outline || typeof outline !== 'object') return outline;
    const target = outline.outline && typeof outline.outline === 'object' && !Array.isArray(outline.outline)
        ? outline.outline
        : outline;

    for (const actKey of ['act_1', 'act_2', 'act_3']) {
        if (!Array.isArray(target[actKey])) continue;
        target[actKey] = target[actKey].map(sequence => {
            if (!sequence || typeof sequence !== 'object') return sequence;
            const beats = Array.isArray(sequence.beats) ? sequence.beats : [];
            return {
                ...sequence,
                beats: beats.filter(beat => !isOutlineMetaBeat(beat))
            };
        });
    }
    return outline;
}

module.exports = {
    isOutlineMetaBeat,
    sanitizeOutlineMetaBeats
};
