const { generateContent } = require('./ai-client');
const fs = require('fs');
const path = require('path');

/**
 * Parses a treatment or beat text into a dictionary keyed by sequence number.
 * Extracts text strictly between [SEQUENCE N START] and [SEQUENCE N END] tags.
 * Any floating ACT headers or un-tagged text outside these delimiters is ignored.
 *
 * @param {string} text - The full text output from Agent 4 or Agent 5
 * @returns {Object} - e.g. { 1: "...", 2: "...", ... 8: "..." }
 */
function parseSequenceBlocks(text) {
    const blocks = {};
    const regex = /\[SEQUENCE (\d+) START\]([\s\S]*?)\[SEQUENCE \1 END\]/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
        blocks[parseInt(match[1], 10)] = match[2].trim();
    }
    return blocks;
}

/**
 * Stage 6 Scene Blueprint Agent
 * Translates an 8-sequence treatment into a scene-by-scene blueprint.
 * Uses iterative chunking: each of the 8 API calls receives ONLY the parsed
 * beats and treatment text for its specific sequence, plus the final scene
 * of the preceding sequence as a <previous_sequence_climax> anchor.
 *
 * Note: googleSearch tool is Gemini-only and silently dropped when using Claude.
 */
const generateStage6Scenes = async (pitch, characters, beats, treatment, onProgress = null, sourceAuthorityBlock = '', modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    const skillPath = path.join(__dirname, '../skills/skill_stage6_scenes.md');
    const scenesSOP = fs.readFileSync(skillPath, 'utf8');

    const sequenceSchema = {
        type: 'object',
        properties: {
            sequence_title: { type: 'string' },
            total_estimated_pages: { type: 'number' },
            scenes: {
                type: 'array',
                description: 'An array of scenes. Provide 8 to 12 scenes based on the natural narrative breaks of the sequence.',
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
        required: ['sequence_title', 'total_estimated_pages', 'scenes']
    };

    const config = {
        systemInstruction: scenesSOP,
        temperature: 0.7,
        thinkingConfig: { thinkingLevel: 'HIGH' },
        tools: [{ googleSearch: {} }],  // Gemini-only; silently dropped for Claude by ai-client
    };

    // --- Middleware Splitter ---
    // Build a single concatenated treatment string and parse it into
    // per-sequence chunks using the [SEQUENCE N START/END] delimiters.
    // This cleanly ignores any floating ACT headers or un-tagged text.
    const fullTreatmentText = [
        treatment.act_1 || '',
        treatment.act_2a || '',
        treatment.act_2b || '',
        treatment.act_3 || ''
    ].join('\n\n');

    const parsedTreatmentBlocks = parseSequenceBlocks(fullTreatmentText);

    // --- Iterative Loop ---
    let allSequences = [];
    let previousSequenceClimax = 'N/A - Start of Film';

    let globalSceneIndex = 1;

    for (let i = 1; i <= 8; i++) {
        console.log(`  Stage 6 Chain: Generating Sequence ${i}/8...`);

        // Inject ONLY this sequence's beats (JSON is already per-sequence)
        const currentBeats = beats.find(b => b.sequence_number === i);

        // Inject ONLY this sequence's parsed treatment text
        const currentTreatmentText = parsedTreatmentBlocks[i] || '';
        if (!currentTreatmentText) {
            console.warn(`  Warning: No [SEQUENCE ${i} START/END] block found in treatment. Falling back to full act text.`);
        }

        const prompt = `${sourceAuthorityBlock ? sourceAuthorityBlock + '\n\n' : ''}PITCH:
${JSON.stringify(pitch, null, 2)}

CHARACTERS:
${JSON.stringify(characters, null, 2)}

CURRENT SEQUENCE BEATS (Sequence ${i} only):
${JSON.stringify(currentBeats, null, 2)}

CURRENT SEQUENCE NARRATIVE EXPANSION (Sequence ${i} only):
${currentTreatmentText}

<previous_sequence_climax>
${previousSequenceClimax}
</previous_sequence_climax>

OBJECTIVE: Break down Sequence ${i} into 8 to 12 scenes. Your first scene must seamlessly continue from the <previous_sequence_climax> above. Focus on detailed, physical Narrative Action. Return a JSON object for this sequence only.`;

        try {
            const result = await generateContent({
                model, geminiApiKey, anthropicApiKey,
                contents: [prompt],
                config,
                schema: sequenceSchema
            });

            const parsedSeq = JSON.parse(result.text);
            parsedSeq.sequence_number = i;

            // Enforce globally unique scene numbers across all sequences
            // so server lookups by scene_number are always unambiguous.
            if (parsedSeq.scenes) {
                parsedSeq.scenes.forEach((scene) => {
                    scene.scene_number = globalSceneIndex++;
                });
            }

            allSequences.push(parsedSeq);

            // --- State Pass ---
            // Capture only the final scene of this sequence as the climax anchor
            // for the next iteration. This minimises context payload to a single
            // scene rather than the full previous sequence JSON dump.
            if (parsedSeq.scenes && parsedSeq.scenes.length > 0) {
                const lastScene = parsedSeq.scenes[parsedSeq.scenes.length - 1];
                previousSequenceClimax = `Scene ${lastScene.scene_number}: ${lastScene.scene_heading}\n\n${lastScene.narrative_action}`;
            }

            if (onProgress) onProgress(i, 8);
        } catch (error) {
            console.error(`Error generating sequence ${i}:`, error);
            throw error;
        }
    }

    // --- Concatenate ---
    // allSequences is the master Scene Blueprint document (array of 8 objects).
    return allSequences;
};

module.exports = { generateStage6Scenes };
