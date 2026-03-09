const { GoogleGenAI, Type } = require('@google/genai');

// Initialize with explicit API key to avoid SDK options undefined bug
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const agent1Refine = async (currentPitch, userNote, pdfFile) => {
    const contents = [];

    if (pdfFile) {
        contents.push({
            inlineData: {
                data: pdfFile.buffer.toString("base64"),
                mimeType: pdfFile.mimetype || "application/pdf"
            }
        });
    }

    const prompt = `CURRENT PITCH:
${currentPitch}

USER NOTE:
${userNote}`;

    contents.push(prompt);

    const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: contents,
        config: {
            temperature: 0.2, // surgical edits
            thinkingConfig: { thinkingLevel: "HIGH" },
            systemInstruction: "You are an elite Hollywood Creative Executive. The user will provide an existing movie pitch in JSON format, along with a specific note. Revise the pitch to incorporate the note. CRITICAL: ONLY alter the specific elements of the pitch that are directly affected by the user's note. Preserve the original wording, tone, title, and concepts exactly as they are unless the note explicitly requires changing them. Output the revised pitch strictly according to the defined JSON schema.",
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    logline: { type: Type.STRING },
                    genre: { type: Type.STRING },
                    core_theme: { type: Type.STRING },
                    synopsis: { type: Type.STRING }
                },
                required: ["title", "logline", "genre", "core_theme", "synopsis"]
            }
        }
    });

    // CRITICAL SDK SYNTAX: Extract the text using const rawText = response.text; (no parentheses).
    const rawText = response.text;

    // Strip any markdown (```json) using regex, and JSON.parse it before returning the clean object
    const cleanedText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

    return JSON.parse(cleanedText);
};

module.exports = { agent1Refine };
