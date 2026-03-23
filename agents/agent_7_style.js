const { generateContent } = require('./ai-client');
const fs = require('fs');
const path = require('path');

/**
 * Stage 7: The Style Agent
 * Analyzes user input (chat description, form data, writing samples) and generates
 * a style skill file — actionable craft directives for the Draft and Rewrite agents.
 */
const generateStyleFile = async (input, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    // Read the Style SOP
    const sopPath = path.join(__dirname, '../skills/skill_stage7_style.md');
    const styleSop = fs.readFileSync(sopPath, 'utf8');

    const {
        description = '',
        formData = null,
        sampleTexts = [],
        sceneSummaries = '',
        conversationHistory = []
    } = input;

    // Build prompt sections
    let prompt = `${styleSop}\n\n`;

    // Conversation history (if chat mode)
    if (conversationHistory.length > 0) {
        prompt += `## CONVERSATION HISTORY\n`;
        for (const msg of conversationHistory) {
            prompt += `${msg.role === 'user' ? 'WRITER' : 'ASSISTANT'}: ${msg.content}\n\n`;
        }
    }

    // User description
    if (description) {
        prompt += `## WRITER'S STYLE DESCRIPTION\n${description}\n\n`;
    }

    // Form data (Quick Start mode)
    if (formData) {
        prompt += `## STRUCTURED STYLE INPUT\n`;
        if (formData.name) prompt += `Style Name: ${formData.name}\n`;
        if (formData.references?.length) prompt += `References: ${formData.references.join(', ')}\n`;
        if (formData.characteristics?.length) prompt += `Key Characteristics: ${formData.characteristics.join(', ')}\n`;
        if (formData.sliders) {
            prompt += `Tonal Sliders:\n`;
            for (const [key, val] of Object.entries(formData.sliders)) {
                prompt += `  - ${key}: ${val}\n`;
            }
        }
        prompt += '\n';
    }

    // Writing samples
    if (sampleTexts.length > 0) {
        prompt += `## WRITING SAMPLES TO ANALYZE\n`;
        for (let i = 0; i < sampleTexts.length; i++) {
            prompt += `### Sample ${i + 1}\n${sampleTexts[i]}\n\n`;
        }
    }

    // Scene summaries (for context-aware style suggestion)
    if (sceneSummaries) {
        prompt += `## STORY CONTEXT (Stage 6 Scene Summaries)\n${sceneSummaries}\n\n`;
    }

    prompt += `## INSTRUCTIONS
Generate the style skill file now. Output the complete file including YAML front matter and all six sections (Scene Construction, Action Lines, Dialogue, Tone, Signature Moves, Avoid).
Use imperative voice throughout. Keep within 400-600 words (excluding front matter).
Output ONLY the style file content — no introductory text, no code blocks.`;

    try {
        const response = await generateContent({
            model, geminiApiKey, anthropicApiKey,
            contents: prompt,
            config: {
                temperature: 0.7,
            }
        });

        return { result: response.text, usage: response.usage };
    } catch (error) {
        console.error('Error in agent_7_style:', error);
        throw error;
    }
};

/**
 * Parse YAML front matter from a style file.
 * Returns { meta: {name, created, references, tonal_summary, word_count}, body: string }
 */
function parseStyleFile(content) {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) return { meta: {}, body: content };

    const meta = {};
    for (const line of fmMatch[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        let val = line.slice(colonIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        // Parse arrays like ["a", "b"]
        if (val.startsWith('[') && val.endsWith(']')) {
            try { val = JSON.parse(val); } catch { /* keep as string */ }
        }
        meta[key] = val;
    }

    return { meta, body: fmMatch[2].trim() };
}

module.exports = { generateStyleFile, parseStyleFile };
