const { GoogleGenAI, Type } = require('@google/genai');
const fs = require('fs');
const path = require('path');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Stage 5 Treatment Agent (Chained Prompt Architecture)
 * Transform pitch, characters, and 8-sequence beats into a granular 4-act treatment.
 * Uses 4 sequential ai.models.generateContent() calls to build the treatment piece by piece.
 */
const agent5Treatment = async (pitchData, charactersData, beatsData, currentTreatment = null, notes = null, onProgress = null) => {
    const skillPath = path.join(__dirname, '../skills/skill_stage5_treatment.md');
    const treatmentSOP = fs.readFileSync(skillPath, 'utf8');

    const systemInstruction = treatmentSOP;

    const treatmentSchema = {
        type: Type.OBJECT,
        properties: {
            title_logline_characters: { type: Type.STRING },
            act_1: { type: Type.STRING },
            act_2a: { type: Type.STRING },
            act_2b: { type: Type.STRING },
            act_3: { type: Type.STRING }
        },
        required: ['title_logline_characters', 'act_1', 'act_2a', 'act_2b', 'act_3']
    };

    // Revision Bypass Logic
    if (notes && currentTreatment) {
        console.log("  Surgical Revision Mode: Applying user notes...");
        if (onProgress) onProgress(1, 1, 'Applying revision...');
        const revisionSystemInstruction = `${treatmentSOP}\n\nROLE: Surgical Script Editor. Apply the user's note to the text, but DO NOT rewrite or alter ANY plot points, character names, or pacing outside the scope of the note. If the note only applies to Act 1, keep the rest of the text 100% identical to the provided current treatment. Maintain the exact same formatting.`;

        const revisionPrompt = `USER NOTE: ${notes}

EXISTING TREATMENT:
${JSON.stringify(currentTreatment, null, 2)}

Please apply the note surgically and return the full updated treatment in JSON format. Ensure you do not change anything else.`;

        const revisionConfig = {
            systemInstruction: revisionSystemInstruction,
            temperature: 0.3,
            responseMimeType: "application/json",
            responseSchema: treatmentSchema,
        };

        const result = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [revisionPrompt],
            config: revisionConfig,
        });

        return JSON.parse(result.text);
    }

    const baseConfig = {
        systemInstruction: systemInstruction,
        temperature: 0.5,
        responseMimeType: "application/json",
        responseSchema: treatmentSchema,
    };

    // Step 1: Title/Logline/Characters + Act I (Sequences 1 & 2)
    console.log("  Chain Step 1/4: Writing Title, Logline, Characters & Act I...");
    if (onProgress) onProgress(1, 4, 'Writing Act I (Sequences 1–2)...');
    const step1Prompt = `Read Sequences 1 & 2. You must systematically expand EVERY SINGLE BEAT (Opening Image, Theme Stated, Setup, Catalyst, Debate) into full, multi-paragraph narrative prose. Do not skip any beats. Do not compress the timeline.

PITCH: ${JSON.stringify(pitchData)}
CHARACTERS: ${JSON.stringify(charactersData)}
BEATS (Sequences 1-2): ${JSON.stringify(beatsData.filter(s => s.sequence_number <= 2))}

Return JSON with ONLY 'title_logline_characters' and 'act_1' populated. Leave others empty.`;

    const result1 = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [step1Prompt],
        config: baseConfig,
    });
    const parsed1 = JSON.parse(result1.text);

    // Step 2: Act IIA (Sequences 3 & 4)
    console.log("  Chain Step 2/4: Writing Act II (Part 1)...");
    if (onProgress) onProgress(2, 4, 'Writing Act II – Part 1 (Sequences 3–4)...');
    const step2Prompt = `Read Sequences 3 & 4. You must systematically expand EVERY SINGLE BEAT (Break into Two, B-Story, Fun and Games) into full, multi-paragraph narrative prose. Describe the micro-actions.

PRIOR CONTEXT (Act I):
${parsed1.title_logline_characters}
${parsed1.act_1}

BEATS (Sequences 3-4): ${JSON.stringify(beatsData.filter(s => s.sequence_number === 3 || s.sequence_number === 4))}

Return JSON with ONLY the 'act_2a' field populated. Leave others empty.`;

    const result2 = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [step2Prompt],
        config: baseConfig,
    });
    const parsed2 = JSON.parse(result2.text);

    // Step 3: Act IIB (Sequences 5 & 6)
    console.log("  Chain Step 3/4: Writing Act II (Part 2)...");
    if (onProgress) onProgress(3, 4, 'Writing Act II – Part 2 (Sequences 5–6)...');
    const step3Prompt = `Read Sequences 5 & 6. You must systematically expand EVERY SINGLE BEAT (Bad Guys Close In, All is Lost, Dark Night of the Soul) into full, multi-paragraph narrative prose. Maximize the emotional toll and physical stakes.

PRIOR CONTEXT (Act I - IIA):
${parsed2.act_2a}

BEATS (Sequences 5-6): ${JSON.stringify(beatsData.filter(s => s.sequence_number === 5 || s.sequence_number === 6))}

Return JSON with ONLY the 'act_2b' field populated. Leave others empty.`;

    const result3 = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [step3Prompt],
        config: baseConfig,
    });
    const parsed3 = JSON.parse(result3.text);

    // Step 4: Act III (Sequences 7 & 8)
    console.log("  Chain Step 4/4: Writing Act III...");
    if (onProgress) onProgress(4, 4, 'Writing Act III (Sequences 7–8)...');
    const step4Prompt = `Read Sequences 7 & 8. You must systematically expand EVERY SINGLE BEAT (Break into Three, Finale, Final Image) into full, multi-paragraph narrative prose. Describe the climax beat-by-beat.

PRIOR CONTEXT:
${parsed3.act_2b}

BEATS (Sequences 7-8): ${JSON.stringify(beatsData.filter(s => s.sequence_number === 7 || s.sequence_number === 8))}

Return JSON with ONLY the 'act_3' field populated. Leave others empty.`;

    const result4 = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [step4Prompt],
        config: baseConfig,
    });
    const finalParsed = JSON.parse(result4.text);

    return {
        title_logline_characters: parsed1.title_logline_characters,
        act_1: parsed1.act_1,
        act_2a: parsed2.act_2a,
        act_2b: parsed3.act_2b,
        act_3: finalParsed.act_3
    };
};

module.exports = { agent5Treatment };
