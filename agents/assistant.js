/**
 * assistant.js — Unified, tool-calling stage assistant.
 *
 * Replaces the suggest_plan / execute_immediately flag envelope with native
 * function calling. One turn runner + declarative per-stage config instead of
 * per-stage endpoint branching.
 *
 * Execution model (client-executed tool):
 *   1. runAssistantTurn() calls the model with the stage's tools.
 *   2. Plain text response  -> { type: 'message' } — turn complete.
 *   3. Tool call response   -> { type: 'tool_call', turnState } — the browser
 *      executes the revision through the existing executeRevision machinery,
 *      then posts the tool result + turnState back; runAssistantTurn() resumes
 *      the same model turn with the real receipt in context.
 *
 * turnState is the serialized neutral-format message list (see tool_messages.js),
 * so the server stays stateless across the two HTTP legs of a tool turn.
 */

const { chatWithTools } = require('./ai-client');
const { loadSkill } = require('../utils/skills_cache');

const MAX_TOOL_ROUNDS = 3;

function loadCoreSop() {
    return loadSkill('skill_assistant_core');
}

/**
 * Per-stage assistant configuration.
 * artifactName  — what the tool changes/creates, in writer-facing language.
 * revisionTool  — whether this stage has an apply_revision path.
 * styleTool     — whether this stage can generate a style file.
 * stageFragment — extra system-prompt guidance specific to the stage.
 * entryAnalysis — isInit instruction appended to the first user message.
 */
const STAGE_CONFIG = {
    1: { name: 'Pitch', artifactName: 'pitch', revisionTool: true },
    2: { name: 'Outline', artifactName: 'outline', revisionTool: true },
    3: {
        name: 'Characters', artifactName: 'character profiles', revisionTool: true,
        stageFragment: `## STAGE 3 CHARACTER BOUNDARY
Keep the conversation anchored in character-profile mechanics (profile tiers, psychological core, functional/cameo profiles, voice, relationship dynamics). Use the outline only as context for why a character mechanic matters. Do NOT prescribe sequence- or scene-level plot placement unless the writer explicitly asks to change a downstream stage — translate timing into character-arc language instead. Stage 3 execution means updating character profiles only; if the writer asks for structural placement, flag that it belongs in Stage 4+ and ask whether to carry the note forward.`
    },
    4: { name: 'Beats', artifactName: 'beat sheet', revisionTool: true },
    5: {
        name: 'Treatment', artifactName: 'treatment', revisionTool: true,
        entryAnalysis: `## STAGE ENTRY ANALYSIS
The writer has just generated or loaded the treatment and is viewing it for the first time. Analyze it as an editorial partner — identify 2-3 specific, actionable observations about pacing, character arc momentum, structural balance between acts, or missed dramatic opportunities. Reference specific sequences or moments. Do NOT summarize what the treatment contains. Surface things the writer might not have noticed. Calibrate confidence: if a claim is an inference, say so briefly. End by asking which area the writer wants to dig into first. Do not call any tool for this message.`
    },
    6: {
        name: 'Scene Blueprint', artifactName: 'scene blueprint', revisionTool: true,
        entryAnalysis: `## STAGE ENTRY ANALYSIS
The writer has just generated the scene blueprint and is reviewing it for the first time. Analyze it as a script coordinator would — identify 2-3 specific observations about scene count balance across sequences, slugline consistency and geography, dramaturgical gaps (connective-tissue scenes without their own conflict), and pacing rhythm. Reference specific scene numbers and headings. Do NOT summarize the blueprint. Rank the most important concern first. End by recommending the best area to dig into. Do not call any tool for this message.`
    },
    7: {
        name: 'Style', artifactName: 'style directives', revisionTool: false, styleTool: true,
        stageFragment: `## STAGE 7 STYLE CONTEXT
You are helping the writer choose or create screenplay style directives for drafting. Discuss style in terms of concrete prose behavior: sentence shape, image density, dialogue rhythm, scene description, transitions, interiority, tension management, humor, and restraint. Execution means generating a saved style file with the generate_style tool. If the writer is still choosing among references or asking about fit, keep discussing. When they explicitly choose a style or confirm a direction ("use Garland", "yes, generate it", "sounds good"), call generate_style with a complete self-contained style brief.`,
        entryAnalysis: `## STAGE 7 STYLE SUGGESTION
The writer has scenes ready and is choosing a writing style. Suggest exactly 3 specific filmmakers or screenwriters whose style would suit this story.

Rules:
- For each suggestion: writer name, 1-sentence style description, and 1 sentence connecting it to something specific in their scenes or project context.
- Suggest a range: one intense/visceral, one restrained/observational, one unexpected/wild-card.
- If the context lists saved styles that fit, include one as a suggestion: "You already have a [Name] style that could work here."
- End with: "Pick one and I'll build the style, or describe something different."
- Also mention: "Or choose 'No Style' above to draft in a clean, neutral voice."
- Do not call any tool for this message.`
    },
    8: { name: 'Draft', artifactName: 'scene draft', revisionTool: true },
    9: { name: 'Coverage', artifactName: 'coverage report', revisionTool: false },
    10: { name: 'Rewrite', artifactName: 'screenplay scenes', revisionTool: false }
};

