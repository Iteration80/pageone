const { GoogleGenAI, Type } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Stage 6 Revision Agent
 * Modifies an existing Stage 6 Scene Blueprint based on user feedback.
 */
const reviseStage6Scenes = async (currentBlueprint, feedback) => {
    
    // Exact same schema as agent_6_scenes.js for consistency
    const sequenceSchema = {
        type: Type.OBJECT,
        properties: {
            sequence_title: { type: Type.STRING },
            total_estimated_pages: { type: Type.NUMBER },
            scenes: {
                type: Type.ARRAY,
                description: 'An array of scenes.',
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

    // The root schema is an array of these sequences
    const rootSchema = {
        type: Type.ARRAY,
        items: sequenceSchema
    };

    const config = {
        systemInstruction: `You are an elite Hollywood Script Coordinator and Sequence Architect. Your objective is to take an existing Scene-by-Scene Blueprint and modify it based on the director's feedback.

CRITICAL RULES FOR REVISION:
1. ONLY modify the specific scenes required by the feedback (e.g., rewrite, merge, insert, or delete).
2. You MUST return the rest of the JSON structure exactly as it was provided. Do not alter a single word of the scenes that were not mentioned in the feedback.
3. Maintain the detailed, physical Narrative Action style for any new or rewritten scenes.
4. Ensure the structural integrity of the sequences is preserved.
5. Return the entire updated blueprint as a valid JSON array of sequences.`,
        temperature: 0.5,
        thinkingConfig: { thinkingLevel: 'HIGH' },
        responseMimeType: 'application/json',
        responseSchema: rootSchema
    };

    const model = ai.getGenerativeModel({
        model: 'gemini-3.1-pro-preview',
    });

    const prompt = `CURRENT SCENE BLUEPRINT (JSON):
${JSON.stringify(currentBlueprint, null, 2)}

DIRECTOR'S FEEDBACK:
${feedback}

OBJECTIVE: Apply the feedback to the blueprint. Return the FULL updated JSON array. Ensure ONLY the target areas are changed.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: config
        });

        let updatedData = JSON.parse(result.response.text());

        // POST-PROCESSING: Mathematical Renumbering
        // This forces scene_number to be sequential 1..N across all sequences
        let globalCounter = 1;
        updatedData.forEach(sequence => {
            if (sequence.scenes && Array.isArray(sequence.scenes)) {
                sequence.scenes.forEach(scene => {
                    scene.scene_number = globalCounter++;
                });
            }
        });

        return updatedData;
    } catch (error) {
        console.error('Error in Stage 6 Revision Agent:', error);
        throw error;
    }
};

module.exports = { reviseStage6Scenes };
