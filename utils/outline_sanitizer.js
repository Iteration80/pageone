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

    // Markdown emphasis (**bold**) never appears in clean story prose — the model
    // emits plain-text beat descriptions. Its presence means a formatted revision
    // brief fragment leaked in as a beat (observed 2026-07-17, "Dearly Beloved":
    // the writer's bracketed brief items were appended verbatim as three beats).
    if (/\*\*/.test(description)) return true;

    // Instruction-shaped label: a bare directive verb ("Preserve", "Establish",
    // "Update", "Integrate", ...) is a revision directive, not a beat name.
    if (/^(?:preserve|establish|update|introduce|integrate|incorporate|revise|rework|retain|reinstate)\b/.test(label)) return true;

    // Description that opens with an imperative directive governing a story
    // element ("Update his backstory...", "Establish the ... portraits",
    // "Preserve the ... arc") is an instruction to EXECUTE, not narrated action.
    if (/^(?:update|preserve|establish|introduce|integrate|incorporate|revise|rework|retain|reinstate)\s+(?:the|his|her|their|a|an)\b/i.test(description)) return true;

    // Schema-field leakage: a real story beat never carries raw schema tokens
    // like "beat_name: 'Set-up'" in its description. These appear when format
    // instructions or per-beat annotations get emitted/appended as beats
    // (observed 2026-07-13 during the outline schema upgrade).
    if (/\b(beat_name|emotional_arc|pacing_notes|genre_variation_notes|stc_genre_category)\b\s*[:=]/i.test(description)) return true;

    // Outline-machinery talk: story prose never discusses "beat descriptions",
    // "sequence titles", "Save the Cat", or "lean outline language" — only
    // leaked process instructions do (observed 2026-07-13, rounds 3-4).
    if (/\b(beat descriptions?|beat labels?|beat (?:assignments?|names?)|sequence titles?|outline (?:language|format|prose|structure)|lean outline|word count|save the cat)\b/i.test(description)) return true;

    // Outline-surgery instructions emitted as beats: "Remove the duplicate
    // 'Aftermath' beat...", "Change beats after the Midpoint ... from 'Fun and
    // Games' to 'Bad Guys Close In'". Start-anchored so story prose that merely
    // contains these verbs is untouched.
    if (/^(?:remove|delete|rebalance|reorder|merge|swap|move|change|convert)\b[^.]{0,90}\b(?:duplicate|beats?|sequences?|annotations?|assignments?)\b/i.test(description)) return true;

    // Instruction-shaped labels: "Update Every Beat To Include", "Tighten All
    // Beat Descriptions", "Preserve All Sequence Titles", etc.
    if (/^(update every beat|update all beats|include in every beat|schema update|format update|apply new format|new format)\b/.test(label)) return true;
    if (/^(tighten|preserve|keep|maintain|shorten|trim|condense|reformat|rephrase|retain) (all|every|each)\b/.test(label)) return true;

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
