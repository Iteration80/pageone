/**
 * agents/stage_schemas.js — which response schema each stage asks a model for
 * (Phase 5 item 4).
 *
 * WHY THIS FILE IS A MAP AND NOT A COPY. The admin Verify action makes one real
 * request per stage so an admin can find out whether a given model actually works
 * for that stage. That is only worth anything if the request carries **the schema
 * the stage really uses**. A verifier holding its own transcription of a schema is
 * the "instrument that has never returned a positive" failure in its purest form:
 * it would go green while the real stage kept failing, and the divergence would grow
 * silently every time somebody edited an agent.
 *
 * So each agent now declares its schema at module scope and exports it, and this
 * file only points at those objects. `STAGE_SCHEMAS[2].schema === OUTLINE_SCHEMA`
 * is the same object identity the outline call passes — there is nothing to drift.
 *
 * ⚠️ THE FAILURE CLASS THIS TESTS is schema ACCEPTANCE and parseability, not
 * quality. Gemini rejects `minItems`/`maxItems` on an array whose items themselves
 * contain an array — a bare `INVALID_ARGUMENT` that loses the whole request — and
 * every provider has its own version of that trap. No local test can catch this
 * class; only a real request can, which is the entire point of Verify.
 *
 * ⚠️ STAGES 7, 8 AND 10 RETURN FREE TEXT. Style, Draft and Rewrite pass no schema,
 * so their probe is a short plain-text generation. That is a weaker check and it is
 * labelled as such (`kind: 'text'`) rather than being dressed up as a schema pass —
 * a tick that means less than the tick next to it is worse than no tick.
 *
 * Internal stage ids (see CLAUDE.md's naming trap): visible 4 Treatment = internal 5,
 * visible 5 Scene Blueprint = internal 6, visible 8 Coverage = internal 9, visible 9
 * Rewrite = internal 10. Visible 10 Script is a view and calls no model.
 */

const { PITCH_SCHEMA } = require('./agent_1_pitch');
const { OUTLINE_SCHEMA } = require('./agent_2_outline');
const { CHARACTER_SCHEMA } = require('./agent_3_characters');
const { TREATMENT_SCHEMA } = require('./agent_5_treatment');
const { SCENE_SEQUENCE_SCHEMA } = require('./agent_6_scenes');
const { COVERAGE_SCHEMA } = require('./agent_9_coverage');

/**
 * One entry per internal stage that calls a model.
 *
 *  - `schema` — the exact object the stage passes to generateContent, or null.
 *  - `kind`   — 'schema' (structured output is verified) | 'text' (free-text only).
 *  - `probe`  — a deliberately tiny prompt. Verify costs real money on the admin's
 *               own budget, so the prompt is the smallest thing that still forces
 *               the model to populate every branch of the schema.
 */
const STAGE_SCHEMAS = {
    1: {
        stage: 1,
        visible: 1,
        label: 'Pitch',
        kind: 'schema',
        schema: PITCH_SCHEMA,
        probe: 'Return three one-line movie pitch options about a lighthouse keeper. Keep every field to one short sentence.'
    },
    2: {
        stage: 2,
        visible: 2,
        label: 'Outline',
        kind: 'schema',
        schema: OUTLINE_SCHEMA,
        probe: 'Return a minimal 8-sequence outline for a short film about a lighthouse keeper. '
            + 'One short sentence per field, four brief beats per sequence.'
    },
    3: {
        stage: 3,
        visible: 3,
        label: 'Characters',
        kind: 'schema',
        schema: CHARACTER_SCHEMA,
        probe: 'Return two characters for a short film about a lighthouse keeper: one Tier 1 protagonist and one Tier 3 cameo. '
            + 'One short sentence per field; fill every required field.'
    },
    5: {
        stage: 5,
        visible: 4,
        label: 'Treatment',
        kind: 'schema',
        schema: TREATMENT_SCHEMA,
        probe: 'Return a four-paragraph treatment for a short film about a lighthouse keeper. Two sentences per section.'
    },
    6: {
        stage: 6,
        visible: 5,
        label: 'Scene Blueprint',
        kind: 'schema',
        schema: SCENE_SEQUENCE_SCHEMA,
        probe: 'Return one sequence of three scenes for a short film about a lighthouse keeper. One short sentence per field.'
    },
    7: {
        stage: 7,
        visible: 6,
        label: 'Style',
        kind: 'text',
        schema: null,
        probe: 'In two sentences, describe the prose style of a spare, atmospheric screenplay.'
    },
    8: {
        stage: 8,
        visible: 7,
        label: 'Draft',
        kind: 'text',
        schema: null,
        probe: 'Write four lines of screenplay in Fountain format: a lighthouse keeper checks the lamp at dawn.'
    },
    9: {
        stage: 9,
        visible: 8,
        label: 'Coverage',
        kind: 'schema',
        schema: COVERAGE_SCHEMA,
        probe: 'Return coverage for a two-scene short film about a lighthouse keeper. '
            + 'Most of it is not assessable at this length — say so where that is true. One short sentence per field.'
    },
    10: {
        stage: 10,
        visible: 9,
        label: 'Rewrite',
        kind: 'text',
        schema: null,
        probe: 'Rewrite this line to be more specific, and return only the rewritten line: "He walks in and looks around."'
    }
};

/** Internal stage ids, in pipeline order. */
const VERIFIABLE_STAGES = Object.keys(STAGE_SCHEMAS).map(Number).sort((a, b) => a - b);

function stageProbe(stageNum) {
    return STAGE_SCHEMAS[Number(stageNum)] || null;
}

module.exports = { STAGE_SCHEMAS, VERIFIABLE_STAGES, stageProbe };
