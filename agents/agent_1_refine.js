const { generateContent } = require('./ai-client');
const { parseJsonWithRepair } = require('./json_parse');

// THE SAME OBJECT the generator uses — a private copy here drifted silently once
// (this file carried its own five-field schema while the generator grew to nine).
// Import, never transcribe.
const { PITCH_ITEM_SCHEMA } = require('./agent_1_pitch');
const { loadSkill } = require('../utils/skills_cache');
const pitchSchema = PITCH_ITEM_SCHEMA;

const agent1Refine = async (currentPitch, userNote, pdfFile, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = ''
    } = modelConfig;

    // Revision Bypass Logic
    if (userNote && currentPitch) {
        console.log("  Surgical Revision Mode: Refining pitch...");
        // The SOP rides along so a refine knows what each field IS (a note that changes
        // the premise must move the controlling idea, stakes and synopsis with it — §10).
        const revisionSystemInstruction = 'ROLE: Expert Pitch Doctor. Refine the provided pitch based strictly on the user\'s notes. Do not alter the core concept, genre, or title unless explicitly requested by the note. If PROJECT SOURCE CANON is provided, preserve source-backed facts and accepted divergences. Maintain the exact same JSON schema. Fill every field of the schema; if the existing pitch lacks a field, derive it from the pitch as it stands.\n\nFIELD CONTRACT — the Stage 1 SOP that defines every field:\n\n' + loadSkill('skill_stage1_pitch');

        const sourceBlock = knowledgeContext ? `PROJECT SOURCE CANON:\n${knowledgeContext}\n\n` : '';
        const revisionPrompt = `${sourceBlock}USER NOTE: ${userNote}

EXISTING PITCH:
${JSON.stringify(currentPitch, null, 2)}

Please apply the note surgically and return the full updated pitch in JSON format. Ensure you do not change anything else.`;

        const response = await generateContent({
            model, geminiApiKey, anthropicApiKey,
            contents: [revisionPrompt],
            config: {
                systemInstruction: revisionSystemInstruction,
                temperature: 0.4,
            },
            schema: pitchSchema
        });

        return { result: parseJsonWithRepair(response.text, { label: 'Stage 1 pitch refinement response' }), usage: response.usage };
    }

    const contents = [];

    const response = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            temperature: 0.2, // surgical edits
            thinkingConfig: { thinkingLevel: "HIGH" },
            systemInstruction: "You are an elite Hollywood Creative Executive. The user will provide an existing movie pitch in JSON format, along with a specific note. Revise the pitch to incorporate the note. CRITICAL: ONLY alter the specific elements of the pitch that are directly affected by the user's note. Preserve the original wording, tone, title, and concepts exactly as they are unless the note explicitly requires changing them. Output the revised pitch strictly according to the defined JSON schema.\n\nFIELD CONTRACT — the Stage 1 SOP that defines every field:\n\n" + loadSkill('skill_stage1_pitch'),
        },
        schema: pitchSchema
    });

    // CRITICAL SDK SYNTAX: Extract the text using const rawText = response.text; (no parentheses).
    return { result: parseJsonWithRepair(response.text, { label: 'Stage 1 pitch refinement response' }), usage: response.usage };
};

module.exports = { agent1Refine, REFINE_PITCH_SCHEMA: pitchSchema };
