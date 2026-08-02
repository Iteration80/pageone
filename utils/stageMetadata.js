/**
 * Stage Metadata & Staleness Tracker
 *
 * Each stage object in projectData.data can carry a _meta field:
 * {
 *   generated_at: <timestamp>,
 *   manually_revised_at: <timestamp | null>,
 *   stale: <boolean>   // true if an upstream stage was revised after this was generated
 * }
 *
 * Staleness flows FORWARD only (downstream stages become stale when upstream is revised).
 * Earlier stages are never retroactively modified — user-approved work is never overwritten.
 */

const STAGE_ORDER = [
    'stage1_pitch',
    'stage2_outline',
    'stage3_characters',
    'stage4_beats',
    'stage5_treatment',
    'stage6_scenes',
    'stage7_style',
    'stage8_coverage',
    'stage9_rewrites',
];

// Sibling map for stages whose value cannot carry an inline `_meta`.
//
// `stage6_scenes` (visible Stage 5, Scene Blueprint) is stored as a bare ARRAY of
// sequences, and JSON.stringify serializes only an array's INDEX properties — so
// `blueprint._meta = {...}` is set in memory and silently dropped on the very next
// save. Every stamp for the blueprint was being thrown away, which meant visible
// Stage 5 could never be marked stale: revise the Outline, Characters or Treatment
// after building a blueprint and the writer got no nav badge and no banner, while
// every other stage got both. It is also the most expensive artifact to rebuild,
// so it is the worst one to let go quietly out of date. (Found 2026-08-01.)
//
// Reads prefer the inline `_meta` so existing projects keep working untouched;
// only array-valued stages take the sibling path, so there is no migration.
const STAGE_META_SIBLING_KEY = 'stage_meta';

function canHoldInlineMeta(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStageMeta(projectData, stageKey) {
    const value = projectData?.data?.[stageKey];
    if (canHoldInlineMeta(value) && value._meta) return value._meta;
    return projectData?.data?.[STAGE_META_SIBLING_KEY]?.[stageKey];
}

function writeStageMeta(projectData, stageKey, meta) {
    const value = projectData?.data?.[stageKey];
    if (value === undefined || value === null) return;
    if (canHoldInlineMeta(value)) {
        value._meta = meta;
        return;
    }
    if (!projectData.data[STAGE_META_SIBLING_KEY]) projectData.data[STAGE_META_SIBLING_KEY] = {};
    projectData.data[STAGE_META_SIBLING_KEY][stageKey] = meta;
}

/**
 * Call this when a stage is first generated (auto or manual trigger).
 * Stamps _meta.generated_at and clears stale/revised flags.
 */
function stampGenerated(projectData, stageKey) {
    if (!projectData.data[stageKey]) return;
    writeStageMeta(projectData, stageKey, {
        generated_at: Date.now(),
        manually_revised_at: null,
        stale: false,
    });
}

/**
 * Call this when a user manually revises a stage (Submit/feedback revision).
 * Stamps _meta.manually_revised_at on the revised stage and marks all
 * downstream stages as stale so Stage 6 knows to weight this stage higher.
 */
function stampRevised(projectData, stageKey) {
    if (!projectData.data[stageKey]) return;

    const meta = readStageMeta(projectData, stageKey) || {};
    writeStageMeta(projectData, stageKey, {
        ...meta,
        manually_revised_at: Date.now(),
        stale: false, // the revised stage itself is not stale — it's the new truth
    });

    // Mark all downstream stages as stale
    const revisedIdx = STAGE_ORDER.indexOf(stageKey);
    if (revisedIdx === -1) return;

    for (let i = revisedIdx + 1; i < STAGE_ORDER.length; i++) {
        const downstreamKey = STAGE_ORDER[i];
        if (projectData.data[downstreamKey]) {
            const downMeta = readStageMeta(projectData, downstreamKey) || {};
            writeStageMeta(projectData, downstreamKey, {
                ...downMeta,
                stale: true,
            });
        }
    }
}

/**
 * Returns an array of stage keys that were manually revised and are upstream
 * of the target stage. Used by Stage 6 to build the source authority directive.
 *
 * e.g. getRevisedUpstreamStages(projectData, 'stage6_scenes')
 *   => ['stage5_treatment']  if only Stage 5 was manually revised
 */
function getRevisedUpstreamStages(projectData, targetStageKey) {
    const targetIdx = STAGE_ORDER.indexOf(targetStageKey);
    if (targetIdx === -1) return [];

    return STAGE_ORDER.slice(0, targetIdx).filter(key => {
        const meta = readStageMeta(projectData, key);
        return meta?.manually_revised_at != null;
    });
}

/**
 * Builds a SOURCE_AUTHORITY prompt block for injection into Stage 6 (or any
 * downstream agent). If no manual revisions exist upstream, returns an empty string.
 *
 * Example output:
 *
 *   SOURCE AUTHORITY NOTICE:
 *   The following stages were manually revised by the author after initial generation.
 *   They represent the author's definitive creative intent and override any conflicting
 *   information from earlier stages:
 *
 *   - STAGE 5 (TREATMENT): Treat as the absolute source of truth for narrative content,
 *     character actions, and scene specifics. Where the derived beat sheet conflicts with
 *     Stage 5, defer to Stage 5.
 */
function buildSourceAuthorityBlock(projectData, targetStageKey) {
    const revised = getRevisedUpstreamStages(projectData, targetStageKey);
    if (revised.length === 0) return '';

    const STAGE_LABELS = {
        stage1_pitch: 'Stage 1 (Pitch)',
        stage2_outline: 'Stage 2 (Outline)',
        stage3_characters: 'Stage 3 (Characters)',
        stage4_beats: 'Derived Beat Sheet (stage4_beats key)',
        stage5_treatment: 'Stage 4 (Treatment)',
    };

    const STAGE_CONTEXT = {
        stage5_treatment: 'for narrative content, character actions, and scene specifics. Where the derived beat sheet conflicts with Stage 5, defer to Stage 5.',
        stage4_beats: 'for structural beat placement and sequence pacing derived from the approved Stage 2 Outline.',
        stage3_characters: 'for tiered character profiles, Tier 1 psychology/voice/arc, Tier 2 narrative function/emotional truth/comic or tension function/pressure behavior/voice flavor, and Tier 3 cameo purpose/casting energy/playable behavior/line style. Any character behavior in earlier stages must be interpreted through this revised profile.',
        stage2_outline: 'for sequence structure and act breaks.',
        stage1_pitch: 'for premise, logline, theme, and title.',
    };

    const lines = revised.map(key => {
        const label = STAGE_LABELS[key] || key;
        const context = STAGE_CONTEXT[key] || 'as the authoritative source for its domain.';
        return `- ${label.toUpperCase()}: Treat as the absolute source of truth ${context}`;
    });

    return `
SOURCE AUTHORITY NOTICE:
The following stages were manually revised by the author after initial generation.
They represent the author's definitive creative intent and override any conflicting
information from earlier stages:

${lines.join('\n')}
`.trim();
}

module.exports = {
    stampGenerated,
    stampRevised,
    buildSourceAuthorityBlock,
    getRevisedUpstreamStages,
    readStageMeta,
    writeStageMeta,
    STAGE_META_SIBLING_KEY,
    STAGE_ORDER,
};
