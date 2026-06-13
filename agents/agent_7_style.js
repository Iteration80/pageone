const { generateContent } = require('./ai-client');
const { loadSkill } = require('../utils/skills_cache');

/**
 * Stage 7: The Style Agent
 * Generates style artifacts at two tiers:
 *   Tier 2 (Conversational): directive only — from chat description + general craft knowledge
 *   Tier 3 (Trained): reference + directive — from uploaded screenplay analysis
 */

/**
 * Generate a Tier 2 conversational directive (400-600 words).
 * Input from chat conversation, descriptions, and optional scene context.
 */
const generateDirective = async (input, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = ''
    } = modelConfig;

    const styleSop = loadSkill('skill_stage7_style');

    const {
        description = '',
        sceneSummaries = '',
        conversationHistory = []
    } = input;

    let prompt = `${styleSop}\n\n`;

    if (knowledgeContext) {
        prompt += `## PROJECT SOURCE CANON\n${knowledgeContext}\n\n`;
    }

    if (conversationHistory.length > 0) {
        prompt += `## CONVERSATION HISTORY\n`;
        for (const msg of conversationHistory) {
            prompt += `${msg.role === 'user' ? 'WRITER' : 'ASSISTANT'}: ${msg.content}\n\n`;
        }
    }

    if (description) {
        prompt += `## WRITER'S STYLE DESCRIPTION\n${description}\n\n`;
    }

    if (sceneSummaries) {
        prompt += `## STORY CONTEXT (Stage 6 Scene Summaries)\n${sceneSummaries}\n\n`;
    }

    prompt += `## INSTRUCTIONS
Generate the style directive now. Translate named references into neutral craft behaviors. Do not tell the draft agent to imitate, clone, or copy any specific writer, studio, franchise, or protected work.
Output the complete file including YAML front matter and all six sections (Scene Construction, Action Lines, Dialogue, Tone, Signature Moves, Avoid).
Use imperative voice throughout. Keep within 400-600 words (excluding front matter).
The YAML front matter MUST include these fields: name, slug, created, tier: "conversational", source: "conversation", artifact_type: "directive", tonal_summary, word_count.
Output ONLY the file content — no introductory text, no code blocks.`;

    try {
        const response = await generateContent({
            model, geminiApiKey, anthropicApiKey,
            contents: prompt,
            config: { temperature: 0.7 }
        });
        return { result: response.text, usage: response.usage };
    } catch (error) {
        console.error('Error in agent_7_style (generateDirective):', error);
        throw error;
    }
};

// Keep old name as alias for backward compat
const generateStyleFile = generateDirective;

/**
 * Generate a Tier 3 trained style from uploaded screenplay text(s).
 * Two-step process:
 *   1. Analyze screenplay(s) → full reference (2000+ words)
 *   2. Distill reference → compact directive (400-600 words)
 * Returns { reference, directive, usageList }
 */
