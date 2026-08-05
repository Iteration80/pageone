const { generateContent } = require('./ai-client');
const { GoogleGenAI } = require('@google/genai');
const {
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('./memory_contract');
const { parseJsonWithRepair } = require('./json_parse');
const { loadSkill } = require('../utils/skills_cache');
const { formatCharacterBackstory } = require('../utils/character_backstory');

// Note: consolidateCoverage is initialized lazily so it picks up the API key
// that may have been set via settings after module load.

const coverageSchema = {
    type: "object",
    properties: {
        title:  { type: "string" },
        genre:  { type: "string" },
        logline: { type: "string" },
        // "Not assessable" exists because every field here is `required` against a
        // closed enum, and a required judgement is a judgement the model MUST invent
        // when the evidence is absent. Measured 2026-08-05: on a draft of 2 scenes out
        // of 70 — containing no dialogue at all — coverage returned dialogue "Good",
        // structure "Good" and a CONSIDER grade, then Stage 10 built a rewrite plan on
        // top of it. The model was not free-associating; the schema left it no legal
        // way to abstain. A rating scale with no "insufficient evidence" value does not
        // measure quality, it manufactures it.
        evaluation_grid: {
            type: "object",
            properties: {
                concept:          { type: "string", enum: ["Excellent", "Good", "Fair", "Poor", "Not assessable"] },
                structure:        { type: "string", enum: ["Excellent", "Good", "Fair", "Poor", "Not assessable"] },
                characterization: { type: "string", enum: ["Excellent", "Good", "Fair", "Poor", "Not assessable"] },
                pacing:           { type: "string", enum: ["Excellent", "Good", "Fair", "Poor", "Not assessable"] },
                dialogue:         { type: "string", enum: ["Excellent", "Good", "Fair", "Poor", "Not assessable"] },
            },
            required: ["concept", "structure", "characterization", "pacing", "dialogue"]
        },
        synopsis: {
            type: "object",
            properties: {
                setup:       { type: "string" },
                escalation:  { type: "string" },
                resolution:  { type: "string" },
            },
            required: ["setup", "escalation", "resolution"]
        },
        authenticity: {
            type: "object",
            properties: {
                assessment: { type: "string" },
                red_flags:  { type: "array", items: { type: "string" } }
            },
            required: ["assessment", "red_flags"]
        },
        source_alignment: {
            type: "object",
            properties: {
                assessment: { type: "string" },
                protected_elements: { type: "array", items: { type: "string" } },
                drift_risks: { type: "array", items: { type: "string" } }
            }
        },
        strengths: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    headline: { type: "string" },
                    detail:   { type: "string" }
                },
                required: ["headline", "detail"]
            }
        },
        weaknesses: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    headline: { type: "string" },
                    detail:   { type: "string" }
                },
                required: ["headline", "detail"]
            }
        },
        macro_todo: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    priority: { type: "integer" },
                    task:     { type: "string" },
                },
                required: ["priority", "task"]
            }
        },
        micro_todo: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    priority: { type: "integer" },
                    task:     { type: "string" },
                },
                required: ["priority", "task"]
            }
        },
        recommendation: {
            type: "object",
            properties: {
                grade:         { type: "string", enum: ["PASS", "CONSIDER", "RECOMMEND", "NOT ASSESSABLE"] },
                justification: { type: "string" }
            },
            required: ["grade", "justification"]
        }
    },
    required: ["title", "genre", "logline", "evaluation_grid", "synopsis", "authenticity", "strengths", "weaknesses", "macro_todo", "micro_todo", "recommendation"]
};

/**
 * Runs a single coverage analysis pass using the configured model.
 */
const runSingleCoverage = async (prompt, sop, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        generateContentFn = generateContent
    } = modelConfig;

    const response = await generateContentFn({
        model, geminiApiKey, anthropicApiKey,
        contents: prompt,
        config: {
            systemInstruction: buildMemorySourceSystemInstruction(sop, 'Stage 9 Coverage'),
            temperature: 0.4,
            thinkingConfig: { thinkingLevel: 'HIGH' },
        },
        schema: coverageSchema
    });
    return {
        parsed: parseJsonWithRepair(response.text, { schema: coverageSchema, label: 'Stage 9 coverage response' }),
        usage: response.usage
    };
};

/**
 * Consolidates 2–3 coverage results into a single consensus report.
 * Always uses the fast Gemini flash model — intentional cost optimization.
 */
