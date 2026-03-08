const { GoogleGenAI, Type } = require('@google/genai');

// Initialize the Google Gen AI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const agent2Outline = async (pitchData, currentBeats, notes, pdfFile) => {
    const systemInstruction = "You are an elite Hollywood Story Architect. Your objective is to take a movie pitch and expand it into a professional, highly readable 8-Sequence Broad Outline. CRITICAL RULES: The 8-Sequence Structure: Divide the narrative into 8 sequences (2 for Act I, 4 for Act II, 2 for Act III). Give each sequence a thematic title. Plant the Tentpoles: Ensure the major structural pillars serve as the climaxes of their respective sequences. Invisible Cause-and-Effect: The narrative must flow using the Therefore/But engine naturally. Lean Formatting: Write exclusively in present tense.";

    const beatItemSchema = {
        type: Type.OBJECT,
        properties: {
            beat_label: { type: Type.STRING },
            description: { type: Type.STRING }
        },
        required: ["beat_label", "description"]
    };

    const sequenceItemSchema = {
        type: Type.OBJECT,
        properties: {
            sequence_number_and_title: { type: Type.STRING },
            beats: {
                type: Type.ARRAY,
                items: beatItemSchema
            }
        },
        required: ["sequence_number_and_title", "beats"]
    };

    const outlineSchema = {
        type: Type.OBJECT,
        properties: {
            title: { type: Type.STRING },
            genre: { type: Type.STRING },
            logline: { type: Type.STRING },
            outline: {
                type: Type.OBJECT,
                properties: {
                    act_1: { type: Type.ARRAY, items: sequenceItemSchema },
                    act_2: { type: Type.ARRAY, items: sequenceItemSchema },
                    act_3: { type: Type.ARRAY, items: sequenceItemSchema }
                },
                required: ["act_1", "act_2", "act_3"]
            }
        },
        required: ["title", "genre", "logline", "outline"]
    };

    const contents = [];

    if (pdfFile) {
        contents.push({
            inlineData: {
                data: pdfFile.buffer.toString("base64"),
                mimeType: pdfFile.mimetype || "application/pdf"
            }
        });
    }

    let contentsText = `Here is the approved pitch: ${JSON.stringify(pitchData)}. You MUST generate the full JSON structure including title, genre, logline, and the 8-sequence outline containing act_1, act_2, and act_3.`;
    if (notes && currentBeats) {
        contentsText = `Here is the approved pitch: ${JSON.stringify(pitchData)}. Here is the current working beat sheet: ${JSON.stringify(currentBeats)}. Please revise the beat sheet specifically based on these User Notes: ${notes}. You MUST generate the full JSON structure including title, genre, logline, and the entirely revised 8-sequence outline containing act_1, act_2, and act_3.`;
    }
    contents.push(contentsText);

    const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: contents,
        config: {
            temperature: 0.7,
            thinkingConfig: { thinkingLevel: "HIGH" },
            systemInstruction: systemInstruction,
            responseMimeType: "application/json",
            responseSchema: outlineSchema
        }
    });

    const rawText = response.text;
    const cleanedText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

    return JSON.parse(cleanedText);
};

module.exports = { agent2Outline };
