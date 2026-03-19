const { generateContent } = require('./ai-client');

const agent1Pitch = async (prompt, pdfFile, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
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

    // If no prompt or PDF was provided, prompt for Random Ideas
    if (contents.length === 0) {
        contents.push("Generate 3 completely random, entirely original, high-concept movie pitches spanning different genres.");
    }

    const pitchItemSchema = {
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

    const response = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            temperature: 0.7,
            thinkingConfig: { thinkingLevel: "HIGH" },
            systemInstruction: "You are an elite Hollywood Creative Executive. Your objective is to take a raw, unformatted story idea from a user and brainstorm THREE distinct, professional, high-concept movie pitch options. For each option, you must provide a compelling logline, identify the primary genre, state the core theme, and write a brief, three-act synopsis. Provide variations in tone, genre, or character dynamics across the three options. Do not include conversational filler. You must output your response strictly according to the defined JSON schema. CRITICAL FORMATTING: You MUST separate Act I, Act II, and Act III in the Synopsis with double line breaks (\\n\\n) so they render as distinct paragraphs. Do not output the synopsis as a single block of text.",
        },
        schema: {
            type: 'object',
            properties: {
                pitch_options: {
                    type: 'array',
                    items: pitchItemSchema
                }
            },
            required: ["pitch_options"]
        }
    });

    // CRITICAL SDK SYNTAX: Extract the text using const rawText = response.text; (no parentheses).
    const rawText = response.text;

    // Strip any markdown (```json) using regex, and JSON.parse it before returning the clean object
    const cleanedText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

    return JSON.parse(cleanedText);
};

module.exports = { agent1Pitch };