const consolidateCoverage = async (results, geminiApiKey, sourceContext = '', scopeNote = '') => {
    const consolidatorSop = loadSkill('skill_coverage_consolidator');
    const sourceBlock = buildMemorySourcePromptBlock(sourceContext, 'Stage 9 Coverage Consolidation');
    // Abstention has to survive the merge. Consensus logic naturally prefers a
    // confident rating over "Not assessable", which would quietly reinstate the
    // fabricated grade the three passes were right to withhold.
    const prompt = `${sourceBlock ? `${sourceBlock}\n\n---\n\n` : ''}${scopeNote ? `${scopeNote}\n\n---\n\n` : ''}Here are ${results.length} independent coverage reports for the same screenplay. Synthesize them into a single consensus report following your instructions. Preserve source-alignment findings when multiple reports flag them or when a finding concerns an approved project lock.\n\nIf any report rates a category "Not assessable" or grades "NOT ASSESSABLE", treat that as a claim about the EVIDENCE, not an opinion to be outvoted: keep the abstention unless another report demonstrates the material actually exists in the draft. Never merge two abstentions into a rating.\n\n${results.map((r, i) => `## REPORT ${i + 1}\n${JSON.stringify(r, null, 2)}`).join('\n\n')}`;

    const consolidateAi = new GoogleGenAI({ apiKey: geminiApiKey || process.env.GEMINI_API_KEY });
    const response = await consolidateAi.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
            systemInstruction: buildMemorySourceSystemInstruction(consolidatorSop, 'Stage 9 Coverage Consolidation'),
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: coverageSchema,
        }
    });
    const usage = {
        model: 'gemini-3-flash-preview',
        inputTokens: response.usageMetadata?.promptTokenCount || 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
    };
    return {
        parsed: parseJsonWithRepair(response.text, { schema: coverageSchema, label: 'Stage 9 coverage consolidation response' }),
        usage
    };
};

/**
 * Stage 9: Coverage Agent
 * Runs 3 parallel coverage analyses then consolidates into a consensus report.
 *
 * @param {string} fullScriptText - All scene drafts concatenated in order
 * @param {object} projectContext - { title, genre, logline, synopsis, characters }
 * @param {object} modelConfig    - { model, geminiApiKey, anthropicApiKey }
 * @returns {Promise<object>} - Structured coverage report
 */
