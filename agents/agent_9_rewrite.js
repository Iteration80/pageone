const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Stage 9: Scene Rewrite Agent
 * Applies a single coverage task to one scene. Returns the scene unchanged
 * if the task does not apply to it.
 *
 * @param {string} sceneText         - Current Fountain text for this scene
 * @param {string} priorityTask      - The specific rewrite instruction to apply
 * @param {object} sceneContext      - { title, sceneNumber, slugline }
 * @param {string} [userFeedback]    - Optional additional user instructions
 * @returns {Promise<string>}        - Rewritten (or unchanged) Fountain scene text
 */
const rewriteScene = async (sceneText, priorityTask, sceneContext, userFeedback = '') => {
    const sop = fs.readFileSync(path.join(__dirname, '../skills/skill_stage9_rewrite.md'), 'utf8');

    const feedbackSection = userFeedback
        ? `\n## ADDITIONAL WRITER NOTES\n${userFeedback}\n`
        : '';

    const prompt = `
## PROJECT
Title: ${sceneContext.title || 'Untitled'}

## REWRITE TASK
${priorityTask}
${feedbackSection}
## SCENE ${sceneContext.sceneNumber}${sceneContext.slugline ? ` — ${sceneContext.slugline}` : ''}

${sceneText}
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: prompt,
            config: {
                systemInstruction: sop,
                temperature: 0.5,
                thinkingConfig: { thinkingLevel: 'LOW' },
            }
        });
        return response.text.trim();
    } catch (error) {
        console.error(`Rewrite agent error for scene ${sceneContext.sceneNumber}:`, error.message);
        // Graceful fallback: return original scene unchanged
        return sceneText;
    }
};

module.exports = { rewriteScene };
