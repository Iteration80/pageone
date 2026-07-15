const { generateContent } = require('./ai-client');
const {
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('./memory_contract');
const { parseJsonWithRepair } = require('./json_parse');
const { deriveBlueprintPageCounts } = require('../utils/blueprint_pages');
const { loadSkill } = require('../utils/skills_cache');

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

function compactText(value, maxChars = 4000) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 120).trim()}\n\n[...truncated ${text.length - maxChars + 120} chars...]`;
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

async function callStage6Model(generateContentFn, request, { label = 'Stage 6 scene call', retries = 2, delayMs = 750 } = {}) {
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

async function parseStage6JsonResponse(response, {
    schema,
    label = 'Stage 6 response',
    generateContentFn,
    model,
    geminiApiKey,
    anthropicApiKey,
    retryDelayMs = 750
}) {
    try {
        return {
            parsed: parseJsonWithRepair(response.text, { schema, label }),
            usage: response.usage
        };
    } catch (parseError) {
        console.warn(`${label} JSON repair failed locally; retrying with model repair: ${parseError.message}`);
        const repairResponse = await callStage6Model(generateContentFn, {
            model,
            geminiApiKey,
            anthropicApiKey,
            contents: [`The text below was intended to be valid JSON for ${label}, but it contains JSON syntax errors such as an unterminated string, missing comma, unescaped quote, truncation, or prose around the object.

Repair ONLY the JSON syntax. Preserve every available story detail, field name, scene heading, scene number, narrative action, and continuity detail. If a string is cut off, close it cleanly without inventing new plot. Return valid JSON only.

MALFORMED JSON:
${response.text}`],
            config: {
                systemInstruction: 'You are a strict JSON repair tool. Return only valid JSON conforming to the provided schema. Do not add commentary, markdown, or new story content.',
                temperature: 0,
                maxOutputTokens: 32000
            },
            schema
        }, {
            label: `${label} JSON repair`,
            retries: 2,
            delayMs: retryDelayMs
        });

        try {
            return {
                parsed: parseJsonWithRepair(repairResponse.text, { schema, label: `${label} repaired response` }),
                usage: combineUsage(response.usage, repairResponse.usage)
            };
        } catch (repairError) {
            const error = new Error(`${label} could not be repaired after retry: ${repairError.message}`);
            error.cause = parseError;
            throw error;
        }
    }
}

function validateSequenceBlueprint(sequence, sequenceNumber) {
    if (!sequence || typeof sequence !== 'object') {
        throw new Error(`Stage 6 Sequence ${sequenceNumber} response was not a JSON object.`);
    }
    if (!Array.isArray(sequence.scenes) || sequence.scenes.length === 0) {
        throw new Error(`Stage 6 Sequence ${sequenceNumber} response did not include scenes.`);
    }
    return sequence;
}

function treatmentActTextForSequence(treatment = {}, sequenceNumber) {
    if (sequenceNumber <= 2) return treatment.act_1 || '';
    if (sequenceNumber <= 4) return treatment.act_2a || '';
    if (sequenceNumber <= 6) return treatment.act_2b || '';
    return treatment.act_3 || '';
}

function buildTreatmentSequenceIndex(parsedTreatmentBlocks = {}, treatment = {}) {
    const lines = [];
    for (let i = 1; i <= 8; i++) {
        const block = parsedTreatmentBlocks[i] || treatmentActTextForSequence(treatment, i);
        const titleMatch = String(block || '').match(/^\s*SEQUENCE\s+\d+\s*:\s*(.+?)\s*$/im);
        const title = titleMatch ? titleMatch[1].trim() : `Sequence ${i}`;
        lines.push(`Sequence ${i}: ${title}\n${compactText(block || 'No sequence text found.', 900)}`);
    }
    return lines.join('\n\n---\n\n');
}

function findSequenceContract(continuityLedger, sequenceNumber) {
    const contracts = continuityLedger?.sequence_contracts;
    if (!Array.isArray(contracts)) return null;
    return contracts.find(item => Number(item.sequence_number) === Number(sequenceNumber)) || null;
}

function formatContinuityLedgerForPrompt(continuityLedger) {
    if (!continuityLedger) return '';
    return compactText(JSON.stringify(continuityLedger, null, 2), 9000);
}

async function buildContinuityLedger({
    generateContentFn,
    model,
    geminiApiKey,
    anthropicApiKey,
    pitch,
    characters,
    beats,
    fullTreatmentText,
    sourceAuthorityBlock = '',
    retryDelayMs = 750
}) {
    const continuityLedgerSchema = {
        type: 'object',
        properties: {
            global_locks: {
                type: 'array',
                description: 'Continuity-sensitive facts from the approved treatment and characters that Stage 6 must preserve.',
                items: {
                    type: 'object',
                    properties: {
                        category: { type: 'string' },
                        detail: { type: 'string' },
                        source_anchor: { type: 'string' },
                        sequences: { type: 'array', items: { type: 'number' } }
                    },
                    required: ['category', 'detail', 'source_anchor', 'sequences']
                }
            },
            sequence_contracts: {
                type: 'array',
                description: 'Per-sequence continuity contracts distilled from the approved treatment.',
                items: {
                    type: 'object',
                    properties: {
                        sequence_number: { type: 'number' },
                        starts_after: { type: 'string' },
                        ends_with: { type: 'string' },
                        must_include: { type: 'array', items: { type: 'string' } },
                        must_not_change: { type: 'array', items: { type: 'string' } },
                        continuity_dependencies: { type: 'array', items: { type: 'string' } }
                    },
                    required: ['sequence_number', 'starts_after', 'ends_with', 'must_include', 'must_not_change', 'continuity_dependencies']
                }
            }
        },
        required: ['global_locks', 'sequence_contracts']
    };

    const prompt = `Build a Stage 6 continuity ledger from the approved upstream material.

