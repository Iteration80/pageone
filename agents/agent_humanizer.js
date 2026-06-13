const { GoogleGenAI } = require('@google/genai');
const { loadSkill } = require('../utils/skills_cache');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Lightweight model for prose-level editing (faster and cheaper than Pro)
// Swap this model ID for whichever Gemini Flash model is available in your account.
const HUMANIZER_MODEL = 'gemini-3-flash-preview';

/**
 * Humanizer Agent
 * Performs a line-level craft polish pass on a Fountain-formatted scene.
 * Raises perplexity and burstiness to reduce AI detection signals.
 * Does NOT change story beats, character decisions, or plot events.
 *
 * @param {string} draftText - Raw Fountain text from Stage 8
 * @param {string} [styleContent] - Optional project style directive to preserve
 * @returns {Promise<string>} - Humanized Fountain text
 */
const humanizeDraft = async (draftText, styleContent = null) => {
    const humanizerRules = loadSkill('skill_humanizer');
    const styleSection = styleContent
        ? `\n## PROJECT STYLE DIRECTIVES TO PRESERVE\nThe scene has already been drafted in this style. During the surgical polish, do not flatten or remove intentional style choices that match these directives. Only fix clear AI-generation signals.\n\n${styleContent}\n`
        : '';

    const prompt = `
${humanizerRules}
${styleSection}

## SCENE TO POLISH
${draftText}
    `;

    try {
        const response = await ai.models.generateContent({
            model: HUMANIZER_MODEL,
            contents: prompt,
            config: {
                temperature: 0.8,
            }
        });

        const usage = {
            model: HUMANIZER_MODEL,
            inputTokens: response.usageMetadata?.promptTokenCount || 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        };

        return { result: response.text, usage };
    } catch (error) {
        console.error('Error in agent_humanizer:', error);
        // On failure, return the original draft text so the pipeline does not break
        console.warn('Humanizer failed — returning original draft text as fallback.');
        return { result: draftText, usage: null };
    }
};

module.exports = { humanizeDraft };
