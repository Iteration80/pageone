/**
 * Stage 1 (Pitch) draft persistence.
 *
 * Visible Stage 1 was the one stage that saved nothing until the writer clicked
 * "Select to Workshop". The typed story idea and all three generated pitch options
 * lived only in browser memory, while the generation had already been billed and
 * recorded in `apiUsage` — so returning to the hub, a refresh, or a stray click
 * lost paid work with no way back. Every other stage saves server-side as it goes.
 * (Found 2026-07-30, fixed 2026-08-02.)
 *
 * The draft is deliberately NOT a stage artifact: it is absent from STAGE_ORDER and
 * from DATA_KEY_TO_STAGE, carries no `_meta`, and never enters version history. It is
 * scratch state that survives a reload, nothing more. Selecting a pitch promotes one
 * option into `stage1_pitch` and clears the draft.
 */

const STAGE1_DRAFT_KEY = 'stage1_draft';

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Keeps only usable pitch objects. Returns null — meaning "nothing usable here" —
 * rather than an empty array, so callers can tell an unusable list from a real one.
 */
function sanitizePitchOptions(options) {
    if (!Array.isArray(options)) return null;
    const cleaned = options.filter(isPlainObject);
    return cleaned.length ? cleaned : null;
}

/**
 * Reads the draft out of a project's `data`, or null when there is nothing worth
 * restoring. An idea of whitespace with no options is not worth restoring.
 */
function readStage1Draft(data) {
    const draft = data && data[STAGE1_DRAFT_KEY];
    if (!isPlainObject(draft)) return null;

    const idea = typeof draft.idea === 'string' ? draft.idea : '';
    const pitchOptions = sanitizePitchOptions(draft.pitch_options) || [];
    if (!idea.trim() && !pitchOptions.length) return null;

    return { ...draft, idea, pitch_options: pitchOptions };
}

/**
 * Merges a partial patch into the saved draft and returns the project.
 *
 * Patch semantics are per-key: a key that is absent leaves the saved value alone.
 * That is what lets the debounced idea save and the post-generation options save be
 * two independent writes without either erasing the other's half.
 *
 * Recognised keys: `idea`, `pitchOptions`, `attachmentName`, `generatedAt`.
 */
function applyStage1DraftPatch(project, patch = {}) {
    if (!isPlainObject(project)) return project;
    if (!isPlainObject(project.data)) project.data = {};
    const data = project.data;

    const next = isPlainObject(data[STAGE1_DRAFT_KEY]) ? { ...data[STAGE1_DRAFT_KEY] } : {};

    if ('idea' in patch) {
        next.idea = typeof patch.idea === 'string' ? patch.idea : '';
    }

    if ('attachmentName' in patch) {
        next.attachment_name = isNonEmptyString(patch.attachmentName) ? patch.attachmentName : null;
    }

    if ('pitchOptions' in patch) {
        const cleaned = sanitizePitchOptions(patch.pitchOptions);
        // A patch carrying an unusable list leaves the saved options alone. A
        // malformed regeneration must never delete options already on disk — losing
        // them is the exact failure this module exists to prevent.
        if (cleaned) {
            next.pitch_options = cleaned;
            next.generated_at = isNonEmptyString(patch.generatedAt)
                ? patch.generatedAt
                : new Date().toISOString();
        }
    }

    if (readStage1Draft({ [STAGE1_DRAFT_KEY]: next })) {
        data[STAGE1_DRAFT_KEY] = next;
    } else {
        delete data[STAGE1_DRAFT_KEY];
    }

    return project;
}

/** Drops the draft entirely — called once a pitch has been promoted to `stage1_pitch`. */
function clearStage1Draft(project) {
    if (isPlainObject(project) && isPlainObject(project.data)) {
        delete project.data[STAGE1_DRAFT_KEY];
    }
    return project;
}

module.exports = {
    STAGE1_DRAFT_KEY,
    readStage1Draft,
    applyStage1DraftPatch,
    clearStage1Draft,
};
