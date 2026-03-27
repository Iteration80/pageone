const { generateContent } = require('./ai-client');

/**
 * Stage 6 Revision Agent
 * Modifies an existing Stage 6 Scene Blueprint based on user feedback.
 * Returns only modified sequences to keep request/response small, then
 * merges them back into the full blueprint client-side.
 */
const reviseStage6Scenes = async (currentBlueprint, feedback, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    // Strict JSON Schema matching agent_6_scenes.js
    const sequenceSchema = {
        type: 'object',
        properties: {
            sequence_number: { type: 'number' },
            sequence_title: { type: 'string' },
            total_estimated_pages: { type: 'number' },
            scenes: {
                type: 'array',
                description: 'An array of scenes.',
                items: {
                    type: 'object',
                    properties: {
                        scene_number: { type: 'number' },
                        scene_heading: { type: 'string' },
                        narrative_action: { type: 'string' },
                        dramaturgical_function: { type: 'string' },
                        estimated_page_count: { type: 'number' }
                    },
                    required: ['scene_number', 'scene_heading', 'narrative_action', 'dramaturgical_function', 'estimated_page_count']
                }
            }
        },
        required: ['sequence_number', 'sequence_title', 'total_estimated_pages', 'scenes']
    };

    // The root schema is an array of sequences (only modified ones returned)
    const rootSchema = {
        type: 'array',
        items: sequenceSchema
    };

    const config = {
        systemInstruction: `You are an elite Script Coordinator modifying a Scene Blueprint based on the director's feedback.

CRITICAL RULES:
- Return ONLY the sequences that contain changes. Do NOT return unmodified sequences.
- Within a returned sequence, include ALL its scenes (both modified and unmodified within that sequence).
- Generate full, detailed narrative_action (100-200 words) and dramaturgical_function for modified or new scenes.
- For unmodified scenes within a modified sequence, copy them verbatim from the input.
- If a scene is split into multiple scenes, generate complete data for each new scene.
- If scenes are merged, generate a single combined scene with updated data.
- Preserve the original sequence_number so the system can merge your changes back into the full blueprint.`,
        temperature: 0.5,
    };

    // Strip heavy fields and truncate descriptions to keep prompt small.
    // Post-processing restores draft_text/locked from the original blueprint.
    const lightBlueprint = currentBlueprint.map(seq => ({
        sequence_number: seq.sequence_number,
        sequence_title: seq.sequence_title,
        total_estimated_pages: seq.total_estimated_pages,
        scenes: seq.scenes?.map(({ draft_text, humanized_draft_text, locked, ...scene }) => ({
            ...scene,
            narrative_action: scene.narrative_action?.slice(0, 200) || '',
            dramaturgical_function: scene.dramaturgical_function?.slice(0, 100) || ''
        }))
    }));

    const prompt = `CURRENT SCENE BLUEPRINT (JSON — narrative_action truncated for context; generate full versions for any scenes you modify):
${JSON.stringify(lightBlueprint)}

DIRECTOR'S FEEDBACK:
${feedback}

OBJECTIVE: Apply the feedback. Return ONLY the sequences containing changes (with ALL their scenes). Do NOT return unmodified sequences.`;

    // Retry up to 3 times on transient connection errors
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            result = await generateContent({
                model, geminiApiKey, anthropicApiKey,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config,
                schema: rootSchema
            });
            break;
        } catch (err) {
            console.warn(`Stage 6 Revision attempt ${attempt}/3: ${err.message}`);
            if (attempt === 3) throw err;
            await new Promise(r => setTimeout(r, 3000 * attempt));
        }
    }

    try {
        const modifiedSequences = JSON.parse(result.text);

        // Merge modified sequences back into the full blueprint
        const modifiedMap = new Map(modifiedSequences.map(s => [s.sequence_number, s]));
        let updatedData = currentBlueprint.map(seq => {
            const modified = modifiedMap.get(seq.sequence_number);
            return modified || seq;
        });
        // Handle new sequences (sequence_number higher than any existing)
        const maxExisting = currentBlueprint.length;
        for (const seq of modifiedSequences) {
            if (seq.sequence_number > maxExisting) {
                updatedData.push(seq);
            }
        }

        // Build a lookup of existing draft data from the original blueprint, keyed by
        // scene_heading (sluglines are stable identifiers). This survives Gemini's
        // structured-output stripping of fields not in the schema (draft_text, locked).
        const existingDraftData = new Map();
        currentBlueprint.forEach(seq => {
            seq.scenes?.forEach(scene => {
                if (scene.draft_text || scene.locked) {
                    existingDraftData.set(scene.scene_heading, {
                        draft_text: scene.draft_text,
                        humanized_draft_text: scene.humanized_draft_text,
                        locked: scene.locked
                    });
                }
            });
        });

        // POST-PROCESSING: renumber scenes sequentially and restore lost fields
        let count = 1;
        updatedData.forEach((sequence, idx) => {
            sequence.sequence_number = idx + 1;

            if (sequence.scenes && Array.isArray(sequence.scenes)) {
                sequence.scenes.forEach(scene => {
                    scene.scene_number = count++;

                    // Restore draft_text, humanized_draft_text, and locked for surviving scenes
                    const existing = existingDraftData.get(scene.scene_heading);
                    if (existing) {
                        if (existing.draft_text) scene.draft_text = existing.draft_text;
                        if (existing.humanized_draft_text) scene.humanized_draft_text = existing.humanized_draft_text;
                        if (existing.locked) scene.locked = existing.locked;
                    }
                });
            }
        });

        return { result: updatedData, usage: result.usage };
    } catch (error) {
        console.error('Error in Stage 6 Revision Agent:', error);
        throw error;
    }
};

module.exports = { reviseStage6Scenes };
