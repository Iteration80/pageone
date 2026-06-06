const { generateContent } = require('./ai-client');
const {
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('./memory_contract');
const { parseJsonWithRepair } = require('./json_parse');
const {
    applyStructuralPatchToItems,
    cloneValue,
    isBroadRevisionIntent,
    labelsEqual,
    parseSequenceTargets,
    textMentionsLabel
} = require('../utils/revision_patch');
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

function combineUsage(...usages) {
    const valid = usages.filter(Boolean);
    if (!valid.length) return undefined;
    return valid.reduce((acc, usage) => ({
        model: usage.model || acc.model,
        inputTokens: (acc.inputTokens || 0) + (usage.inputTokens || 0),
        outputTokens: (acc.outputTokens || 0) + (usage.outputTokens || 0)
    }), { model: valid[0].model, inputTokens: 0, outputTokens: 0 });
}

function isTransientAiError(error) {
    const code = String(error?.code || error?.cause?.code || '');
    if (/ECONNRESET|ETIMEDOUT|UND_ERR|EPIPE|ECONNREFUSED/i.test(code)) return true;
    const message = String(error?.message || error || '');
    return /terminated|socket|network|fetch failed|aborted|timeout|temporarily unavailable|overloaded|rate limit/i.test(message);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function callStage4Model(generateContentFn, request, { label = 'Stage 4 beat call', retries = 2, delayMs = 750 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await generateContentFn(request);
        } catch (error) {
            lastError = error;
            const message = error.message || String(error);
            if (!isTransientAiError(error)) throw error;
            if (attempt >= retries) {
                const finalError = new Error(`${label} failed after ${attempt + 1} attempts: ${message}`);
                finalError.cause = error;
                throw finalError;
            }
            console.warn(`${label} failed with transient error "${message}". Retrying (${attempt + 1}/${retries})...`);
            if (delayMs > 0) await wait(delayMs * (attempt + 1));
        }
    }
    throw lastError;
}

async function parseStage4Response(response, {
    treatmentSchema,
    generateContentFn,
    model,
    geminiApiKey,
    anthropicApiKey,
    retryDelayMs
}) {
    try {
        const parsed = parseJsonWithRepair(response.text, { schema: treatmentSchema, label: 'Stage 4 beat response' });
        return {
            result: validateStage4BeatSheet(parsed),
            usage: response.usage
        };
    } catch (parseError) {
        console.warn(`Stage 4 beat JSON repair failed locally; retrying with model repair: ${parseError.message}`);
        const repairResponse = await callStage4Model(generateContentFn, {
            model,
            geminiApiKey,
            anthropicApiKey,
            contents: [`The text below was intended to be a complete Stage 4 beat sheet JSON object, but it contains JSON syntax errors such as an unterminated string, missing comma, unescaped quote, or prose around the object.

Repair ONLY the JSON syntax. Preserve every available story detail, field name, sequence, beat name, and detailed action. If a string is cut off, close it cleanly without inventing new plot. Return valid JSON only.

MALFORMED JSON:
${response.text}`],
            config: {
                systemInstruction: 'You are a strict JSON repair tool. Return only valid JSON conforming to the provided schema. Do not add commentary, markdown, or new story content.',
                temperature: 0,
                maxOutputTokens: 32000
            },
            schema: treatmentSchema
        }, {
            label: 'Stage 4 beat JSON repair',
            retries: 2,
            delayMs: retryDelayMs
        });

        try {
            const repaired = parseJsonWithRepair(repairResponse.text, { schema: treatmentSchema, label: 'Stage 4 repaired beat response' });
            return {
                result: validateStage4BeatSheet(repaired, 'Stage 4 repaired beat response'),
                usage: combineUsage(response.usage, repairResponse.usage)
            };
        } catch (repairError) {
            const error = new Error(`Stage 4 beat response could not be repaired after retry: ${repairError.message}`);
            error.cause = parseError;
            throw error;
        }
    }
}

function validateStage4BeatSheet(parsed, label = 'Stage 4 beat response') {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`${label} was not a JSON object.`);
    }
    if (!Array.isArray(parsed.hybrid_beat_sheet) || parsed.hybrid_beat_sheet.length === 0) {
        throw new Error(`${label} returned an incomplete response. Missing hybrid_beat_sheet.`);
    }
    const totalBeats = parsed.hybrid_beat_sheet.reduce((sum, seq) => sum + (Array.isArray(seq.beats) ? seq.beats.length : 0), 0);
    if (totalBeats === 0) {
        throw new Error(`${label} returned sequences with no beats. Please retry.`);
    }
    return parsed;
}

function stage4BeatPatchOptions() {
    return {
        getLabel: beat => beat.beat_name || '',
        setLabel: (beat, label) => { beat.beat_name = label || beat.beat_name || 'Revised Beat'; },
        setBody: (beat, body) => { beat.detailed_action = body || beat.detailed_action || ''; },
        buildNewItem: op => ({
            beat_name: op.newLabel || 'Inserted Beat',
            genre_variation_notes: '',
            emotional_arc: '',
            pacing_notes: '',
            detailed_action: op.newBody || ''
        })
    };
}

