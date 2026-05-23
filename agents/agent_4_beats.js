const { generateContent } = require('./ai-client');
const {
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('./memory_contract');
const fs = require('fs');
const path = require('path');

function compactText(value, maxChars = 4000) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 120).trim()}\n\n[...truncated ${text.length - maxChars + 120} chars...]`;
}

function normalizeOutlineSequences(outline) {
    if (!outline) return [];
    if (Array.isArray(outline)) return outline;
    if (outline.outline) return normalizeOutlineSequences(outline.outline);
    if (typeof outline === 'object') {
        return ['act_1', 'act_2', 'act_3']
            .flatMap(key => Array.isArray(outline[key]) ? outline[key] : []);
    }
    return [];
}

function formatOutlineBeat(beat = {}, index = 0) {
    const label = beat.beat_label || beat.beat_name || beat.beat || `Beat ${index + 1}`;
    const description = beat.description || beat.detailed_action || beat.summary || '';
    return `- ${label}: ${compactText(description, 900)}`;
}

function formatCharacterLock(character = {}) {
    const core = character.psychological_core || {};
    const arc = character.arc || {};
    return [
        `${character.name || 'Unnamed Character'} (${character.role || 'role unknown'}): ${character.brief_summary || ''}`,
        core.desire ? `Want: ${core.desire}` : '',
        core.psychological_need || core.moral_need ? `Need: ${[core.psychological_need, core.moral_need].filter(Boolean).join(' / ')}` : '',
        core.ghost_and_wound ? `Wound: ${core.ghost_and_wound}` : '',
        arc.direction || arc.core_drive ? `Arc: ${[arc.direction, arc.core_drive].filter(Boolean).join(', ')}` : ''
    ].filter(Boolean).join(' | ');
}

function buildStage4BeatContract({ pitchData, beatsData, charactersData }) {
    const pitch = compactText(JSON.stringify(pitchData || {}, null, 2), 2400);
    const outlineSequences = normalizeOutlineSequences(beatsData);
    const outlineMap = outlineSequences.length
        ? outlineSequences.map((sequence, index) => {
            const sequenceNumber = sequence.sequence_number || sequence.sequence || index + 1;
            const title = sequence.sequence_number_and_title || sequence.sequence_title || `Sequence ${sequenceNumber}`;
            const beats = Array.isArray(sequence.beats) && sequence.beats.length
                ? sequence.beats.map(formatOutlineBeat).join('\n')
                : compactText(JSON.stringify(sequence, null, 2), 1200);
            return `Sequence ${sequenceNumber}: ${title}\n${beats}`;
        }).join('\n\n')
        : 'No Stage 2 outline provided.';

    const characters = Array.isArray(charactersData) && charactersData.length
        ? charactersData.map(formatCharacterLock).join('\n')
        : 'No character profiles provided.';

    return compactText(`## APPROVED STAGE 2 OUTLINE LOCK
Stage 4 is an expansion pass from the approved 8-sequence outline into a richer Save-the-Cat beat sheet. It is not a rewrite of the outline.

### Binding Rules
- Preserve the Stage 2 sequence order, act placement, reveal placement, escalation order, cause-and-effect chain, deaths/survival states, rules, transformations, and endpoints.
- Do not move a major event, reveal, transformation, set piece, or climax into a different sequence merely to satisfy a Save-the-Cat label.
- If the Stage 2 Midpoint is a reveal, reversal, false victory, or false defeat rather than a giant action set piece, make that existing outline moment function as the Midpoint.
- If a later Stage 2 event would make a louder cinematic Midpoint, leave it in its approved later sequence unless the writer explicitly asks to revise the outline.
- Use cinematic invention only as connective tissue, staging, pressure, humor, texture, and emotional escalation inside the approved sequence boundaries.
- When source canon, accepted divergences, and the Stage 2 outline appear to conflict, preserve source canon unless the packet or writer notes explicitly approve the divergence.

### Approved Pitch
${pitch}

### Approved 8-Sequence Outline
${outlineMap}

### Character Continuity Locks
${characters}

### Fidelity Check Before Final JSON
- Every sequence in the beat sheet must correspond to the same-numbered Stage 2 sequence.
- Every Stage 2 beat/reveal/set piece must still be present in the same sequence unless the writer's current notes explicitly change it.
- The STC beat names should describe the function of the approved outline events, not relocate the events to match the STC template.`, 14_000);
}

const agent4Beats = async (pitchData, beatsData, charactersData, currentBeats = null, notes = null, pdfFile = null, onProgress = null, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = '',
        generateContentFn = generateContent
    } = modelConfig;

    const skillPath = path.join(__dirname, '../skills/skill_stage4_beats.md');
    const beatsSOP = fs.readFileSync(skillPath, 'utf8');
    const systemInstruction = buildMemorySourceSystemInstruction(beatsSOP, 'Stage 4 Beat Sheet');
    const sourceBlock = buildMemorySourcePromptBlock(knowledgeContext, 'Stage 4 Beat Sheet');
    const beatContract = buildStage4BeatContract({ pitchData, beatsData, charactersData });

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
        const revisionSystemInstruction = `${systemInstruction}\n\nROLE: Structural Story Analyst. Apply the user's note to the 15-point beat sheet. You MUST keep unaffected beats 100% identical. HOWEVER, if the user's note creates a structural ripple effect, you must update subsequent beats to maintain narrative logic inside the approved Stage 2 sequence boundaries. Do not alter the overarching 8-sequence structure, sequence order, or approved outline event placement unless the user's note explicitly asks for that. Maintain the exact same JSON schema.`;

        const revisionPrompt = `${sourceBlock}

${beatContract}

USER NOTE: ${notes}

EXISTING BEATS:
${JSON.stringify(currentBeats, null, 2)}

Please apply the note surgically (allowing for ripple effects) and return the full updated beat sheet in JSON format.`;

        const response = await generateContentFn({
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

    const contents = [];

    if (pdfFile) {
        contents.push({
            inlineData: {
                data: pdfFile.buffer.toString("base64"),
                mimeType: pdfFile.mimetype || "application/pdf"
            }
        });
    }

    let contentsText = `${sourceBlock}

${beatContract}

Analyze the following approved story material and produce a COMPLETE 15-Beat Sheet mapped onto 8 sequences. The Stage 2 outline lock above is binding.

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

    const response = await generateContentFn({
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
