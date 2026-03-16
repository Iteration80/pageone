const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const coverageSchema = {
    type: "object",
    properties: {
        title:  { type: "string" },
        genre:  { type: "string" },
        logline: { type: "string" },
        evaluation_grid: {
            type: "object",
            properties: {
                concept:          { type: "string", enum: ["Excellent", "Good", "Fair", "Poor"] },
                structure:        { type: "string", enum: ["Excellent", "Good", "Fair", "Poor"] },
                characterization: { type: "string", enum: ["Excellent", "Good", "Fair", "Poor"] },
                pacing:           { type: "string", enum: ["Excellent", "Good", "Fair", "Poor"] },
                dialogue:         { type: "string", enum: ["Excellent", "Good", "Fair", "Poor"] },
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
        strengths:  { type: "string" },
        weaknesses: { type: "string" },
        priority_todo: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    priority: { type: "integer" },
                    category: { type: "string" },
                    task:     { type: "string" },
                },
                required: ["priority", "category", "task"]
            }
        },
        recommendation: {
            type: "object",
            properties: {
                grade:         { type: "string", enum: ["PASS", "CONSIDER", "RECOMMEND"] },
                justification: { type: "string" }
            },
            required: ["grade", "justification"]
        }
    },
    required: ["title", "genre", "logline", "evaluation_grid", "synopsis", "authenticity", "strengths", "weaknesses", "priority_todo", "recommendation"]
};

/**
 * Stage 8: Coverage Agent
 * Generates professional Hollywood-style script coverage for a full assembled screenplay.
 *
 * @param {string} fullScriptText - All scene drafts concatenated in order
 * @param {object} projectContext - { title, genre, logline, synopsis, characters }
 * @returns {Promise<object>} - Structured coverage report
 */
const agent8Coverage = async (fullScriptText, projectContext) => {
    const sop = fs.readFileSync(path.join(__dirname, '../skills/skill_stage8_coverage.md'), 'utf8');

    const prompt = `
## PROJECT CONTEXT
Title: ${projectContext.title || 'Untitled'}
Genre: ${projectContext.genre || 'Unknown'}
Logline: ${projectContext.logline || 'Not provided'}

Synopsis:
${projectContext.synopsis || 'Not provided'}

---

## FULL SCREENPLAY

${fullScriptText}
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: prompt,
            config: {
                systemInstruction: sop,
                temperature: 0.4,
                thinkingConfig: { thinkingLevel: 'HIGH' },
                responseMimeType: 'application/json',
                responseSchema: coverageSchema,
            }
        });

        return JSON.parse(response.text);
    } catch (error) {
        console.error('Error in agent_8_coverage:', error);
        throw error;
    }
};

module.exports = { agent8Coverage };
