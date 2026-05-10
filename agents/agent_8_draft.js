const { generateContent } = require('./ai-client');
const {
    buildMemorySourceContract,
    buildMemorySourcePromptBlock
} = require('./memory_contract');
const fs = require('fs');
const path = require('path');

function compactText(value, maxChars = 4000) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 120).trim()}\n\n[...truncated ${text.length - maxChars + 120} chars...]`;
}

/**
 * Stage 8: The Draft Agent
 * Generates one scene at a time based on the blueprint and project context.
 */
const generateSceneDraft = async (sceneData, projectContext, revisionNotes = null, modelConfig = {}, styleContent = null, continuityContext = '', sceneLockPacket = '') => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = '',
        generateContentFn = generateContent
    } = modelConfig;

    // Read the Screenwriting SOP rules
    const rulesPath = path.join(__dirname, '../skills/skill_stage8_draft.md');
    const screenwritingRules = fs.readFileSync(rulesPath, 'utf8');

    const styleSection = styleContent
        ? `\n## STYLE DIRECTIVES\nThe following directives describe the writing style for this project.\nTreat them as primary craft instructions when making decisions about dialogue rhythm,\naction detail, tonal register, pacing, and voice.\n\n${styleContent}\n`
        : '';

    const revisionSection = revisionNotes
        ? `\n## REVISION NOTES\nApply the following notes to the existing draft while preserving the core scene structure and blueprint:\n${revisionNotes}\n\n## EXISTING DRAFT\n${sceneData.draft_text || 'No existing draft.'}\n`
        : '';
    const sourceSection = buildMemorySourcePromptBlock(knowledgeContext, 'Stage 8 Draft Scene');
    const sceneLockSection = sceneLockPacket
        ? `\n## SCENE LOCK PACKET\nUse this packet as the binding local continuity contract for the scene you are drafting. It defines what must remain true before, during, and after this scene.\n\n${compactText(sceneLockPacket, 7000)}\n`
        : '';

    const prompt = `
${screenwritingRules}
${styleSection}
${sourceSection}
${continuityContext}
${sceneLockSection}
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
Do not alter the plot facts, character placements, scene endpoint, prop path, or causal handoff defined by the Scene Blueprint and Scene Lock Packet.
You may invent dialogue, blocking, and texture only inside those approved boundaries.
Output ONLY the raw Fountain-formatted text.
Do not wrap it in markdown code blocks.
Do not include any introductory or concluding text.
    `;

    try {
        const response = await generateContentFn({
            model, geminiApiKey, anthropicApiKey,
            contents: prompt,
            config: {
                systemInstruction: buildMemorySourceContract('Stage 8 Draft Scene'),
                temperature: 0.7,
            }
        });

        return { result: response.text, usage: response.usage };
    } catch (error) {
        console.error('Error in agent_8_draft:', error);
        throw error;
    }
};

module.exports = { generateSceneDraft };
