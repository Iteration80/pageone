const { GoogleGenAI, Type } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const agent4Beats = async (pitchData, beatsData, charactersData, currentTreatment = null, notes = null, pdfFile = null) => {
    const systemInstruction = `You are an elite Master Story Architect. Your task is to produce a COMPLETE, DETAILED 15-Beat Sheet mapped onto 8 sequences.

CRITICAL RULES:
1. You MUST produce exactly 8 sequence objects in the hybrid_beat_sheet array.
2. You MUST distribute Snyder's 15 beats across those 8 sequences (some sequences will have 1 beat, some will have 2-3).
3. The stc_genre_category must be a short label like "Monster in the House" or "Golden Fleece". Do NOT include explanations.
4. The sequence_title must be a short title WITHOUT numbering prefix (e.g. "Desperate Measures" not "Sequence 1: Desperate Measures").
5. Each beat MUST have all five fields filled with substantive content: beat_name, genre_variation_notes, emotional_arc, pacing_notes, detailed_action.
6. The detailed_action field must be a dense paragraph of at least 3 sentences.
7. Genre-Specific Adaptation: Apply specific STC genre conventions.
8. Emotional Arc & Pacing: Explicitly define the emotional undercurrent and pacing rhythm for every beat.`;

    const treatmentSchema = {
        type: Type.OBJECT,
        properties: {
            stc_genre_category: { type: Type.STRING, description: "A short STC genre label, e.g. 'Golden Fleece' or 'Monster in the House'. No explanations." },
            hybrid_beat_sheet: {
                type: Type.ARRAY,
                description: "Exactly 8 sequence objects, one per Gulino sequence.",
                items: {
                    type: Type.OBJECT,
                    properties: {
                        sequence_number: { type: Type.INTEGER, description: "1 through 8." },
                        sequence_title: { type: Type.STRING, description: "A short title for this sequence, WITHOUT numbering prefix." },
                        beats: {
                            type: Type.ARRAY,
                            description: "The STC beats that fall within this sequence. Each sequence has 1-3 beats.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    beat_name: { type: Type.STRING, description: "The standard STC beat name, e.g. 'Opening Image', 'Catalyst', 'Break into Two'." },
                                    genre_variation_notes: { type: Type.STRING, description: "How this beat is adapted for the specific STC genre." },
                                    emotional_arc: { type: Type.STRING, description: "The emotional undercurrent running beneath the plot action." },
                                    pacing_notes: { type: Type.STRING, description: "Pacing rhythm: where to speed up, where to breathe." },
                                    detailed_action: { type: Type.STRING, description: "A dense paragraph (3+ sentences) detailing the exact narrative action." }
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

    const contents = [];

    if (pdfFile) {
        contents.push({
            inlineData: {
                data: pdfFile.buffer.toString("base64"),
                mimeType: pdfFile.mimetype || "application/pdf"
            }
        });
    }

    let contentsText = `Analyze the following story material and produce a COMPLETE 15-Beat Sheet mapped onto 8 sequences.

APPROVED PITCH:
${JSON.stringify(pitchData, null, 2)}

8-SEQUENCE OUTLINE:
${JSON.stringify(beatsData, null, 2)}

CHARACTER PROFILES:
${JSON.stringify(charactersData, null, 2)}

IMPORTANT: You must return ALL 8 sequences with ALL 15 beats distributed across them. Every beat must have substantive content in all five fields.`;

    if (notes && currentTreatment) {
        contentsText += `\n\nThe user has provided feedback for the treatment. Revise the existing treatment based on these notes.\n\nEXISTING TREATMENT:\n${JSON.stringify(currentTreatment, null, 2)}\n\nNOTES: ${notes}\n\nEnsure you return the FULL treatment in the proper JSON format.`;
    } else if (notes) {
        contentsText += `\n\nAdditional user notes: ${notes}`;
    }
    contents.push(contentsText);

    const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: contents,
        config: {
            systemInstruction: systemInstruction,
            temperature: 0.6,
            responseMimeType: "application/json",
            responseSchema: treatmentSchema,
        }
    });

    const parsed = JSON.parse(response.text);

    // Validate the response has the expected structure
    if (!parsed.hybrid_beat_sheet || !Array.isArray(parsed.hybrid_beat_sheet) || parsed.hybrid_beat_sheet.length === 0) {
        throw new Error('Treatment generation returned an incomplete response. Missing hybrid_beat_sheet.');
    }

    // Check that at least some sequences have beats
    const totalBeats = parsed.hybrid_beat_sheet.reduce((sum, seq) => sum + (seq.beats ? seq.beats.length : 0), 0);
    if (totalBeats === 0) {
        throw new Error('Treatment generation returned sequences with no beats. Please retry.');
    }

    return parsed;
};

module.exports = { agent4Beats };