const generateTrainedStyle = async (input, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = ''
    } = modelConfig;

    const styleSop = loadSkill('skill_stage7_style');

    const {
        styleName = '',
        screenplayTexts = [],
        screenplayTitles = [],
        conversationHistory = []
    } = input;

    const usageList = [];

    // --- Step 1: Analyze each screenplay individually (parallel) ---
    // Each script gets its own API call to stay within context limits.
    // A single screenplay can be 80-120 pages (~30K words), so we analyze one at a time.
    const analysisPromises = screenplayTexts.map((text, i) => {
        const title = screenplayTitles[i] || `Screenplay ${i + 1}`;

        let prompt = `${styleSop}\n\n`;
        if (knowledgeContext) {
            prompt += `## PROJECT SOURCE CANON\n${knowledgeContext}\n\n`;
        }
        prompt += `## MODE: TRAINED STYLE — SINGLE SCREENPLAY ANALYSIS\n\n`;

        if (conversationHistory.length > 0) {
            prompt += `## CONVERSATION HISTORY\n`;
            for (const msg of conversationHistory) {
                prompt += `${msg.role === 'user' ? 'WRITER' : 'ASSISTANT'}: ${msg.content}\n\n`;
            }
        }

        prompt += `## SCREENPLAY: "${title}"\n${text}\n\n`;

        prompt += `## INSTRUCTIONS
Analyze this screenplay and extract its stylistic DNA. Focus on what makes this writer's voice distinctive.

Cover these areas with concrete evidence (cite specific lines, scenes, or passages):
1. **Scene Construction** — How scenes open/close, transition patterns, scene length tendencies
2. **Action Lines** — Sentence length, verb choices, visual density, white space usage
3. **Dialogue** — Rhythm, subtext patterns, character voice differentiation, exposition handling
4. **Tone** — Mood control, tonal shifts, humor/gravity balance
5. **Pacing** — Scene-to-scene momentum, tension/release patterns, act structure
6. **Signature Moves** — Recurring techniques, distinctive quirks, trademark patterns
7. **Anti-Patterns** — What this writer deliberately avoids

Target 800-1200 words of analysis. Extract patterns from the actual text — not from training knowledge about the writer.
Output ONLY the analysis — no preamble, no code blocks.`;

        return generateContent({
            model, geminiApiKey, anthropicApiKey,
            contents: prompt,
            config: { temperature: 0.5 }
        });
    });

    const analysisResults = await Promise.all(analysisPromises);
    for (const r of analysisResults) usageList.push(r.usage);

    // --- Step 2: Synthesize per-script analyses into full reference ---
    let synthPrompt = `${styleSop}\n\n`;
    if (knowledgeContext) {
        synthPrompt += `## PROJECT SOURCE CANON\n${knowledgeContext}\n\n`;
    }
    synthPrompt += `## MODE: TRAINED STYLE — SYNTHESIS\n\n`;

    if (conversationHistory.length > 0) {
        synthPrompt += `## CONVERSATION HISTORY\n`;
        for (const msg of conversationHistory) {
            synthPrompt += `${msg.role === 'user' ? 'WRITER' : 'ASSISTANT'}: ${msg.content}\n\n`;
        }
    }

    synthPrompt += `## PER-SCREENPLAY ANALYSES\n`;
    for (let i = 0; i < analysisResults.length; i++) {
        const title = screenplayTitles[i] || `Screenplay ${i + 1}`;
        synthPrompt += `### ${title}\n${analysisResults[i].text}\n\n`;
    }

    synthPrompt += `## INSTRUCTIONS
Synthesize the per-screenplay analyses above into a UNIFIED STYLE REFERENCE (2000-3000 words).
Identify patterns that are consistent across scripts (core style) vs. unique to individual works.
Weight recurring patterns more heavily — they represent the writer's true voice.

The YAML front matter MUST include: name, slug, created, tier: "trained", source: "screenplay-analysis", screenplays_analyzed: [${screenplayTitles.map(t => `"${t}"`).join(', ')}], artifact_type: "reference", tonal_summary, word_count.
${styleName ? `Use "${styleName}" as the style name.` : ''}

Include these sections with deep, evidence-backed analysis:
## Scene Construction Patterns
## Action Line Fingerprint
## Dialogue Rhythms
## Tonal Signature
## Pacing DNA
## Visual vs. Verbal Balance
## Signature Moves
## Anti-Patterns (What This Writer Avoids)

Cite specific examples from the analyses. Target 2000-3000 words.
Output ONLY the reference file content — no introductory text, no code blocks.`;

    const refResponse = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents: synthPrompt,
        config: { temperature: 0.5 }
    });
    usageList.push(refResponse.usage);

    const referenceText = refResponse.text;

    // --- Step 3: Distill reference into compact directive ---
    let distillPrompt = `${styleSop}\n\n`;
    distillPrompt += `## MODE: DISTILLATION — REFERENCE TO DIRECTIVE\n\n`;
    distillPrompt += `## FULL STYLE REFERENCE\n${referenceText}\n\n`;

    distillPrompt += `## INSTRUCTIONS
Distill the full style reference above into a COMPACT DIRECTIVE (400-600 words).
Preserve the most impactful patterns. Use imperative voice throughout.

The YAML front matter MUST include: name (same as reference), slug (same as reference), created, tier: "trained", source: "screenplay-analysis", artifact_type: "directive", paired_with: "[slug]-reference", tonal_summary (same as reference), word_count.

Use these six sections:
## Scene Construction
## Action Lines
## Dialogue
## Tone
## Signature Moves
## Avoid

Output ONLY the directive file content — no introductory text, no code blocks.`;

    const dirResponse = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents: distillPrompt,
        config: { temperature: 0.5 }
    });
    usageList.push(dirResponse.usage);

    return {
        reference: referenceText,
        directive: dirResponse.text,
        usageList
    };
};

/**
 * Parse YAML front matter from a style file.
 * Returns { meta: {name, slug, created, tier, source, artifact_type, paired_with,
 *   screenplays_analyzed, references, tonal_summary, word_count}, body: string }
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

module.exports = { generateStyleFile, generateDirective, generateTrainedStyle, parseStyleFile };
