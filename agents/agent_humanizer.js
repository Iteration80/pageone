const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

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
 * @param {string} draftText - Raw Fountain text from Stage 7
 * @returns {Promise<string>} - Humanized Fountain text
 */
const humanizeDraft = async (draftText) => {
    const rulesPath = path.join(__dirname, '../skills/skill_humanizer.md');
    const humanizerRules = fs.readFileSync(rulesPath, 'utf8');

    const prompt = `
${humanizerRules}

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

        return response.text;
    } catch (error) {
        console.error('Error in agent_humanizer:', error);
        // On failure, return the original draft text so the pipeline does not break
        console.warn('Humanizer failed — returning original draft text as fallback.');
        return draftText;
    }
};

module.exports = { humanizeDraft };
