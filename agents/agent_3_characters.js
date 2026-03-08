const { GoogleGenAI, Type } = require('@google/genai');

// Initialize the Google Gen AI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const agent3Characters = async (pitchData, beatsData, currentCharacters = null, notes = null) => {
    const systemInstruction = `You are an elite Hollywood Casting Director and Character Developer. Read the provided Pitch and Broad Outline. Your job is NOT just to extract characters mentioned in the text—your job is to CAST THE ENTIRE ECOSYSTEM of the movie. 

CRITICAL RULES:
1. Proactive Casting: You must generate the Protagonist and Antagonist, AND YOU MUST INVENT 3 to 4 distinct supporting characters. Do not use a generic checklist. You must analyze the GENRE and THEME of the provided Pitch, and invent supporting characters that fulfill genre-specific functions (e.g., the 'Harbinger' or 'Skeptic' in Horror, the 'Shape-shifter' or 'False Ally' in a Thriller, the 'Best Friend' in a Rom-Com). At minimum, you must include the B-Story Anchor (the character who will drive the protagonist's internal emotional growth), plus 2 to 3 other characters explicitly tailored to challenge the protagonist's psychological core and flesh out this specific narrative world.
2. Psychological Core: Give characters a Wound, False Belief, Fear, Desire, and Need to drive their growth. 
3. Voice & Deflection: Define how they speak, what they NEVER say, and their specific deflection tactic when avoiding truth. 
4. Subtlety (90/10 Rule): Characters must behave like grounded humans. Their specific tics/deflections should only surface 10% of the time under stress.`;

    const characterSchema = {
        type: Type.OBJECT,
        required: ['characters'],
        properties: {
            characters: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    required: ['name', 'role', 'brief_summary', 'psychological_core', 'voice_and_behavior', 'subtlety_guidelines'],
                    properties: {
                        name: { type: Type.STRING },
                        role: { type: Type.STRING, description: "e.g., Protagonist, Antagonist, Supporting" },
                        brief_summary: { type: Type.STRING, description: "A punchy, 2-sentence bio encapsulating who they are, their occupation/status, and their exact narrative function." },
                        psychological_core: {
                            type: Type.OBJECT,
                            required: ['wound', 'false_belief', 'fear', 'desire', 'need'],
                            properties: {
                                wound: { type: Type.STRING },
                                false_belief: { type: Type.STRING },
                                fear: { type: Type.STRING },
                                desire: { type: Type.STRING },
                                need: { type: Type.STRING }
                            }
                        },
                        voice_and_behavior: {
                            type: Type.OBJECT,
                            required: ['speech_patterns', 'deflection_tactic'],
                            properties: {
                                speech_patterns: { type: Type.STRING, description: "How they talk and what they NEVER say." },
                                deflection_tactic: { type: Type.STRING, description: "Their go-to deflection when they don't want to answer honestly." }
                            }
                        },
                        subtlety_guidelines: { type: Type.STRING, description: "How they mask their flaws in normal conversation." }
                    }
                }
            }
        }
    };

    let contentsText = `Here is the approved pitch:\n${JSON.stringify(pitchData, null, 2)}\n\nHere is the broad outline (beats):\n${JSON.stringify(beatsData, null, 2)}`;

    if (notes && currentCharacters) {
        contentsText += `\n\nThe user has provided feedback for the characters. Revise the existing characters based on these notes.\n\nEXISTING CHARACTERS:\n${JSON.stringify(currentCharacters, null, 2)}\n\nNOTES: ${notes}\n\nEnsure you return the FULL cast of characters, including unrevised ones, in the proper JSON format.`;
    }

    const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: contentsText,
        config: {
            systemInstruction: systemInstruction,
            temperature: 0.6,
            thinkingConfig: { thinkingLevel: 'HIGH' },
            responseMimeType: "application/json",
            responseSchema: characterSchema,
        }
    });

    return JSON.parse(response.text);
};

module.exports = { agent3Characters };
