const { GoogleGenAI, Type } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Stage 6 Revision Agent
 * Modifies an existing Stage 6 Scene Blueprint based on user feedback.
 */
const reviseStage6Scenes = async (currentBlueprint, feedback) => {
    
    // Strict JSON Schema matching agent_6_scenes.js
    const sequenceSchema = {
        type: Type.OBJECT,
        properties: {
            sequence_number: { type: Type.NUMBER },
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
        required: ['sequence_number', 'sequence_title', 'total_estimated_pages', 'scenes']
    };

    // The root schema is an array of these sequences
    const rootSchema = {
        type: Type.ARRAY,
        items: sequenceSchema
    };

    const config = {
        systemInstruction: `You are an elite Script Coordinator modifying a Scene Blueprint based on the director's feedback. Apply the feedback (e.g., rewrite, merge, or insert scenes). 

CRITICAL: ONLY modify the specific scenes required by the feedback. You MUST return the entire JSON structure, keeping all unaffected sequences and scenes absolutely verbatim.`,
        temperature: 0.5,
        responseMimeType: 'application/json',
        responseSchema: rootSchema
    };

    const model = ai.getGenerativeModel({
        model: 'gemini-3.1-pro-preview',
    });

    const prompt = `CURRENT SCENE BLUEPRINT (JSON):
${JSON.stringify(currentBlueprint)}

DIRECTOR'S FEEDBACK:
${feedback}

OBJECTIVE: Apply the feedback to the blueprint. Return the FULL updated JSON array. Ensure ONLY the target areas are changed.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: config
        });

        let updatedData = JSON.parse(result.response.text());

        // Build a lookup of existing draft data from the original blueprint, keyed by
        // scene_heading (sluglines are stable identifiers). This survives Gemini's
        // structured-output stripping of fields not in the schema (draft_text, locked).
        const existingDraftData = new Map();
        currentBlueprint.forEach(seq => {
            seq.scenes?.forEach(scene => {
                if (scene.draft_text || scene.locked) {
                    existingDraftData.set(scene.scene_heading, {
                        draft_text: scene.draft_text,
                        locked: scene.locked
                    });
                }
            });
        });

        // POST-PROCESSING: renumber scenes sequentially and restore lost fields
        let count = 1;
        updatedData.forEach((sequence, idx) => {
            // Restore sequence_number (1-based index) in case Gemini dropped or changed it
            sequence.sequence_number = idx + 1;

            if (sequence.scenes && Array.isArray(sequence.scenes)) {
                sequence.scenes.forEach(scene => {
                    scene.scene_number = count++;

                    // Restore draft_text and locked for scenes that survived the revision
                    const existing = existingDraftData.get(scene.scene_heading);
                    if (existing) {
                        if (existing.draft_text) scene.draft_text = existing.draft_text;
                        if (existing.locked) scene.locked = existing.locked;
                    }
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
