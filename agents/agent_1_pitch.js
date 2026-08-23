const { generateContent } = require('./ai-client');
const { parseJsonWithRepair } = require('./json_parse');

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
        synopsis: { type: 'string' }
    },
    required: ["title", "logline", "genre", "core_theme", "synopsis"]
};

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
            systemInstruction: "You are an elite Hollywood Creative Executive. Your objective is to take a raw, unformatted story idea from a user and brainstorm THREE distinct, professional, high-concept movie pitch options. For each option, you must provide a compelling logline, identify the primary genre, state the core theme, and write a brief, three-act synopsis. Provide variations in tone, genre, or character dynamics across the three options. If PROJECT SOURCE CANON is provided, use it as authoritative adaptation context and avoid contradicting saved source facts. Do not include conversational filler. You must output your response strictly according to the defined JSON schema. CRITICAL FORMATTING: You MUST separate Act I, Act II, and Act III in the Synopsis with double line breaks (\\n\\n) so they render as distinct paragraphs. Do not output the synopsis as a single block of text.",
        },
        schema: PITCH_SCHEMA
    });

    // CRITICAL SDK SYNTAX: Extract the text using const rawText = response.text; (no parentheses).
    const rawText = response.text;
    const { usage } = response;

    return { result: parseJsonWithRepair(rawText, { label: 'Stage 1 pitch generation response' }), usage };
};

module.exports = { agent1Pitch, PITCH_SCHEMA };