function buildTools(stageId) {
    const config = STAGE_CONFIG[stageId];
    if (config?.styleTool) {
        return [{
            name: 'generate_style',
            description: `Generate and save a Stage ${stageId} style directive file for this project. Calling this actually runs PageOne's style generator — it is the ONLY way a new style is created from the chat. Call it when the writer explicitly chooses a style direction or confirms that you should generate/build/use it. Do NOT call it while the writer is still comparing options, asking questions, or describing a vibe without confirming generation. The result reports the saved style slug/name.`,
            input_schema: {
                type: 'object',
                properties: {
                    style_brief: {
                        type: 'string',
                        description: 'Complete, self-contained style-generation brief. Include the chosen reference(s), desired tonal/prose behavior, project-specific fit, constraints, and anything to avoid.'
                    }
                },
                required: ['style_brief']
            }
        }];
    }
    if (!config?.revisionTool) return [];
    return [{
        name: 'apply_revision',
        description: `Apply a revision to the writer's saved Stage ${stageId} ${config.artifactName}. Calling this actually runs PageOne's revision engine — it is the ONLY way the saved ${config.artifactName} changes; describing a change does not apply it. Call it when the writer gives a direct, unambiguous instruction needing no creative judgment, or explicitly confirms a discussed direction ("yes do it", "go ahead", "apply that"). Do NOT call it while the direction is still being explored or the writer's latest message contains questions or new concerns. The result reports whether the artifact actually changed.`,
        input_schema: {
            type: 'object',
            properties: {
                revision_brief: {
                    type: 'string',
                    description: `Complete, self-contained instructions for the revision engine. The engine sees ONLY this brief, not the conversation — include every specific change agreed (sequence/scene numbers, character names, exact replacements or additions) and state what must be preserved. Scope it tightly: do not include older discussion items the writer has not confirmed for this revision.`
                }
            },
            required: ['revision_brief']
        }
    }];
}

function buildSystemPrompt(stageId) {
    const config = STAGE_CONFIG[stageId] || {};
    let system = loadCoreSop();
    if (config.stageFragment) system += `\n\n---\n\n${config.stageFragment}`;
    return system;
}

function buildCadenceFragment(userExchangeCount) {
    if (userExchangeCount >= 5) {
        return `\n\n[PageOne note: This is exchange ${userExchangeCount}. Apply the Decision Cadence rule now — name the strongest current recommendation or unresolved fork and offer the fitted next move. No further open-ended clarifying questions unless the writer asked to keep exploring.]`;
    }
    if (userExchangeCount >= 4) {
        return `\n\n[PageOne note: This is exchange ${userExchangeCount}. On your next response, be ready to apply the Decision Cadence rule — avoid another open-ended question unless the writer asks to keep exploring.]`;
    }
    return '';
}

/**
 * Build the neutral message list for a fresh turn from persisted chat history.
 * The context block (project/stage/knowledge/prior conversations) is prepended
 * to the first user message so the system prompt stays stable and cacheable.
 */
