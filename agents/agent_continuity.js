const { generateContent } = require('./ai-client');
const { parseJsonWithRepair } = require('./json_parse');
const { loadSkill } = require('../utils/skills_cache');

/**
 * Run the continuity supervisor on a newly drafted scene.
 * Non-fatal: errors are caught and return a clean result so the pipeline never breaks.
 */
async function runContinuityCheck(draftText, sceneData, projectData, modelConfig = {}) {
    const {
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    const model = 'gemini-3-flash-preview';
    const supervisorSOP = loadSkill('skill_continuity_supervisor');
    const activeFacts = getActiveFacts(projectData, sceneData.scene_number);
    const characters = projectData.data?.stage3_characters?.characters || [];
    const characterCues = extractCharacterCues(draftText);

    const prompt = `
${supervisorSOP}

## ACTIVE CONTINUITY FACTS (from previously drafted scenes)
${activeFacts.length > 0
        ? JSON.stringify(activeFacts, null, 2)
        : 'No facts established yet. Extract facts only, skip validation.'}

## CHARACTER PROFILES (for reference)
${JSON.stringify(characters.map(c => ({
        name: c.name,
        appearance: c.physical_profile || c.appearance,
        wardrobe: c.wardrobe,
        signature_details: c.signature_details
    })), null, 2)}

## SCENE METADATA
Scene Number: ${sceneData.scene_number}
Scene Heading: ${sceneData.scene_heading}
Characters Speaking: ${characterCues.join(', ') || 'Unknown'}

## NEW SCENE DRAFT (Fountain format)
${draftText}

---

Perform both jobs:
1. VALIDATE: Check the draft against active facts. Flag hard errors and soft warnings.
2. EXTRACT: Log every new continuity-relevant fact established in this scene.

Return ONLY a JSON object matching the output schema. No markdown, no explanation.
`;

    try {
        const response = await generateContent({
            model, geminiApiKey, anthropicApiKey,
            contents: prompt,
            config: { temperature: 0.1 }
        });

        let checkResult;
        try {
            checkResult = parseJsonWithRepair(response.text, { label: 'Continuity supervisor response' });
        } catch {
            console.error('Continuity supervisor returned non-JSON:', response.text.slice(0, 200));
            checkResult = emptyResult(sceneData.scene_number);
        }

        return { result: checkResult, usage: response.usage };
    } catch (error) {
        console.error('Continuity supervisor error:', error.message);
        return {
            result: { ...emptyResult(sceneData.scene_number), _error: error.message },
            usage: null
        };
    }
}

function emptyResult(sceneNumber) {
    return {
        scene_number: sceneNumber,
        status: 'clean',
        extracted_facts: [],
        updated_facts: [],
        errors: [],
        warnings: []
    };
}

/**
 * Get all active (non-superseded) facts for a given scene number.
 */
function getActiveFacts(projectData, sceneNumber) {
    const facts = projectData.data?.continuity_facts?.facts || [];
    return facts.filter(f =>
        f.superseded_by === null &&
        (f.active_until_scene === null || f.active_until_scene >= sceneNumber)
    );
}

/**
 * Apply the supervisor's output to the project data (mutates in place).
 * Caller must save the project file after this.
 */
function applyCheckResult(projectData, checkResult, usage) {
    if (!projectData.data.continuity_facts) {
        projectData.data.continuity_facts = { facts: [], checks: [] };
    }
    const cf = projectData.data.continuity_facts;

    const maxId = cf.facts.reduce((max, f) => {
        const num = parseInt(f.id.replace('cf_', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
    }, 0);
    let nextId = maxId + 1;

    for (const fact of (checkResult.extracted_facts || [])) {
        cf.facts.push({
            id: `cf_${String(nextId++).padStart(3, '0')}`,
            category: fact.category,
            subject: fact.subject,
            attribute: fact.attribute,
            value: fact.value,
            established_in_scene: fact.established_in_scene || checkResult.scene_number,
            superseded_by: null,
            active_until_scene: null,
            confidence: 'extracted'
        });
    }

    for (const update of (checkResult.updated_facts || [])) {
        if (!update.intentional) continue;
        const oldFact = cf.facts.find(f => f.id === update.existing_fact_id);
        if (!oldFact) continue;
        const newFactId = `cf_${String(nextId++).padStart(3, '0')}`;
        oldFact.superseded_by = newFactId;
        cf.facts.push({
            id: newFactId,
            category: oldFact.category,
            subject: oldFact.subject,
            attribute: oldFact.attribute,
            value: update.new_value,
            established_in_scene: checkResult.scene_number,
            superseded_by: null,
            active_until_scene: null,
            confidence: 'extracted'
        });
    }

    cf.checks.push({
        scene_number: checkResult.scene_number,
        run_at: Date.now(),
        facts_extracted: (checkResult.extracted_facts || []).length,
        facts_updated: (checkResult.updated_facts || []).length,
        errors_found: (checkResult.errors || []).length,
        warnings_found: (checkResult.warnings || []).length,
        status: checkResult.status || 'clean',
        model: usage?.model || 'unknown',
        ...(checkResult.errors?.length > 0 && { errors: checkResult.errors }),
        ...(checkResult.warnings?.length > 0 && { warnings: checkResult.warnings }),
    });

    return checkResult;
}

/**
 * Build a continuity context block for injection into the Stage 8 prompt.
 * Only injects facts relevant to the current scene's characters and location
 * to avoid overloading the writing agent with irrelevant constraints.
 */
function buildContinuityContext(projectData, sceneNumber, sceneData) {
    const activeFacts = getActiveFacts(projectData, sceneNumber);
    if (activeFacts.length === 0) return '';

    const sceneText = `${sceneData.scene_heading} ${sceneData.narrative_action}`.toLowerCase();
    const relevant = activeFacts.filter(f => sceneText.includes(f.subject.toLowerCase()));
    if (relevant.length === 0) return '';

    const grouped = {};
    for (const fact of relevant) {
        if (!grouped[fact.subject]) grouped[fact.subject] = [];
        grouped[fact.subject].push(fact);
    }

    let context = '\n## CONTINUITY — ESTABLISHED FACTS (from previously drafted scenes)\n';
    context += 'Your draft MUST be consistent with these facts unless the scene explicitly shows a change.\n\n';
    for (const [subject, facts] of Object.entries(grouped)) {
        context += `### ${subject}\n`;
        for (const fact of facts) {
            context += `- **${fact.attribute}** (est. Scene ${fact.established_in_scene}): ${fact.value}\n`;
        }
        context += '\n';
    }
    return context;
}

/**
 * Clear all facts established in a specific scene before re-drafting it.
 * Called before generate-draft and revise-draft to avoid stale facts.
 */
function clearSceneFacts(projectData, sceneNumber) {
    const cf = projectData.data?.continuity_facts;
    if (!cf) return;
    const clearedIds = new Set(
        cf.facts
            .filter(f => f.established_in_scene === sceneNumber)
            .map(f => f.id)
    );
    cf.facts = cf.facts.filter(f => f.established_in_scene !== sceneNumber);
    for (const fact of cf.facts) {
        if (fact.superseded_by && clearedIds.has(fact.superseded_by)) {
            fact.superseded_by = null;
        }
    }
}

/**
 * Extract character names from Fountain-formatted text.
 */
function extractCharacterCues(fountainText) {
    const lines = fountainText.split('\n');
    const cues = new Set();
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0 &&
            trimmed === trimmed.toUpperCase() &&
            !trimmed.startsWith('INT.') &&
            !trimmed.startsWith('EXT.') &&
            !trimmed.endsWith(':') &&
            !trimmed.startsWith('#') &&
            !/^\d/.test(trimmed) &&
            trimmed.length < 60) {
            const name = trimmed.replace(/\s*\(.*\)\s*$/, '').trim();
            if (name.length > 1 && name.length < 40) cues.add(name);
        }
    }
    return Array.from(cues);
}

/**
 * Resolve a continuity error by user action.
 */
function resolveError(projectData, factId, resolution, newValue) {
    const cf = projectData.data?.continuity_facts;
    if (!cf) return;
    const fact = cf.facts.find(f => f.id === factId);
    if (!fact) return;

    if (resolution === 'intentional_change' && newValue) {
        const maxId = cf.facts.reduce((max, f) => {
            const num = parseInt(f.id.replace('cf_', ''), 10);
            return isNaN(num) ? max : Math.max(max, num);
        }, 0);
        const newId = `cf_${String(maxId + 1).padStart(3, '0')}`;
        fact.superseded_by = newId;
        cf.facts.push({
            id: newId,
            category: fact.category,
            subject: fact.subject,
            attribute: fact.attribute,
            value: newValue,
            established_in_scene: fact.established_in_scene,
            superseded_by: null,
            active_until_scene: null,
            confidence: 'confirmed'
        });
    } else if (resolution === 'dismiss') {
        fact.confidence = 'dismissed';
    }
}

module.exports = {
    runContinuityCheck,
    applyCheckResult,
    buildContinuityContext,
    getActiveFacts,
    clearSceneFacts,
    resolveError,
    extractCharacterCues
};
