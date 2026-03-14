const { GoogleGenAI, Type } = require('@google/genai');
const fs = require('fs');
const path = require('path');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Stage 6 Scene Blueprint Agent
 * Translates an 8-sequence treatment into a scene-by-scene blueprint.
 * Uses sequential prompt chaining across 8 API calls.
 */
const generateStage6Scenes = async (pitch, characters, beats, treatment, onProgress = null) => {
    const skillPath = path.join(__dirname, '../skills/skill_stage6_scenes.md');
    const scenesSOP = fs.readFileSync(skillPath, 'utf8');

    // Strict JSON Schema as requested
    const sequenceSchema = {
        type: Type.OBJECT,
        properties: {
            sequence_title: { type: Type.STRING },
            total_estimated_pages: { type: Type.NUMBER },
            scenes: {
                type: Type.ARRAY,
                description: 'An array of scenes. Provide 8 to 12 scenes based on the natural narrative breaks of the sequence.',
                items: {
                    type: Type.OBJECT,
                    properties: {
                        scene_number: { type: Type.NUMBER },
                        scene_heading: { type: Type.STRING },
                        narrative_action: { type: Type.STRING },
                        dramaturgical_function: { type: Type.STRING },
                        estimated_page_count: { type: Type.NUMBER }
                    },
                    required: ['scene_number', 'scene_heading', 'narrative_action', 'dramaturgical_function', 'estimated_page_count']
                }
            }
        },
        required: ['sequence_title', 'total_estimated_pages', 'scenes']
    };

    const systemInstruction = scenesSOP;

    const config = {
        systemInstruction: systemInstruction,
        temperature: 0.7,
        thinkingConfig: { thinkingLevel: 'HIGH' },
        tools: [{ googleSearch: {} }],
        responseMimeType: 'application/json',
        responseSchema: sequenceSchema
    };

    let allSequences = [];

    // Loop through sequences 1 through 8
    for (let i = 1; i <= 8; i++) {
        console.log(`  Stage 6 Chain: Generating Sequence ${i}/8...`);

        // Map treatment sequences to the appropriate Act fields if necessary
        // The project data structure for treatment (Stage 5) has acts, 
        // while beats (Stage 4) has a hybrid_beat_sheet array of 8 sequences.
        const currentBeats = beats.find(b => b.sequence_number === i);
        
        let currentTreatmentText = "";
        // Mapping sequences to Act fields in Stage 5
        if (i === 1 || i === 2) currentTreatmentText = treatment.act_1;
        else if (i === 3 || i === 4) currentTreatmentText = treatment.act_2a;
        else if (i === 5 || i === 6) currentTreatmentText = treatment.act_2b;
        else if (i === 7 || i === 8) currentTreatmentText = treatment.act_3;

        let previousContext = "";
        if (i > 1) {
            const prevSeq = allSequences[i - 2];
            previousContext = `PREVIOUS SEQUENCE SCENES (FOR CONTINUITY):
${JSON.stringify(prevSeq.scenes, null, 2)}`;
        }

        const prompt = `PITCH:
${JSON.stringify(pitch, null, 2)}

CHARACTERS:
${JSON.stringify(characters, null, 2)}

CURRENT SEQUENCE BEATS:
${JSON.stringify(currentBeats, null, 2)}

CURRENT TREATMENT TEXT:
${currentTreatmentText}

${previousContext}

OBJECTIVE: Break down Sequence ${i} into 8 to 12 scenes. Focus on detailed, physical Narrative Action. Let the story dictate the exact scene count. Return a JSON object for this sequence.`;

        try {
            const result = await ai.models.generateContent({
                model: 'gemini-3.1-pro-preview',
                contents: [prompt],
                config: config
            });

            const parsedSeq = JSON.parse(result.text);
            parsedSeq.sequence_number = i; // Ensure sequence number is tracked
            allSequences.push(parsedSeq);
            if (onProgress) onProgress(i, 8);
        } catch (error) {
            console.error(`Error generating sequence ${i}:`, error);
            throw error;
        }
    }

    return allSequences;
};

module.exports = { generateStage6Scenes };