Purpose: the scene-blueprint agent will be creative with scene splitting, blocking, micro-conflict, and physical staging, but it must not arbitrarily alter approved plot mechanics, character facts, recurring props, captures/releases/deaths, body/identity rules, family counts, backstory reveals, named gags/payoffs, discovery mechanisms, or sequence endpoints.

Extract concrete locks only. Do not invent new locks. Include details even if they seem small when they create a future payoff or continuity dependency.

${sourceAuthorityBlock ? `PROJECT MEMORY / SOURCE AUTHORITY:\n${sourceAuthorityBlock}\n` : ''}
PITCH:
${JSON.stringify(pitch, null, 2)}

CHARACTERS:
${JSON.stringify(characters, null, 2)}

BEATS:
${JSON.stringify(beats, null, 2)}

APPROVED TREATMENT:
${fullTreatmentText}`;

    const result = await callStage6Model(generateContentFn, {
        model,
        geminiApiKey,
        anthropicApiKey,
        contents: [prompt],
        config: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: continuityLedgerSchema,
            maxOutputTokens: 16000
        },
        schema: continuityLedgerSchema
    }, {
        label: 'Stage 6 continuity ledger',
        retries: 2,
        delayMs: retryDelayMs
    });
    const { parsed, usage } = await parseStage6JsonResponse(result, {
        schema: continuityLedgerSchema,
        label: 'Stage 6 continuity ledger response',
        generateContentFn,
        model,
        geminiApiKey,
        anthropicApiKey,
        retryDelayMs
    });

    return {
        ledger: parsed,
        usage
    };
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
const generateStage6Scenes = async (pitch, characters, beats, treatment, onProgress = null, sourceAuthorityBlock = '', modelConfig = {}, generationNotes = '') => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        generateContentFn = generateContent,
        retryDelayMs = 750
    } = modelConfig;

    const scenesSOP = loadSkill('skill_stage6_scenes');

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
        required: ['sequence_title', 'scenes']
    };

    const config = {
        systemInstruction: buildMemorySourceSystemInstruction(scenesSOP, 'Stage 6 Scene Blueprint'),
        temperature: 0.55,
        maxOutputTokens: 32000,
        thinkingConfig: { thinkingLevel: 'HIGH' },
        tools: [{ googleSearch: {} }],  // Gemini-only; silently dropped for Claude by ai-client
    };
    const sourceBlock = buildMemorySourcePromptBlock(sourceAuthorityBlock, 'Stage 6 Scene Blueprint');
    const writerNotes = String(generationNotes || '').trim();

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
    const treatmentSequenceIndex = buildTreatmentSequenceIndex(parsedTreatmentBlocks, treatment);

    const usageList = [];

    // --- Location Dictionary Extraction ---
    // One lightweight call to extract canonical location names from the full
    // treatment. This list is injected into every per-sequence prompt so the
    // agent uses consistent slugline locations instead of hallucinating new ones.
    let canonicalLocations = '';
    try {
        console.log('  Stage 6: Extracting canonical locations from treatment...');
        const locationSchema = { type: 'object', properties: { locations: { type: 'array', items: { type: 'string' } } }, required: ['locations'] };
        const locResult = await callStage6Model(generateContentFn, {
            model, geminiApiKey, anthropicApiKey,
            contents: [`Extract every distinct physical location mentioned in this screenplay treatment. Return the location name as it should appear in a scene heading (e.g., "MEDICAL BAY", "COMMAND DECK", "MAIN CORRIDOR"). Include interior/exterior qualifiers only when a location has both (e.g., list both if scenes happen inside and outside). Be exhaustive — scan the entire text.\n\nTREATMENT:\n${fullTreatmentText}`],
            config: {
                temperature: 0.3,
                responseMimeType: 'application/json',
                responseSchema: locationSchema,
                maxOutputTokens: 12000
            },
            schema: locationSchema,
        }, {
            label: 'Stage 6 location extraction',
            retries: 2,
            delayMs: retryDelayMs
        });
        const { parsed: locData, usage: locUsage } = await parseStage6JsonResponse(locResult, {
            schema: locationSchema,
            label: 'Stage 6 location extraction response',
            generateContentFn,
            model,
            geminiApiKey,
            anthropicApiKey,
            retryDelayMs
        });
        if (locData.locations?.length) {
            canonicalLocations = locData.locations.join(', ');
            console.log(`  Stage 6: Extracted ${locData.locations.length} locations: ${canonicalLocations}`);
        }
        usageList.push(locUsage);
    } catch (err) {
        console.warn('  Stage 6: Location extraction failed (non-fatal):', err.message);
    }

    let continuityLedger = null;
    let continuityLedgerText = '';
    try {
        console.log('  Stage 6: Building continuity ledger from approved treatment...');
        const ledgerResult = await buildContinuityLedger({
            generateContentFn,
            model,
            geminiApiKey,
            anthropicApiKey,
            pitch,
            characters,
            beats,
            fullTreatmentText,
            sourceAuthorityBlock,
            retryDelayMs
        });
        continuityLedger = ledgerResult.ledger;
        continuityLedgerText = formatContinuityLedgerForPrompt(continuityLedger);
        if (continuityLedger?.global_locks?.length) {
            console.log(`  Stage 6: Extracted ${continuityLedger.global_locks.length} continuity locks.`);
        }
        usageList.push(ledgerResult.usage);
    } catch (err) {
        console.warn('  Stage 6: Continuity ledger extraction failed (non-fatal):', err.message);
    }

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
        const currentSequenceContract = findSequenceContract(continuityLedger, i);

        const prompt = `${sourceBlock ? sourceBlock + '\n\n' : ''}PITCH:
