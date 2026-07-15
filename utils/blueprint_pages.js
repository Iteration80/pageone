'use strict';

/**
 * A sequence's total page count is the sum of its scenes' page counts — a fact
 * code can compute exactly. Asking the model for it (it was a required schema
 * field) meant asking an LLM to do arithmetic: measured 2026-07-15 on the
 * I.M.A.G.I.N.E. blueprint, ALL 8 sequences disagreed with their own scenes,
 * overstating the film by 14.5 pages in total.
 *
 * Same principle as deriving stage4_beats from the outline: if code can derive
 * it exactly, the model must not be the source of truth for it.
 */
function sumScenePages(scenes = []) {
    const total = (Array.isArray(scenes) ? scenes : []).reduce((sum, scene) => {
        const pages = Number(scene?.estimated_page_count);
        return sum + (Number.isFinite(pages) && pages > 0 ? pages : 0);
    }, 0);
    // Page counts are eighths/quarters in practice; keep one decimal and avoid
    // float noise like 24.499999999999996.
    return Math.round(total * 10) / 10;
}

/**
 * Overwrite each sequence's total_estimated_pages with the true sum of its
 * scenes. Mutates and returns the sequences array (matching the surrounding
 * normalization style in agent_6_scenes.js).
 */
function deriveBlueprintPageCounts(sequences = []) {
    if (!Array.isArray(sequences)) return sequences;
    for (const sequence of sequences) {
        if (!sequence || typeof sequence !== 'object') continue;
        sequence.total_estimated_pages = sumScenePages(sequence.scenes);
    }
    return sequences;
}

/** Total running length of the blueprint, for reporting. */
function blueprintTotalPages(sequences = []) {
    if (!Array.isArray(sequences)) return 0;
    return Math.round(sequences.reduce((sum, sequence) => sum + sumScenePages(sequence?.scenes), 0) * 10) / 10;
}

module.exports = { sumScenePages, deriveBlueprintPageCounts, blueprintTotalPages };
