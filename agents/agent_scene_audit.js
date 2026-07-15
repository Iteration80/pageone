const { generateContent } = require('./ai-client');
const { parseJsonWithRepair } = require('./json_parse');
const { loadSkill } = require('../utils/skills_cache');
const {
    nominateAll,
    parseFunctionDeclarations
} = require('../utils/blueprint_audit');

const AUDIT_VERDICT_SCHEMA = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: ['confirm', 'acquit'] },
        evidence: { type: 'string' }
    },
    required: ['verdict', 'evidence']
};

const AUDIT_DEFENSE_SCHEMA = {
    type: 'object',
    properties: {
        scene_survives: { type: 'boolean' },
        justification: { type: 'string' }
    },
    required: ['scene_survives', 'justification']
};

function compactText(value, maxChars = 5000) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 120).trim()}\n\n[...truncated ${text.length - maxChars + 120} chars...]`;
}

function normalizeSequences(input) {
    if (Array.isArray(input)) return input;
    if (Array.isArray(input?.sequences)) return input.sequences;
    if (Array.isArray(input?.scenes)) return [{ sequence_title: 'Blueprint', scenes: input.scenes }];
    return [];
}

function allScenes(sequences = []) {
    const scenes = [];
    for (const sequence of normalizeSequences(sequences)) {
        for (const scene of sequence?.scenes || []) scenes.push(scene);
    }
    return scenes;
}

function findScene(sequences = [], sceneNumber) {
    const target = Number(sceneNumber);
    return allScenes(sequences).find(scene => Number(scene.scene_number) === target) || null;
}

function findSequenceForScene(sequences = [], sceneNumber) {
    const target = Number(sceneNumber);
    return normalizeSequences(sequences).find(sequence => (
        Array.isArray(sequence?.scenes)
        && sequence.scenes.some(scene => Number(scene.scene_number) === target)
    )) || null;
}

function numbersFromDeclarations(declarations = {}) {
    const text = [declarations.setsUp, declarations.paysOff].filter(Boolean).join('\n');
    return Array.from(text.matchAll(/\bscene\s*(\d+)\b/gi)).map(match => Number(match[1])).filter(Number.isFinite);
}

function referencedScenesForDefense(sequences, candidate) {
    const numbers = new Set(numbersFromDeclarations(candidate.parsedDeclarations || {}));
    if (candidate.counterpart_scene) numbers.add(Number(candidate.counterpart_scene));
    return Array.from(numbers)
        .map(sceneNumber => findScene(sequences, sceneNumber))
        .filter(Boolean)
        .map(scene => ({
            scene_number: scene.scene_number,
            scene_heading: scene.scene_heading || scene.slugline || '',
            narrative_action: scene.narrative_action || '',
            dramaturgical_function: scene.dramaturgical_function || '',
            declarations: parseFunctionDeclarations(scene)
        }));
}

function candidateForPrompt(candidate = {}) {
    return {
        type: candidate.type,
        scene_number: candidate.scene_number,
        counterpart_scene: candidate.counterpart_scene || null,
        evidence: candidate.evidence || '',
        similarity: candidate.similarity || null,
        sharedTerms: candidate.sharedTerms || [],
        jobCount: candidate.jobCount || null,
        parsedDeclarations: candidate.parsedDeclarations || parseFunctionDeclarations(candidate.scene || {}),
        counterpartDeclarations: candidate.counterpartDeclarations || (candidate.counterpart ? parseFunctionDeclarations(candidate.counterpart) : null),
        scene: candidate.scene || null,
        counterpart: candidate.counterpart || null
    };
}

function prosecutorPrompt(candidate) {
    return `PROSECUTOR PASS.

Adjudicate only the nominated charge. Confirm with specific evidence, or acquit.

CANDIDATE:
${compactText(candidateForPrompt(candidate), 9000)}

Return JSON only.`;
}

function defensePrompt(sequences, candidate, prosecutorEvidence) {
    const sequence = findSequenceForScene(sequences, candidate.scene_number);
    return `DEFENSE PASS.

The prosecutor confirmed this candidate. Apply the removal test and defend the scene if any meaningful dramatic work breaks when it is cut.

PROSECUTOR EVIDENCE:
${compactText(prosecutorEvidence, 1600)}

CANDIDATE:
${compactText(candidateForPrompt(candidate), 7000)}

SURROUNDING SEQUENCE:
${compactText(sequence || {}, 9000)}

SETUP / PAYOFF / COUNTERPART SCENES:
${compactText(referencedScenesForDefense(sequences, candidate), 5000)}

