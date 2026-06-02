const { generateContent } = require('./ai-client');
const {
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('./memory_contract');

function compactText(value, maxChars = 4000) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 120).trim()}\n\n[...truncated ${text.length - maxChars + 120} chars...]`;
}

function parseRevisionTargets(currentBlueprint = [], feedback = '') {
    const text = String(feedback || '');
    const lower = text.toLowerCase();
    const sceneNumbers = new Set();
    const sequenceNumbers = new Set();

    for (const match of text.matchAll(/\bscene[s]?\s+(\d+)(?:\s*(?:-|to|through|thru)\s*(\d+))?/gi)) {
        const start = Number(match[1]);
        const end = Number(match[2] || match[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        for (let n = Math.min(start, end); n <= Math.max(start, end); n++) sceneNumbers.add(n);
    }

    for (const match of text.matchAll(/\b(\d+)\s*\+\s*(\d+)(?:\s*\+\s*(\d+))?/g)) {
        [match[1], match[2], match[3]].filter(Boolean).map(Number).forEach(n => {
            if (Number.isFinite(n)) sceneNumbers.add(n);
        });
    }

    for (const match of text.matchAll(/\bsequence[s]?\s+(\d+)(?:\s*(?:-|to|through|thru)\s*(\d+))?/gi)) {
        const start = Number(match[1]);
        const end = Number(match[2] || match[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        for (let n = Math.min(start, end); n <= Math.max(start, end); n++) sequenceNumbers.add(n);
    }

    const sequenceByScene = new Map();
    currentBlueprint.forEach(seq => {
        seq.scenes?.forEach(scene => sequenceByScene.set(Number(scene.scene_number), Number(seq.sequence_number)));
    });
    sceneNumbers.forEach(sceneNumber => {
        const seqNum = sequenceByScene.get(Number(sceneNumber));
        if (seqNum) sequenceNumbers.add(seqNum);
    });

    const hasExplicitTargets = sceneNumbers.size > 0 || sequenceNumbers.size > 0;
    const globalEdit = /\b(entire|all scenes|full blueprint|whole blueprint|throughout|every scene|global|final-polish|final polish)\b/i.test(lower);
    return {
        sceneNumbers,
        sequenceNumbers,
        hasExplicitTargets,
        includeAllFull: globalEdit && !hasExplicitTargets
    };
}

function buildRevisionBlueprintContext(currentBlueprint = [], feedback = '') {
    const targets = parseRevisionTargets(currentBlueprint, feedback);
    const targetSummary = [
        targets.sceneNumbers.size ? `Scenes: ${Array.from(targets.sceneNumbers).sort((a, b) => a - b).join(', ')}` : '',
        targets.sequenceNumbers.size ? `Sequences: ${Array.from(targets.sequenceNumbers).sort((a, b) => a - b).join(', ')}` : '',
        targets.includeAllFull ? 'Full-blueprint revision requested.' : ''
    ].filter(Boolean).join('\n') || 'No explicit scene/sequence numbers detected; use full feedback to infer the minimum affected sequences.';

    const context = currentBlueprint.map(seq => {
        const sequenceNumber = Number(seq.sequence_number);
        const includeFullSequence = targets.includeAllFull || targets.sequenceNumbers.has(sequenceNumber) || !targets.hasExplicitTargets;
        return {
            sequence_number: seq.sequence_number,
            sequence_title: seq.sequence_title,
            total_estimated_pages: seq.total_estimated_pages,
            context_mode: includeFullSequence ? 'full-target-context' : 'compact-context',
            scenes: seq.scenes?.map(({ draft_text, humanized_draft_text, locked, ...scene }) => {
                const includeFullScene = includeFullSequence || targets.sceneNumbers.has(Number(scene.scene_number));
                return {
                    ...scene,
                    narrative_action: includeFullScene
                        ? scene.narrative_action || ''
                        : compactText(scene.narrative_action || '', 280),
                    dramaturgical_function: includeFullScene
                        ? scene.dramaturgical_function || ''
                        : compactText(scene.dramaturgical_function || '', 160)
                };
            })
        };
    });

    return {
        targetSummary,
        context
    };
}

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeSequenceKey(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : String(value ?? '');
}

function hasBlueprintChanged(previousBlueprint, nextBlueprint) {
    return JSON.stringify(nextBlueprint || []) !== JSON.stringify(previousBlueprint || []);
}

function mergeModifiedSequences(currentBlueprint = [], modifiedSequences = []) {
    const originalBlueprint = Array.isArray(currentBlueprint) ? currentBlueprint : [];
    const modified = Array.isArray(modifiedSequences) ? modifiedSequences : [];

    if (!modified.length) return cloneValue(originalBlueprint) || [];

    const modifiedMap = new Map(
        modified.map(seq => [normalizeSequenceKey(seq.sequence_number), cloneValue(seq)])
    );
    const originalKeys = new Set(originalBlueprint.map(seq => normalizeSequenceKey(seq.sequence_number)));

    let updatedData = originalBlueprint.map(seq => {
        const replacement = modifiedMap.get(normalizeSequenceKey(seq.sequence_number));
        return replacement || cloneValue(seq);
    });

    for (const seq of modified) {
        const key = normalizeSequenceKey(seq.sequence_number);
        const alreadyPresent = updatedData.some(existing => normalizeSequenceKey(existing.sequence_number) === key);
        if (!originalKeys.has(key) && !alreadyPresent) {
            updatedData.push(cloneValue(seq));
        }
    }

    // Build a lookup of existing draft data from the original blueprint, keyed by
    // scene_heading (sluglines are stable identifiers). This survives structured
    // output stripping fields not in the schema (draft_text, locked).
    const existingDraftData = new Map();
    originalBlueprint.forEach(seq => {
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

    // POST-PROCESSING: renumber scenes sequentially and restore lost fields.
    let count = 1;
    updatedData.forEach((sequence, idx) => {
        sequence.sequence_number = idx + 1;

        if (sequence.scenes && Array.isArray(sequence.scenes)) {
            sequence.scenes.forEach(scene => {
                scene.scene_number = count++;

                const existing = existingDraftData.get(scene.scene_heading);
                if (existing) {
                    if (existing.draft_text) scene.draft_text = existing.draft_text;
                    if (existing.humanized_draft_text) scene.humanized_draft_text = existing.humanized_draft_text;
                    if (existing.locked) scene.locked = existing.locked;
                }
            });
        }
    });

    return updatedData;
}

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
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = '',
        generateContentFn = generateContent
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
        systemInstruction: buildMemorySourceSystemInstruction(`You are an elite Script Coordinator modifying a Scene Blueprint based on the director's feedback.

