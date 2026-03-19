const { generateContent } = require('./ai-client');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

// Note: consolidateCoverage is initialized lazily so it picks up the API key
// that may have been set via settings after module load.

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
                grade:         { type: "string", enum: ["PASS", "CONSIDER", "RECOMMEND"] },
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
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    const response = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents: prompt,
        config: {
            systemInstruction: sop,
            temperature: 0.4,
            thinkingConfig: { thinkingLevel: 'HIGH' },
        },
        schema: coverageSchema
    });
    return JSON.parse(response.text);
};

/**
 * Consolidates 2–3 coverage results into a single consensus report.
 * Always uses the fast Gemini flash model — intentional cost optimization.
 */
const consolidateCoverage = async (results, geminiApiKey) => {
    const consolidatorSop = fs.readFileSync(
        path.join(__dirname, '../skills/skill_coverage_consolidator.md'), 'utf8'
    );
    const prompt = `Here are ${results.length} independent coverage reports for the same screenplay. Synthesize them into a single consensus report following your instructions.\n\n${results.map((r, i) => `## REPORT ${i + 1}\n${JSON.stringify(r, null, 2)}`).join('\n\n')}`;

    const consolidateAi = new GoogleGenAI({ apiKey: geminiApiKey || process.env.GEMINI_API_KEY });
    const response = await consolidateAi.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
            systemInstruction: consolidatorSop,
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: coverageSchema,
        }
    });
    return JSON.parse(response.text);
};

/**
 * Stage 8: Coverage Agent
 * Runs 3 parallel coverage analyses then consolidates into a consensus report.
 *
 * @param {string} fullScriptText - All scene drafts concatenated in order
 * @param {object} projectContext - { title, genre, logline, synopsis, characters }
 * @param {object} modelConfig    - { model, geminiApiKey, anthropicApiKey }
 * @returns {Promise<object>} - Structured coverage report
 */
const agent8Coverage = async (fullScriptText, projectContext, modelConfig = {}) => {
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

    if (successes.length === 1) {
        console.log('Coverage: only 1 run succeeded — returning single result.');
        return successes[0];
    }

    console.log(`Coverage: ${successes.length} runs succeeded — consolidating...`);
    return await consolidateCoverage(successes, modelConfig.geminiApiKey || process.env.GEMINI_API_KEY);
};

module.exports = { agent8Coverage };