Return JSON only.`;
}

function severityForCandidate(candidate) {
    if (candidate.type === 'no_shift') return 'medium';
    if (candidate.type === 'overloaded') return candidate.jobCount >= 4 ? 'high' : 'medium';
    if (candidate.type === 'redundant') return candidate.similarity >= 0.72 ? 'high' : 'medium';
    return 'low';
}

function flagFromCandidate(candidate, prosecutor, defense) {
    return {
        scene_number: Number(candidate.scene_number),
        type: candidate.type,
        ...(candidate.counterpart_scene ? { counterpart_scene: Number(candidate.counterpart_scene) } : {}),
        evidence: compactText(prosecutor.evidence || candidate.evidence || '', 800),
        failed_defense: compactText(defense.justification || '', 800),
        severity: severityForCandidate(candidate),
        dismissed: false
    };
}

async function callAuditModel(generateContentFn, request, schema, label) {
    const response = await generateContentFn(request);
    return {
        parsed: parseJsonWithRepair(response.text, { schema, label }),
        usage: response.usage
    };
}

async function adjudicateCandidate(candidate, sequences, modelContext, { temperatureOffset = 0 } = {}) {
    const { model, geminiApiKey, anthropicApiKey, generateContentFn, sop } = modelContext;
    const prosecutor = await callAuditModel(generateContentFn, {
        model,
        geminiApiKey,
        anthropicApiKey,
        contents: [prosecutorPrompt(candidate)],
        config: {
            systemInstruction: sop,
            temperature: 0.15 + temperatureOffset,
            thinkingConfig: { thinkingLevel: 'HIGH' },
            maxOutputTokens: 16000
        },
        schema: AUDIT_VERDICT_SCHEMA
    }, AUDIT_VERDICT_SCHEMA, 'Stage 6 audit prosecutor response');

    if (prosecutor.parsed.verdict !== 'confirm') {
        return { flag: null, usage: [prosecutor.usage].filter(Boolean), status: 'acquitted_by_prosecutor' };
    }

    const defense = await callAuditModel(generateContentFn, {
        model,
        geminiApiKey,
        anthropicApiKey,
        contents: [defensePrompt(sequences, candidate, prosecutor.parsed.evidence)],
        config: {
            systemInstruction: sop,
            temperature: 0.05 + temperatureOffset,
            thinkingConfig: { thinkingLevel: 'HIGH' },
            maxOutputTokens: 16000
        },
        schema: AUDIT_DEFENSE_SCHEMA
    }, AUDIT_DEFENSE_SCHEMA, 'Stage 6 audit defense response');

    if (defense.parsed.scene_survives) {
        return { flag: null, usage: [prosecutor.usage, defense.usage].filter(Boolean), status: 'rescued_by_defense' };
    }

    return {
        flag: flagFromCandidate(candidate, prosecutor.parsed, defense.parsed),
        usage: [prosecutor.usage, defense.usage].filter(Boolean),
        status: 'flagged'
    };
}

async function adjudicateCandidates(sequences, candidates, modelConfig = {}) {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        generateContentFn = generateContent,
        maxCandidates = 20
    } = modelConfig;

    const selected = (Array.isArray(candidates) ? candidates : []).slice(0, maxCandidates);
    const dropped = Math.max(0, (Array.isArray(candidates) ? candidates.length : 0) - selected.length);
    if (dropped > 0) {
        console.warn(`Stage 6 audit dropped ${dropped} candidate(s) above the ${maxCandidates} cap.`);
    }

    const modelContext = {
        model,
        geminiApiKey,
        anthropicApiKey,
        generateContentFn,
        sop: loadSkill('skill_scene_audit')
    };
    const flags = [];
    const usageList = [];
    const skipped = [];

    for (const candidate of selected) {
        try {
            const result = await adjudicateCandidate(candidate, sequences, modelContext);
            usageList.push(...result.usage);
            if (result.flag) flags.push(result.flag);
        } catch (firstError) {
            try {
                const retry = await adjudicateCandidate(candidate, sequences, modelContext, { temperatureOffset: 0.2 });
                usageList.push(...retry.usage);
                if (retry.flag) flags.push(retry.flag);
            } catch (retryError) {
                console.warn(`Stage 6 audit skipped candidate ${candidate.type}/${candidate.scene_number}: ${retryError.message}`);
                skipped.push({
                    scene_number: candidate.scene_number,
                    type: candidate.type,
                    error: retryError.message
                });
            }
        }
    }

    return { flags, usageList, dropped, skipped, candidateCount: selected.length };
}

async function runStage6SceneAudit(sequences, modelConfig = {}) {
    const candidates = nominateAll(sequences);
    return adjudicateCandidates(sequences, candidates, modelConfig);
}

module.exports = {
    AUDIT_VERDICT_SCHEMA,
    AUDIT_DEFENSE_SCHEMA,
    adjudicateCandidate,
    adjudicateCandidates,
    runStage6SceneAudit,
    prosecutorPrompt,
    defensePrompt
};
