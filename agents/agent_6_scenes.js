const { generateContent } = require('./ai-client');
const {
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('./memory_contract');
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

function compactText(value, maxChars = 4000) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 120).trim()}\n\n[...truncated ${text.length - maxChars + 120} chars...]`;
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
    sourceAuthorityBlock = ''
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

    const result = await generateContentFn({
        model,
        geminiApiKey,
        anthropicApiKey,
        contents: [prompt],
        config: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: continuityLedgerSchema
        },
        schema: continuityLedgerSchema
    });

    return {
        ledger: JSON.parse(result.text),
        usage: result.usage
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
        generateContentFn = generateContent
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
        systemInstruction: buildMemorySourceSystemInstruction(scenesSOP, 'Stage 6 Scene Blueprint'),
        temperature: 0.55,
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
        const locResult = await generateContentFn({
            model, geminiApiKey, anthropicApiKey,
            contents: [`Extract every distinct physical location mentioned in this screenplay treatment. Return the location name as it should appear in a scene heading (e.g., "MEDICAL BAY", "COMMAND DECK", "MAIN CORRIDOR"). Include interior/exterior qualifiers only when a location has both (e.g., list both if scenes happen inside and outside). Be exhaustive — scan the entire text.\n\nTREATMENT:\n${fullTreatmentText}`],
            config: {
                temperature: 0.3,
                responseMimeType: 'application/json',
                responseSchema: { type: 'object', properties: { locations: { type: 'array', items: { type: 'string' } } }, required: ['locations'] },
            },
            schema: { type: 'object', properties: { locations: { type: 'array', items: { type: 'string' } } }, required: ['locations'] },
        });
        const locData = JSON.parse(locResult.text);
        if (locData.locations?.length) {
            canonicalLocations = locData.locations.join(', ');
            console.log(`  Stage 6: Extracted ${locData.locations.length} locations: ${canonicalLocations}`);
        }
        usageList.push(locResult.usage);
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
            sourceAuthorityBlock
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
            const result = await generateContentFn({
                model, geminiApiKey, anthropicApiKey,
                contents: [prompt],
                config,
                schema: sequenceSchema
            });

            const parsedSeq = JSON.parse(result.text);
            usageList.push(result.usage);
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
    return { result: allSequences, usageList };
};

module.exports = { generateStage6Scenes };
