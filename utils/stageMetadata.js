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
    'stage7_draft',
];

/**
 * Call this when a stage is first generated (auto or manual trigger).
 * Stamps _meta.generated_at and clears stale/revised flags.
 */
function stampGenerated(projectData, stageKey) {
    if (!projectData.data[stageKey]) return;
    projectData.data[stageKey]._meta = {
        generated_at: Date.now(),
        manually_revised_at: null,
        stale: false,
    };
}

/**
 * Call this when a user manually revises a stage (Submit/feedback revision).
 * Stamps _meta.manually_revised_at on the revised stage and marks all
 * downstream stages as stale so Stage 6 knows to weight this stage higher.
 */
function stampRevised(projectData, stageKey) {
    if (!projectData.data[stageKey]) return;

    const meta = projectData.data[stageKey]._meta || {};
    projectData.data[stageKey]._meta = {
        ...meta,
        manually_revised_at: Date.now(),
        stale: false, // the revised stage itself is not stale — it's the new truth
    };

    // Mark all downstream stages as stale
    const revisedIdx = STAGE_ORDER.indexOf(stageKey);
    if (revisedIdx === -1) return;

    for (let i = revisedIdx + 1; i < STAGE_ORDER.length; i++) {
        const downstreamKey = STAGE_ORDER[i];
        if (projectData.data[downstreamKey]) {
            const downMeta = projectData.data[downstreamKey]._meta || {};
            projectData.data[downstreamKey]._meta = {
                ...downMeta,
                stale: true,
            };
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
        const meta = projectData.data[key]?._meta;
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
 *     character actions, and scene specifics. Where Stage 4 (Beats) conflicts with
 *     Stage 5, defer to Stage 5.
 */
function buildSourceAuthorityBlock(projectData, targetStageKey) {
    const revised = getRevisedUpstreamStages(projectData, targetStageKey);
    if (revised.length === 0) return '';

    const STAGE_LABELS = {
        stage1_pitch: 'Stage 1 (Pitch)',
        stage2_outline: 'Stage 2 (Sequence Outline)',
        stage3_characters: 'Stage 3 (Characters)',
        stage4_beats: 'Stage 4 (Beat Sheet)',
        stage5_treatment: 'Stage 5 (Treatment)',
    };

    const STAGE_CONTEXT = {
        stage5_treatment: 'for narrative content, character actions, and scene specifics. Where Stage 4 (Beats) conflicts with Stage 5, defer to Stage 5.',
        stage4_beats: 'for structural beat placement and sequence pacing. Where Stage 3 (Characters) conflicts with Stage 4, defer to Stage 4.',
        stage3_characters: 'for character psychology, voice, and arc. Any character behavior in earlier stages must be interpreted through this revised profile.',
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
    STAGE_ORDER,
};