const agent8Coverage = async (fullScriptText, projectContext, modelConfig = {}) => {
    const sop = loadSkill('skill_stage9_coverage');
    const sourceSection = buildMemorySourcePromptBlock(modelConfig.knowledgeContext, 'Stage 9 Coverage');
    const auditFlagSection = modelConfig.stage6AuditBlock
        ? `\n\n${modelConfig.stage6AuditBlock}`
        : '';

    // Build character profiles section if available
    const chars = projectContext.characters || [];
    const charSection = chars.length > 0
        ? `\n\nCharacter Profiles:\n${chars.map(c => {
            const dp = c._deep_profile || {};
            const tier = c.profile_tier || 'Tier 1';
            const tierText = String(tier).toLowerCase();
            const backstory = formatCharacterBackstory(c.backstory, tier);
            const backstoryLine = backstory ? `\n  Backstory relevance: ${backstory}` : '';
            if (/\b3\b|cameo|utility/.test(tierText)) {
                const cameo = c.cameo_profile || {};
                return `- ${c.name} (${c.role}, ${tier}): ${c.brief_summary || ''}
  Scene purpose: ${cameo.scene_purpose || 'unknown'} | Playable behavior: ${cameo.playable_behavior || 'unknown'}${backstoryLine}`;
            }
            if (/\b2\b|functional/.test(tierText)) {
                const functional = c.functional_profile || {};
                return `- ${c.name} (${c.role}, ${tier}): ${c.brief_summary || ''}
  Narrative function: ${functional.narrative_function || 'unknown'} | Emotional truth: ${functional.emotional_truth || 'unknown'} | Comic/tension: ${functional.comic_or_tension_function || 'unknown'} | Pressure behavior: ${functional.pressure_behavior || 'unknown'} | Voice flavor: ${functional.voice_flavor || 'unknown'}${backstoryLine}`;
            }
            return `- ${c.name} (${c.role}, ${tier}): ${c.brief_summary || ''}
  Voice: ${c.voice_and_behavior?.voice_tag || 'unknown'} | Pressure: ${c.voice_and_behavior?.pressure_tag || 'unknown'} | Humor: ${c.voice_and_behavior?.humor_tag || 'unknown'}
  Arc: ${c.arc?.core_drive || 'unknown'} -> ${c.arc?.direction || 'unknown'}${backstoryLine}${dp.dialogue_fingerprint ? `\n  Dialogue rules: ${dp.dialogue_fingerprint}` : ''}`;
        }).join('\n')}`
        : '';

    // How much of the script actually exists. Without this the prompt handed over a
    // synopsis, every character profile and a header reading "FULL SCREENPLAY" — enough
    // to reconstruct the whole movie — while the body held whatever happened to be
    // drafted. The model has no other way to tell a planned scene from a written one.
    const { draftedScenes = null, totalScenes = null } = modelConfig.draftScope || {};
    const isPartial = Number.isFinite(draftedScenes) && Number.isFinite(totalScenes) && draftedScenes < totalScenes;
    const scriptHeading = isPartial
        ? `## SCREENPLAY PAGES DRAFTED SO FAR (${draftedScenes} of ${totalScenes} planned scenes)`
        : '## FULL SCREENPLAY';
    const scopeSection = isPartial
        ? `
---

## ⚠️ DRAFT SCOPE — READ BEFORE ANALYSING
This screenplay is **INCOMPLETE**. Only **${draftedScenes} of ${totalScenes}** planned scenes have been written. The text below is the entire draft that exists — everything else is unwritten.

The synopsis, character profiles and project memory above describe the story as PLANNED. They are background so you understand where the drafted pages sit. **They are not evidence of what is on the page, and you must not review them as if they were.**

Binding rules for this report:
* Judge **only the drafted pages below**. Never describe, praise, or criticise the craft of a scene that is not in that text — no matter how confidently the synopsis implies it exists.
* Where the drafted pages give you too little to judge a category honestly, rate it **"Not assessable"**. That is the correct answer, not a hedge. Rating structure or pacing off a fraction of a script is a guess wearing a grade.
* Set \`recommendation.grade\` to **"NOT ASSESSABLE"** and say plainly in the justification how much of the script exists. A verdict on an unfinished script is not a verdict.
* Every \`macro_todo\` and \`micro_todo\` item must be actionable **on a scene that is already drafted**. Do not issue notes on unwritten scenes.
* Say what you cannot yet see. Naming the gap is more useful to the writer than filling it.
`
        : '';

    const prompt = `
## PROJECT CONTEXT
Title: ${projectContext.title || 'Untitled'}
Genre: ${projectContext.genre || 'Unknown'}
Logline: ${projectContext.logline || 'Not provided'}

Synopsis:
${projectContext.synopsis || 'Not provided'}${charSection}${auditFlagSection}

${sourceSection ? `---\n\n${sourceSection}\n` : ''}${scopeSection}

---

${scriptHeading}

${fullScriptText}
    `;

    console.log('Coverage: running 3 parallel analyses...');
    const settledResults = await Promise.allSettled([
        runSingleCoverage(prompt, sop, modelConfig),
        runSingleCoverage(prompt, sop, modelConfig),
        runSingleCoverage(prompt, sop, modelConfig),
    ]);

    const successes = settledResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

    settledResults
        .filter(r => r.status === 'rejected')
        .forEach((r, i) => console.warn(`Coverage run ${i + 1} failed:`, r.reason?.message));

    if (successes.length === 0) {
        throw new Error('All 3 coverage analyses failed.');
    }

    const usageList = successes.map(s => s.usage);

    if (successes.length === 1) {
        console.log('Coverage: only 1 run succeeded — returning single result.');
        return { result: successes[0].parsed, usageList };
    }

    console.log(`Coverage: ${successes.length} runs succeeded — consolidating...`);
    const consolidated = await consolidateCoverage(
        successes.map(s => s.parsed),
        modelConfig.geminiApiKey || process.env.GEMINI_API_KEY,
        modelConfig.knowledgeContext || '',
        isPartial
            ? `SCOPE: this screenplay is INCOMPLETE — ${draftedScenes} of ${totalScenes} planned scenes are drafted. Abstentions in the reports below are expected and correct.`
            : ''
    );
    usageList.push(consolidated.usage);
    return { result: consolidated.parsed, usageList };
};

module.exports = { agent8Coverage };
