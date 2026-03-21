const { generateContent } = require('./ai-client');

const pitchSchema = {
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

const agent1Refine = async (currentPitch, userNote, pdfFile, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    // Revision Bypass Logic
    if (userNote && currentPitch) {
        console.log("  Surgical Revision Mode: Refining pitch...");
        const revisionSystemInstruction = 'ROLE: Expert Pitch Doctor. Refine the provided pitch based strictly on the user\'s notes. Do not alter the core concept, genre, or title unless explicitly requested by the note. Maintain the exact same JSON schema.';

        const revisionPrompt = `USER NOTE: ${userNote}

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

        const rawText = response.text;
        const cleanedText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        return { result: JSON.parse(cleanedText), usage: response.usage };
    }

    const contents = [];

    const response = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            temperature: 0.2, // surgical edits
            thinkingConfig: { thinkingLevel: "HIGH" },
            systemInstruction: "You are an elite Hollywood Creative Executive. The user will provide an existing movie pitch in JSON format, along with a specific note. Revise the pitch to incorporate the note. CRITICAL: ONLY alter the specific elements of the pitch that are directly affected by the user's note. Preserve the original wording, tone, title, and concepts exactly as they are unless the note explicitly requires changing them. Output the revised pitch strictly according to the defined JSON schema.",
        },
        schema: pitchSchema
    });

    // CRITICAL SDK SYNTAX: Extract the text using const rawText = response.text; (no parentheses).
    const rawText = response.text;

    // Strip any markdown (```json) using regex, and JSON.parse it before returning the clean object
    const cleanedText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

    return { result: JSON.parse(cleanedText), usage: response.usage };
};

module.exports = { agent1Refine };
