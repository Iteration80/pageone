const { GoogleGenAI } = require('@google/genai');

// Initialize the Google Gen AI SDK
// Initialize with explicit API key to avoid SDK options undefined bug
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const agent1Pitch = async (prompt) => {
    const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: prompt,
        config: {
            temperature: 0.7,
            thinkingConfig: { thinkingLevel: "HIGH" },
            systemInstruction: "You are an elite Hollywood Creative Executive. Your objective is to take a raw, unformatted story idea from a user and brainstorm THREE distinct, professional, high-concept movie pitch options. For each option, you must provide a compelling logline, identify the primary genre, state the core theme, and write a brief, three-act synopsis. Provide variations in tone, genre, or character dynamics across the three options. Do not include conversational filler. You must output your response strictly according to the defined JSON schema.",
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    pitch_options: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                title: { type: "STRING" },
                                logline: { type: "STRING" },
                                genre: { type: "STRING" },
                                core_theme: { type: "STRING" },
                                synopsis: { type: "STRING" }
                            },
                            required: ["title", "logline", "genre", "core_theme", "synopsis"]
                        }
                    }
                },
                required: ["pitch_options"]
            }
        }
    });

    // CRITICAL SDK SYNTAX: Extract the text using const rawText = response.text; (no parentheses).
    const rawText = response.text;

    // Strip any markdown (```json) using regex, and JSON.parse it before returning the clean object
    const cleanedText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

    return JSON.parse(cleanedText);
};

module.exports = { agent1Pitch };
