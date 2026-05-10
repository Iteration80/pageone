const { generateContent } = require('./ai-client');
const fs = require('fs');
const path = require('path');

const agent4Beats = async (pitchData, beatsData, charactersData, currentBeats = null, notes = null, pdfFile = null, onProgress = null, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = ''
    } = modelConfig;

    const skillPath = path.join(__dirname, '../skills/skill_stage4_beats.md');
    const beatsSOP = fs.readFileSync(skillPath, 'utf8');

    const treatmentSchema = {
        type: 'object',
        properties: {
            stc_genre_category: { type: 'string', description: "A short STC genre label, e.g. 'Golden Fleece' or 'Monster in the House'. No explanations." },
            hybrid_beat_sheet: {
                type: 'array',
                description: "Exactly 8 sequence objects, one per Gulino sequence.",
                items: {
                    type: 'object',
                    properties: {
                        sequence_number: { type: 'integer', description: "1 through 8." },
                        sequence_title: { type: 'string', description: "A short title for this sequence, WITHOUT numbering prefix." },
                        beats: {
                            type: 'array',
                            description: "The STC beats that fall within this sequence. Each sequence has 1-3 beats.",
                            items: {
                                type: 'object',
                                properties: {
                                    beat_name: { type: 'string', description: "The standard STC beat name, e.g. 'Opening Image', 'Catalyst', 'Break into Two'." },
                                    genre_variation_notes: { type: 'string', description: "How this beat is adapted for the specific STC genre." },
                                    emotional_arc: { type: 'string', description: "The emotional undercurrent running beneath the plot action." },
                                    pacing_notes: { type: 'string', description: "Pacing rhythm: where to speed up, where to breathe." },
                                    detailed_action: { type: 'string', description: "A dense paragraph (3+ sentences) detailing the exact narrative action." }
                                },
                                required: ['beat_name', 'genre_variation_notes', 'emotional_arc', 'pacing_notes', 'detailed_action']
                            }
                        }
                    },
                    required: ['sequence_number', 'sequence_title', 'beats']
                }
            }
        },
        required: ['stc_genre_category', 'hybrid_beat_sheet']
    };

    // Revision Bypass Logic
    if (notes && currentBeats) {
        console.log("  Surgical Revision Mode: Updating beats...");
        if (onProgress) onProgress('Applying surgical revision...');
        const revisionSystemInstruction = `${beatsSOP}\n\nROLE: Structural Story Analyst. Apply the user's note to the 15-point beat sheet. You MUST keep unaffected beats 100% identical. HOWEVER, if the user's note creates a structural ripple effect, you must update subsequent beats to maintain narrative logic. Do not alter the overarching 8-sequence structure. Maintain the exact same JSON schema.`;

        const sourceBlock = knowledgeContext ? `PROJECT SOURCE CANON:\n${knowledgeContext}\n\n` : '';
        const revisionPrompt = `${sourceBlock}USER NOTE: ${notes}

EXISTING BEATS:
${JSON.stringify(currentBeats, null, 2)}

Please apply the note surgically (allowing for ripple effects) and return the full updated beat sheet in JSON format.`;

        const response = await generateContent({
            model, geminiApiKey, anthropicApiKey,
            contents: [revisionPrompt],
            config: {
                systemInstruction: revisionSystemInstruction,
                temperature: 0.5,
            },
            schema: treatmentSchema
        });

        return { result: JSON.parse(response.text), usage: response.usage };
    }

    if (onProgress) onProgress('Generating 15-Beat Sheet...');

    const systemInstruction = beatsSOP;

    const contents = [];

    if (pdfFile) {
        contents.push({
            inlineData: {
                data: pdfFile.buffer.toString("base64"),
                mimeType: pdfFile.mimetype || "application/pdf"
            }
        });
    }

    const sourceBlock = knowledgeContext ? `PROJECT SOURCE CANON:\n${knowledgeContext}\n\n` : '';
    let contentsText = `${sourceBlock}Analyze the following story material and produce a COMPLETE 15-Beat Sheet mapped onto 8 sequences.

APPROVED PITCH:
${JSON.stringify(pitchData, null, 2)}

8-SEQUENCE OUTLINE:
${JSON.stringify(beatsData, null, 2)}

CHARACTER PROFILES:
${JSON.stringify(charactersData, null, 2)}

IMPORTANT: You must return ALL 8 sequences with ALL 15 beats distributed across them. Every beat must have substantive content in all five fields.`;

    if (notes && currentBeats) {
        contentsText += `\n\nThe user has provided feedback for the beat sheet. Revise the existing beats based on these notes.\n\nEXISTING BEATS:\n${JSON.stringify(currentBeats, null, 2)}\n\nNOTES: ${notes}\n\nEnsure you return the FULL beat sheet in the proper JSON format.`;
    } else if (notes) {
        contentsText += `\n\nAdditional user notes: ${notes}`;
    }
    contents.push(contentsText);

    const response = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            systemInstruction,
            temperature: 0.6,
        },
        schema: treatmentSchema
    });

    const parsed = JSON.parse(response.text);
    const { usage } = response;

    // Validate the response has the expected structure
    if (!parsed.hybrid_beat_sheet || !Array.isArray(parsed.hybrid_beat_sheet) || parsed.hybrid_beat_sheet.length === 0) {
        throw new Error('Treatment generation returned an incomplete response. Missing hybrid_beat_sheet.');
    }

    // Check that at least some sequences have beats
    const totalBeats = parsed.hybrid_beat_sheet.reduce((sum, seq) => sum + (seq.beats ? seq.beats.length : 0), 0);
    if (totalBeats === 0) {
        throw new Error('Treatment generation returned sequences with no beats. Please retry.');
    }

    return { result: parsed, usage };
};

module.exports = { agent4Beats };