function sequenceNumber(sequence = {}) {
    const numeric = Number(sequence.sequence_number);
    return Number.isFinite(numeric) ? numeric : null;
}

function findRevisedBeatByName(revisedBeats = [], currentBeat = {}) {
    return revisedBeats.find(beat => labelsEqual(beat?.beat_name || '', currentBeat?.beat_name || '')) || null;
}

function mergeStage4SequenceBeats(currentSequence = {}, revisedSequence = {}, notes = '', sequenceTargeted = false) {
    const currentBeats = Array.isArray(currentSequence.beats) ? currentSequence.beats : [];
    const revisedBeats = Array.isArray(revisedSequence.beats) ? revisedSequence.beats : [];
    let changed = 0;
    let beats = currentBeats.map(beat => {
        const targeted = sequenceTargeted || textMentionsLabel(notes, beat.beat_name || '');
        if (!targeted) return cloneValue(beat);
        const replacement = findRevisedBeatByName(revisedBeats, beat);
        if (!replacement) return cloneValue(beat);
        changed += 1;
        return cloneValue(replacement);
    });

    for (const revisedBeat of revisedBeats) {
        const label = revisedBeat?.beat_name || '';
        if (!label || beats.some(beat => labelsEqual(beat?.beat_name || '', label))) continue;
        if (sequenceTargeted || textMentionsLabel(notes, label) || /\b(add|insert|new|restore|include|bring back)\b/i.test(notes)) {
            beats.push(cloneValue(revisedBeat));
            changed += 1;
        }
    }

    const patched = applyStructuralPatchToItems(beats, notes, stage4BeatPatchOptions());
    beats = patched.items;
    changed += patched.appliedCount;
    return { beats, changed };
}

function mergeSurgicalStage4Result(currentBeats = {}, parsedResult = {}, notes = '') {
    if (isBroadRevisionIntent(notes)) return parsedResult;
    const currentSheet = Array.isArray(currentBeats?.hybrid_beat_sheet) ? currentBeats.hybrid_beat_sheet : [];
    const revisedSheet = Array.isArray(parsedResult?.hybrid_beat_sheet) ? parsedResult.hybrid_beat_sheet : [];
    if (!currentSheet.length || !revisedSheet.length) return parsedResult;

    const sequenceTargets = parseSequenceTargets(notes);
    const revisedByNumber = new Map(revisedSheet.map(sequence => [sequenceNumber(sequence), sequence]));
    let changed = 0;
    const mergedSheet = currentSheet.map(currentSequence => {
        const number = sequenceNumber(currentSequence);
        const revisedSequence = revisedByNumber.get(number);
        if (!revisedSequence) return cloneValue(currentSequence);
        const sequenceTargeted = sequenceTargets.has(number) || textMentionsLabel(notes, currentSequence.sequence_title || '');
        const mergedSequence = cloneValue(currentSequence);
        if (sequenceTargeted && revisedSequence.sequence_title) mergedSequence.sequence_title = revisedSequence.sequence_title;
        const mergedBeats = mergeStage4SequenceBeats(currentSequence, revisedSequence, notes, sequenceTargeted);
        if (mergedBeats.changed > 0) {
            mergedSequence.beats = mergedBeats.beats;
            changed += mergedBeats.changed;
        }
        return mergedSequence;
    });

    if (!changed) return parsedResult;
    return {
        ...parsedResult,
        hybrid_beat_sheet: mergedSheet
    };
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
        generateContentFn = generateContent,
        retryDelayMs = 750
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

        const response = await callStage4Model(generateContentFn, {
            model, geminiApiKey, anthropicApiKey,
            contents: [revisionPrompt],
            config: {
                systemInstruction: revisionSystemInstruction,
                temperature: 0.5,
                maxOutputTokens: 32000
            },
            schema: treatmentSchema
        }, {
            label: 'Stage 4 beat revision',
            retries: 2,
            delayMs: retryDelayMs
        });

        const parsed = await parseStage4Response(response, {
            treatmentSchema,
            generateContentFn,
            model,
            geminiApiKey,
            anthropicApiKey,
            retryDelayMs
        });
        parsed.result = mergeSurgicalStage4Result(currentBeats, parsed.result, notes);
        return parsed;
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

    const response = await callStage4Model(generateContentFn, {
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            systemInstruction,
            temperature: 0.6,
            maxOutputTokens: 32000
        },
        schema: treatmentSchema
    }, {
        label: 'Stage 4 beat generation',
        retries: 2,
        delayMs: retryDelayMs
    });

    return parseStage4Response(response, {
        treatmentSchema,
        generateContentFn,
        model,
        geminiApiKey,
        anthropicApiKey,
        retryDelayMs
    });
};

module.exports = { agent4Beats };