${JSON.stringify(pitch, null, 2)}

CHARACTERS:
${JSON.stringify(characters, null, 2)}
${canonicalLocations ? `\nCANONICAL LOCATIONS (use these exact names in scene headings — do not invent new locations unless the narrative explicitly requires a space not in this list):\n${canonicalLocations}\n` : ''}
GLOBAL TREATMENT SEQUENCE INDEX (full-story map for continuity only - do not adapt scenes outside Sequence ${i}, but preserve their setup/payoff logic):
${treatmentSequenceIndex}

${continuityLedgerText ? `GLOBAL CONTINUITY LEDGER (binding locks distilled from approved treatment and character profiles - preserve these unless the current sequence text explicitly revises them):\n${continuityLedgerText}\n` : ''}
${currentSequenceContract ? `CURRENT SEQUENCE CONTINUITY CONTRACT (mandatory for Sequence ${i}):\n${JSON.stringify(currentSequenceContract, null, 2)}\n` : ''}
${writerNotes ? `WRITER REGENERATION NOTES (apply as creative guidance without breaking the approved treatment locks):\n${writerNotes}\n` : ''}
CURRENT SEQUENCE BEATS (Sequence ${i} only):
${JSON.stringify(currentBeats, null, 2)}

CURRENT SEQUENCE NARRATIVE EXPANSION (Sequence ${i} only):
${currentTreatmentText || treatmentActTextForSequence(treatment, i)}