function buildNeutralMessages({ contextBlock, history, isInit, stageId }) {
    const config = STAGE_CONFIG[stageId] || {};
    const messages = [];

    if (isInit) {
        const instruction = config.entryAnalysis
            || '## STAGE ENTRY\nGreet the writer briefly with your sharpest editorial observation about the current stage material, then ask what they want to work on. Do not call any tool.';
        messages.push({ role: 'user', text: `${contextBlock}\n\n---\n\n${instruction}` });
        return messages;
    }

    const turns = (history || []).filter(m => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'));
    const userExchangeCount = turns.filter(m => m.role === 'user').length;
    let firstUserSeen = false;
    for (let i = 0; i < turns.length; i++) {
        const m = turns[i];
        if (m.role === 'user') {
            let text = m.content;
            if (!firstUserSeen) {
                text = `${contextBlock}\n\n---\n\n## CONVERSATION\n\n${text}`;
                firstUserSeen = true;
            }
            if (i === turns.length - 1) {
                text += buildCadenceFragment(userExchangeCount);
            }
            messages.push({ role: 'user', text });
        } else {
            messages.push({ role: 'assistant', text: m.content });
        }
    }
    if (!firstUserSeen) {
        messages.unshift({ role: 'user', text: `${contextBlock}\n\n---\n\nThe writer has not said anything yet. Open the conversation.` });
    }
    return messages;
}

function countToolRounds(messages) {
    return messages.filter(m => m.role === 'assistant' && m.toolCalls?.length).length;
}

function toolResultsContainFailure(toolResults) {
    return Array.isArray(toolResults) && toolResults.some(r => (
        r.isError || r.result?.changed === false || r.result?.error
    ));
}

/**
 * Run one assistant turn (or resume one after client-side tool execution).
 *
 * @param {object} opts
 * @param {number} opts.stageId
 * @param {string} opts.contextBlock   Pre-built project/stage/knowledge context (fresh turns only).
 * @param {Array}  opts.history        Persisted chat history [{role, content}] (fresh turns only).
 * @param {boolean} opts.isInit
 * @param {string|null} opts.turnState Serialized neutral messages from a pending tool turn.
 * @param {Array|null} opts.toolResults [{id, name, result, isError}] from the browser.
 * @param {object} opts.modelConfig    { model, geminiApiKey, anthropicApiKey }
 * @returns {{type:'message'|'tool_call', message:string, toolCalls?:Array, turnState?:string, usageList:Array}}
 */
async function runAssistantTurn({ stageId, contextBlock = '', history = [], isInit = false, turnState = null, toolResults = null, modelConfig }) {
    let neutralMessages;
    if (turnState) {
        neutralMessages = JSON.parse(turnState);
        if (!Array.isArray(neutralMessages)) throw new Error('Invalid turnState');
        if (Array.isArray(toolResults) && toolResults.length) {
            neutralMessages.push({ role: 'tool', results: toolResults });
        }
    } else {
        neutralMessages = buildNeutralMessages({ contextBlock, history, isInit, stageId });
    }

    // Withhold tools when the model must answer in text: entry analysis, after
    // MAX_TOOL_ROUNDS in one turn, or right after a failed tool execution — a
    // failed revision is reported to the writer, not silently retried.
    const lastToolErrored = toolResultsContainFailure(toolResults);
    const tools = (isInit || lastToolErrored || countToolRounds(neutralMessages) >= MAX_TOOL_ROUNDS)
        ? []
        : buildTools(stageId);

    const response = await chatWithTools({
        model: modelConfig.model,
        geminiApiKey: modelConfig.geminiApiKey,
        anthropicApiKey: modelConfig.anthropicApiKey,
        system: buildSystemPrompt(stageId),
        messages: neutralMessages,
        tools,
        temperature: 0.7,
        maxTokens: 4000
    });

    if (response.toolCalls.length) {
        neutralMessages.push({ role: 'assistant', text: response.text || '', toolCalls: response.toolCalls });
        return {
            type: 'tool_call',
            message: response.text || '',
            toolCalls: response.toolCalls,
            turnState: JSON.stringify(neutralMessages),
            usageList: [response.usage]
        };
    }

    return { type: 'message', message: response.text, usageList: [response.usage] };
}

module.exports = { runAssistantTurn, STAGE_CONFIG, buildTools, buildNeutralMessages, toolResultsContainFailure };
