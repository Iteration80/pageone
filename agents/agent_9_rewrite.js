const { generateContent } = require('./ai-client');
const fs = require('fs');
const path = require('path');

/**
 * Stage 9: Scene Rewrite Agent
 * Applies a single coverage task to one scene. Returns the scene unchanged
 * if the task does not apply to it.
 *
 * @param {string} sceneText         - Current Fountain text for this scene
 * @param {string} priorityTask      - The specific rewrite instruction to apply
 * @param {object} sceneContext      - { title, sceneNumber, slugline }
 * @param {string} [userFeedback]    - Optional additional user instructions
 * @param {object} [modelConfig]     - { model, geminiApiKey, anthropicApiKey }
 * @returns {Promise<string>}        - Rewritten (or unchanged) Fountain scene text
 */
const rewriteScene = async (sceneText, priorityTask, sceneContext, userFeedback = '', modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    const sop = fs.readFileSync(path.join(__dirname, '../skills/skill_stage9_rewrite.md'), 'utf8');

    const plannedChangeSection = userFeedback
        ? `\n## PLANNED CHANGE FOR THIS SCENE\n${userFeedback}\n`
        : '';

    const charSection = sceneContext.characters
        ? `\n## CHARACTER PROFILES\n${sceneContext.characters}\n`
        : '';

    const prompt = `
## PROJECT
Title: ${sceneContext.title || 'Untitled'}
${plannedChangeSection}${charSection}
## PRIORITY CONTEXT
${priorityTask}

## SCENE ${sceneContext.sceneNumber}${sceneContext.slugline ? ` — ${sceneContext.slugline}` : ''}

${sceneText}
    `;

    // Retry up to 3 times on transient connection errors
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await generateContent({
                model, geminiApiKey, anthropicApiKey,
                contents: prompt,
                config: {
                    systemInstruction: sop,
                    temperature: 0.5,
                    thinkingConfig: { thinkingLevel: 'LOW' },
                }
            });
            return { result: response.text.trim(), usage: response.usage };
        } catch (error) {
            console.warn(`Rewrite agent attempt ${attempt}/3 for scene ${sceneContext.sceneNumber}: ${error.message}`);
            if (attempt === 3) {
                console.error(`Rewrite agent error for scene ${sceneContext.sceneNumber}: ${error.message}`);
                return sceneText;
            }
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
};

module.exports = { rewriteScene };
