const { GoogleGenAI, Type } = require('@google/genai');
const fs = require('fs');
const path = require('path');

// Initialize the Google Gen AI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const agent2Outline = async (pitchData, currentOutline, notes, pdfFile) => {
    const skillPath = path.join(__dirname, '../skills/skill_stage2_outline.md');
    const outlineSOP = fs.readFileSync(skillPath, 'utf8');

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

    // Revision Bypass Logic
    if (notes && currentOutline) {
        console.log("  Surgical Revision Mode: Updating outline...");
        const revisionSystemInstruction = `${outlineSOP}\n\nROLE: Structural Story Analyst. Apply the user's note to the existing 8-sequence outline. You MUST keep unaffected sequences 100% identical to the current draft. HOWEVER, if the user's note creates a logical narrative ripple effect (e.g., changing the Midpoint changes the Finale), you are authorized to update subsequent sequences so the story's cause-and-effect makes logical sense. Maintain the exact same JSON schema.`;

        const revisionPrompt = `USER NOTE: ${notes}

EXISTING OUTLINE:
${JSON.stringify(currentOutline, null, 2)}

Please apply the note surgically (allowing for ripple effects) and return the full updated outline in JSON format.`;

        const response = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [revisionPrompt],
            config: {
                systemInstruction: revisionSystemInstruction,
                temperature: 0.5,
                responseMimeType: "application/json",
                responseSchema: outlineSchema
            }
        });

        const rawText = response.text;
        const cleanedText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        return JSON.parse(cleanedText);
    }

    const systemInstruction = outlineSOP;

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
