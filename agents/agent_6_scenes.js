const { GoogleGenAI, Type } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Stage 6 Scene Blueprint Agent
 * Translates an 8-sequence treatment into a scene-by-scene blueprint.
 * Uses sequential prompt chaining across 8 API calls.
 */
const generateStage6Scenes = async (pitch, characters, beats, treatment) => {
    
    // Strict JSON Schema as requested
    const sequenceSchema = {
        type: Type.OBJECT,
        properties: {
            sequence_title: { type: Type.STRING },
            total_estimated_pages: { type: Type.NUMBER },
            scenes: {
                type: Type.ARRAY,
                description: 'An array of scenes. You MUST provide strictly between 7 and 11 scenes to hit the required pacing.',
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

    const systemInstruction = `You are an elite Hollywood Script Coordinator and Sequence Architect. Your objective is to take a single Sequence from a Hybrid Beat Sheet (including the character profiles) and break it down into a granular, Scene-by-Scene Blueprint. CRITICAL RULES FOR SCENE DESIGN: Pacing & Page Counts: A standard sequence is roughly 10-15 pages. Break the sequence into enough individual scenes (strictly 7 to 11 scenes) to achieve modern pacing. Favor shorter, punchier scenes. Assign an estimated page length (e.g., 0.5, 1.5, 2.0) to each scene. Enter Late, Leave Early: Design scenes that start at the latest possible moment and end the moment the dramatic question of the scene is answered. Dramaturgical Function: Every scene must have a clear structural purpose (e.g., establishing a flaw, escalating tension, delivering a twist). There can be no "filler" scenes. Micro-Action: Describe the literal, physical action happening in the scene. Do not just summarize the dialogue. Translate the broad beats into specific, shootable locations and character movements.`;

    const config = {
        systemInstruction: systemInstruction,
        temperature: 0.5,
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

OBJECTIVE: Break down Sequence ${i} into exactly 7 to 11 individual scenes. This is a hard requirement for pacing. Do not generate fewer than 7 scenes. Return a JSON object for this sequence.`;

        try {
            const result = await ai.models.generateContent({
                model: 'gemini-3.1-pro-preview',
                contents: [prompt],
                config: config
            });

            const parsedSeq = JSON.parse(result.text);
            parsedSeq.sequence_number = i; // Ensure sequence number is tracked
            allSequences.push(parsedSeq);
        } catch (error) {
            console.error(`Error generating sequence ${i}:`, error);
            throw error;
        }
    }

    return allSequences;
};

module.exports = { generateStage6Scenes };