CRITICAL RULES:
- Return ONLY the sequences that contain changes. Do NOT return unmodified sequences.
- Within a returned sequence, include ALL its scenes (both modified and unmodified within that sequence).
- Generate full, detailed narrative_action (100-200 words) and dramaturgical_function for modified or new scenes.
- For unmodified scenes within a modified sequence, copy them verbatim from the input.
- If a scene is split into multiple scenes, generate complete data for each new scene.
- If scenes are merged, generate a single combined scene with updated data.
- Preserve the original sequence_number so the system can merge your changes back into the full blueprint.`, 'Stage 6 Scene Blueprint Revision'),
        temperature: 0.5,
    };

    const revisionBlueprint = buildRevisionBlueprintContext(currentBlueprint, feedback);

    const sourceBlock = buildMemorySourcePromptBlock(knowledgeContext, 'Stage 6 Scene Blueprint Revision');
    const prompt = `${sourceBlock}REVISION TARGETS:
${revisionBlueprint.targetSummary}

CURRENT SCENE BLUEPRINT (JSON — targeted sequences/scenes include full text; compact-context sequences are for orientation only):
${JSON.stringify(revisionBlueprint.context)}

DIRECTOR'S FEEDBACK:
${feedback}

OBJECTIVE: Apply the feedback. Return ONLY the sequences containing changes (with ALL their scenes). Do NOT return unmodified sequences.

