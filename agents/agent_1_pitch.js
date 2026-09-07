const { generateContent } = require('./ai-client');
const { parseJsonWithRepair } = require('./json_parse');
const { loadSkill } = require('../utils/skills_cache');

// ⚠️ MODULE SCOPE AND EXPORTED so the admin Verify action (Phase 5 item 4) can send
// THIS OBJECT — not a copy of it — in its one real request per stage. A hand-copied
// schema in a verifier is an instrument that tests something other than what runs.
const PITCH_ITEM_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        logline: { type: 'string' },
        genre: { type: 'string' },
        core_theme: { type: 'string' },
        // 2026-09-07 — the premise machinery the Stage 1 SOP (skills/skill_stage1_pitch.md)
        // demands. Each of these is a checkable claim about the story (an argument, a
        // value+cause, a concrete loss, a removable core), not more prose. They are
        // REQUIRED so every model must commit to them and the admin Verify probe
        // exercises them; readers all use optional chaining, so pitches saved before
        // this date still load. Every reader of these fields is pinned by
        // test/stage1_pitch_contract.test.js — extend that list before adding a field.
        premise: { type: 'string' },
        controlling_idea: { type: 'string' },
        stakes: { type: 'string' },
        dramatic_kernel: { type: 'string' },
        synopsis: { type: 'string' }
    },
    required: ["title", "logline", "genre", "core_theme", "premise", "controlling_idea", "stakes", "dramatic_kernel", "synopsis"]
};

/** Field names in the order the pitch card, exports and downstream prompts present them. */
const PITCH_FIELDS = Object.keys(PITCH_ITEM_SCHEMA.properties);

const PITCH_SCHEMA = {
    type: 'object',
    properties: {
        pitch_options: {
            type: 'array',
            // Flat items, so the bound is accepted — see agent_2_outline.js for why
            // the same bound is impossible on act_1/2/3.
            minItems: 3,
            maxItems: 3,
            items: PITCH_ITEM_SCHEMA
        }
    },
    required: ["pitch_options"]
};

const agent1Pitch = async (prompt, pdfFile, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = ''
    } = modelConfig;

    const contents = [];
    if (pdfFile) {
        contents.push({
            inlineData: {
                data: pdfFile.buffer.toString("base64"),
                mimeType: pdfFile.mimetype || "application/pdf"
            }
        });
    }
    if (prompt) {
        contents.push(prompt);
    }
    if (knowledgeContext) {
        contents.push(`PROJECT SOURCE CANON:\n${knowledgeContext}`);
    }

    // If no prompt or PDF was provided, prompt for Random Ideas
    if (contents.length === 0) {
        contents.push("Generate 3 completely random, entirely original, high-concept movie pitches spanning different genres.");
    }

    const response = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            temperature: 0.7,
            thinkingConfig: { thinkingLevel: "HIGH" },
            // The SOP is the system instruction — see CLAUDE.md "Skill Files". Until
            // 2026-09-07 Stage 1 was the only generating stage with no SOP at all: one
            // sentence asked for "high-concept" options and nothing defined what that meant.
            systemInstruction: loadSkill('skill_stage1_pitch'),
        },
        schema: PITCH_SCHEMA
    });

    // CRITICAL SDK SYNTAX: Extract the text using const rawText = response.text; (no parentheses).
    const rawText = response.text;
    const { usage } = response;

    return { result: parseJsonWithRepair(rawText, { label: 'Stage 1 pitch generation response' }), usage };
};

module.exports = { agent1Pitch, PITCH_SCHEMA, PITCH_ITEM_SCHEMA, PITCH_FIELDS };
