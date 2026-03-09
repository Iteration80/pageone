const { GoogleGenAI, Type } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Stage 5 Treatment Agent (Chained Prompt Architecture)
 * Transform pitch, characters, and 8-sequence beats into a granular 4-act treatment.
 */
const agent5Treatment = async (pitchData, charactersData, beatsData) => {
    const model = ai.getGenerativeModel({
        model: 'gemini-3.1-pro-preview',
        generationConfig: {
            temperature: 0.5,
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title_logline_characters: { type: Type.STRING },
                    act_1: { type: Type.STRING },
                    act_2a: { type: Type.STRING },
                    act_2b: { type: Type.STRING },
                    act_3: { type: Type.STRING }
                },
                required: ['title_logline_characters', 'act_1', 'act_2a', 'act_2b', 'act_3']
            }
        },
        systemInstruction: "ROLE: You are an elite Hollywood screenwriter and development executive. Transform the provided character profiles and beat sheets into a gripping feature film treatment. OUTPUT: Present tense, third-person. First character mention in ALL CAPS followed by (age). Cinematic prose. NO camera jargon. NO traditional dialogue blocks (summarize conflict, only quote thematic punchlines). Prioritize the A-Story, weave the B-Story seamlessly. End with a clear resolution, no cliffhangers."
    });

    // Step 1: Act I (Sequences 1 & 2)
    const step1Prompt = `Generate the Title/Logline, Brief Character Breakdown, and Act I ONLY.
Strictly follow Sequences 1 & 2 of the provided beats.

PITCH: ${JSON.stringify(pitchData)}
CHARACTERS: ${JSON.stringify(charactersData)}
BEATS (Sequences 1-2): ${JSON.stringify(beatsData.filter(s => s.sequence_number <= 2))}

Return JSON with only 'title_logline_characters' and 'act_1' fields populated for now. Use empty strings for others.`;

    const result1 = await model.generateContent(step1Prompt);
    const parsed1 = JSON.parse(result1.response.text());

    // Step 2: Act IIA (Sequences 3 & 4)
    const step2Prompt = `Continue the treatment. Generate Act II (Part 1).
Strictly follow Sequences 3 & 4 of the provided beats.

PRIOR CONTEXT (Act I):
${parsed1.title_logline_characters}
${parsed1.act_1}

BEATS (Sequences 3-4): ${JSON.stringify(beatsData.filter(s => s.sequence_number === 3 || s.sequence_number === 4))}

Return JSON with the 'act_2a' field populated. Include previous fields.`;

    const result2 = await model.generateContent(step2Prompt);
    const parsed2 = JSON.parse(result2.response.text());

    // Step 3: Act IIB (Sequences 5 & 6)
    const step3Prompt = `Continue the treatment. Generate Act II (Part 2).
Strictly follow Sequences 5 & 6 of the provided beats.

PRIOR CONTEXT (Act I - IIA):
${parsed2.act_2a}

BEATS (Sequences 5-6): ${JSON.stringify(beatsData.filter(s => s.sequence_number === 5 || s.sequence_number === 6))}

Return JSON with the 'act_2b' field populated. Include previous fields.`;

    const result3 = await model.generateContent(step3Prompt);
    const parsed3 = JSON.parse(result3.response.text());

    // Step 4: Act III (Sequences 7 & 8)
    const step4Prompt = `Complete the treatment. Generate Act III.
Strictly follow Sequences 7 & 8 of the provided beats.

PRIOR CONTEXT:
${parsed3.act_2b}

BEATS (Sequences 7-8): ${JSON.stringify(beatsData.filter(s => s.sequence_number === 7 || s.sequence_number === 8))}

Return JSON with the 'act_3' field populated. Include all previous fields for a complete document.`;

    const result4 = await model.generateContent(step4Prompt);
    const finalParsed = JSON.parse(result4.response.text());

    return finalParsed;
};

module.exports = { agent5Treatment };