FIDELITY RULES:
- If feedback names a specific scene, tag, phrase, prop, function line, or scene merge/relocation, make that concrete change in the returned sequence.
- Preserve every unmentioned scene verbatim within any returned sequence unless renumbering/merging requires a local adjustment.
- If the feedback says a source/treatment/character-bible item is locked, treat it as binding even if the current blueprint says otherwise.`;

    const usageList = [];
    const runRevisionPrompt = async (promptText, label = 'Stage 6 Revision') => {
        let response;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                response = await generateContentFn({
                    model, geminiApiKey, anthropicApiKey,
                    contents: [{ role: 'user', parts: [{ text: promptText }] }],
                    config,
                    schema: rootSchema
                });
                if (response?.usage) usageList.push(response.usage);
                return response;
            } catch (err) {
                console.warn(`${label} attempt ${attempt}/3: ${err.message}`);
                if (attempt === 3) throw err;
                await new Promise(r => setTimeout(r, 3000 * attempt));
            }
        }
        return response;
    };

    const parseAndMerge = (response) => {
        const modifiedSequences = JSON.parse(response.text);
        if (!Array.isArray(modifiedSequences)) {
            throw new Error('Stage 6 revision response was not an array of modified sequences');
        }
        return {
            modifiedSequences,
            updatedData: mergeModifiedSequences(currentBlueprint, modifiedSequences)
        };
    };

    try {
        let result = await runRevisionPrompt(prompt);
        let { modifiedSequences, updatedData } = parseAndMerge(result);

        if (!modifiedSequences.length || !hasBlueprintChanged(currentBlueprint, updatedData)) {
            const enforcementPrompt = `${prompt}

MANDATORY SECOND PASS:
Your previous revision response produced no saved blueprint changes. That is not acceptable for an apply/revise request.

FIRST ATTEMPT RETURNED:
${compactText(result.text, 1600)}

Apply the smallest concrete edits required by the director's feedback now.
- Do not return [] unless the feedback explicitly asks for no change.
- If the latest user message is a short confirmation, implement the most recent concrete proposal in RECENT ASSISTANT CONTEXT or RECENT CONVERSATION CONTEXT.
- If scene numbers have shifted, use sequence titles, headings, quoted phrases, and narrative context to find the closest affected sequence.
- Return at least one changed sequence with all of its scenes unless it is truly impossible.`;

            result = await runRevisionPrompt(enforcementPrompt, 'Stage 6 Revision enforcement');
            ({ modifiedSequences, updatedData } = parseAndMerge(result));
        }

        if (!modifiedSequences.length || !hasBlueprintChanged(currentBlueprint, updatedData)) {
            const finalRepairPrompt = `${prompt}

FINAL REPAIR PASS:
Two revision attempts produced no saved blueprint changes. You must now return a concrete diff, not an unchanged copy.

SECOND ATTEMPT RETURNED:
${compactText(result.text, 1600)}

Return exactly the smallest sequence set needed to satisfy the director's feedback.
- At least one returned scene must differ from the current blueprint in narrative_action, dramaturgical_function, scene_heading, estimated_page_count, or scene count.
- If the feedback asks to restore a missing source beat, add or revise the closest scene so the beat is visibly present.
- If the feedback asks to tighten/clarify a scene, rewrite that scene's narrative_action or dramaturgical_function so the change is concrete and inspectable.
- Do not return a sequence that is byte-for-byte identical to the input.
- Return modified sequence objects only, with all scenes included inside each modified sequence.`;

            result = await runRevisionPrompt(finalRepairPrompt, 'Stage 6 Revision final repair');
            ({ modifiedSequences, updatedData } = parseAndMerge(result));
        }

        if (!modifiedSequences.length || !hasBlueprintChanged(currentBlueprint, updatedData)) {
            const noChangeError = new Error('Stage 6 revision produced no blueprint changes after three attempts. Try naming the specific scene/sequence or the exact source beat to restore.');
            noChangeError.code = 'NO_BLUEPRINT_CHANGES';
            throw noChangeError;
        }

        return {
            result: updatedData,
            usage: usageList.length > 1 ? usageList : usageList[0]
        };
    } catch (error) {
        if (error.code !== 'NO_BLUEPRINT_CHANGES') {
            console.error('Error in Stage 6 Revision Agent:', error);
        }
        throw error;
    }
};

module.exports = { reviseStage6Scenes };
