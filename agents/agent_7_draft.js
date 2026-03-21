const { generateContent } = require('./ai-client');
const fs = require('fs');
const path = require('path');

/**
 * Stage 7: The Draft Agent
 * Generates one scene at a time based on the blueprint and project context.
 */
const generateSceneDraft = async (sceneData, projectContext, revisionNotes = null, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    // Read the Screenwriting SOP rules
    const rulesPath = path.join(__dirname, '../skills/skill_stage7_draft.md');
    const screenwritingRules = fs.readFileSync(rulesPath, 'utf8');

    const revisionSection = revisionNotes
        ? `\n## REVISION NOTES\nApply the following notes to the existing draft while preserving the core scene structure and blueprint:\n${revisionNotes}\n\n## EXISTING DRAFT\n${sceneData.draft_text || 'No existing draft.'}\n`
        : '';

    const prompt = `
${screenwritingRules}

## PROJECT CONTEXT
SYNOPSIS:
${projectContext.synopsis || 'Not provided'}

CHARACTER PROFILES:
${JSON.stringify(projectContext.characters, null, 2)}

## SPECIFIC SCENE BLUEPRINT (SCENE TO WRITE NOW)
SCENE NUMBER: ${sceneData.scene_number}
SLUGLINE: ${sceneData.scene_heading}
NARRATIVE ACTION: ${sceneData.narrative_action}
DRAMATURGICAL FUNCTION: ${sceneData.dramaturgical_function}
ESTIMATED PAGE COUNT: ${sceneData.estimated_page_count}
${revisionSection}
## INSTRUCTIONS
Write the screenplay pages for this specific scene using the provided rules.
Output ONLY the raw Fountain-formatted text.
Do not wrap it in markdown code blocks.
Do not include any introductory or concluding text.
    `;

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
        console.error('Error in agent_7_draft:', error);
        throw error;
    }
};

module.exports = { generateSceneDraft };