<previous_sequence_climax>
${previousSequenceClimax}
</previous_sequence_climax>

OBJECTIVE: Break down Sequence ${i} into 8 to 12 scenes. Your first scene must seamlessly continue from the <previous_sequence_climax> above. Focus on detailed, physical Narrative Action.

FIDELITY CHECK BEFORE YOU RESPOND:
- Preserve every concrete event, character placement, prop path, discovery mechanism, named gag/payoff, body/identity rule, backstory reveal, family count, death/survival state, and sequence endpoint from the CURRENT SEQUENCE NARRATIVE EXPANSION and CURRENT SEQUENCE CONTINUITY CONTRACT.
- You may invent connective blocking, minor obstacles, scene headings, and visual texture only when they do not replace, relocate, omit, or contradict approved treatment content.
- If the approved treatment names a character in a scene, do not swap them for generic guards/recruits/victims. If it specifies one body, one prop, or one route, do not multiply it.

Return a JSON object for this sequence only.`;

        try {
            let parsedSeq = null;
            let sequenceUsage = null;
            let lastSequenceError = null;
            for (let structuralAttempt = 0; structuralAttempt < 2; structuralAttempt += 1) {
                try {
                    const result = await callStage6Model(generateContentFn, {
                        model, geminiApiKey, anthropicApiKey,
                        contents: [prompt],
                        config,
                        schema: sequenceSchema
                    }, {
                        label: `Stage 6 Sequence ${i}`,
                        retries: 2,
                        delayMs: retryDelayMs
                    });
                    const { parsed, usage } = await parseStage6JsonResponse(result, {
                        schema: sequenceSchema,
                        label: `Stage 6 Sequence ${i} response`,
                        generateContentFn,
                        model,
                        geminiApiKey,
                        anthropicApiKey,
                        retryDelayMs
                    });
                    parsedSeq = validateSequenceBlueprint(parsed, i);
                    sequenceUsage = usage;
                    break;
                } catch (error) {
                    lastSequenceError = error;
                    if (structuralAttempt === 0) {
                        console.warn(`Stage 6 Sequence ${i} returned unusable JSON after repair: ${error.message}. Retrying full sequence generation...`);
                        continue;
                    }
                    throw error;
                }
            }
            if (!parsedSeq) throw lastSequenceError || new Error(`Stage 6 Sequence ${i} did not return a usable blueprint.`);
            usageList.push(sequenceUsage);
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
    // Page totals are derived from the scenes, never trusted from the model.
    deriveBlueprintPageCounts(allSequences);
    return { result: allSequences, usageList };
};

module.exports = { generateStage6Scenes };
