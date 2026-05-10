const { generateContent } = require('./ai-client');
const {
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('./memory_contract');
const fs = require('fs');
const path = require('path');

/**
 * Stage 10: Scene Rewrite Agent
 * Applies a single coverage task to one scene. Returns the scene unchanged
 * if the task does not apply to it.
 *
 * For Tier 3 (trained) styles, also performs a style-compliance check using
 * the full style reference after applying the coverage fix.
 *
 * @param {string} sceneText         - Current Fountain text for this scene
 * @param {string} priorityTask      - The specific rewrite instruction to apply
 * @param {object} sceneContext      - { title, sceneNumber, slugline, characters }
 * @param {string} [userFeedback]    - Optional additional user instructions
 * @param {object} [modelConfig]     - { model, geminiApiKey, anthropicApiKey }
 * @param {string} [styleContent]    - Style directive (400-600 words, Tier 2 or 3)
 * @param {string} [styleReference]  - Full style reference (2000+ words, Tier 3 only)
 * @returns {Promise<{result: string, usage: object}>}
 */
const rewriteScene = async (sceneText, priorityTask, sceneContext, userFeedback = '', modelConfig = {}, styleContent = null, styleReference = null) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = '',
        generateContentFn = generateContent
    } = modelConfig;

    const sop = fs.readFileSync(path.join(__dirname, '../skills/skill_stage10_rewrite.md'), 'utf8');

    const plannedChangeSection = userFeedback
        ? `\n## PLANNED CHANGE FOR THIS SCENE\n${userFeedback}\n`
        : '';

    // Tier 3: Full reference for compliance checking (injected before directive)
    const referenceSection = styleReference
        ? `\n## STYLE REFERENCE (for compliance checking)\nThe following is the full style analysis for this project's writing voice.\nAfter applying the rewrite, verify the result matches these patterns.\nFix any style drift without undoing the coverage fix.\n\n${styleReference}\n`
        : '';

    const styleSection = styleContent
        ? `\n## STYLE DIRECTIVES\nThe following directives describe the writing style for this project.\nTreat them as primary craft instructions when making decisions about dialogue rhythm,\naction detail, tonal register, pacing, and voice.\n\n${styleContent}\n`
        : '';

    const charSection = sceneContext.characters
        ? `\n## CHARACTER PROFILES\n${sceneContext.characters}\n`
        : '';
    const sourceSection = buildMemorySourcePromptBlock(knowledgeContext, 'Stage 10 Rewrite');

    const prompt = `
## PROJECT
Title: ${sceneContext.title || 'Untitled'}
${plannedChangeSection}${referenceSection}${styleSection}${sourceSection}${charSection}
## PRIORITY CONTEXT
${priorityTask}

## SCENE ${sceneContext.sceneNumber}${sceneContext.slugline ? ` — ${sceneContext.slugline}` : ''}

${sceneText}
    `;

    // Retry up to 3 times on transient connection errors
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await generateContentFn({
                model, geminiApiKey, anthropicApiKey,
                contents: prompt,
                config: {
                    systemInstruction: buildMemorySourceSystemInstruction(sop, 'Stage 10 Rewrite'),
                    temperature: 0.5,
                    thinkingConfig: { thinkingLevel: 'LOW' },
                }
            });
            return { result: response.text.trim(), usage: response.usage };
        } catch (error) {
            console.warn(`Rewrite agent attempt ${attempt}/3 for scene ${sceneContext.sceneNumber}: ${error.message}`);
            if (attempt === 3) {
                console.error(`Rewrite agent error for scene ${sceneContext.sceneNumber}: ${error.message}`);
                return { result: sceneText, usage: null };
            }
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
};

module.exports = { rewriteScene };
