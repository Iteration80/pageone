const { GoogleGenAI, Type } = require('@google/genai');

// Initialize the Google Gen AI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const agent3Characters = async (pitchData, beatsData, currentCharacters = null, notes = null) => {
    const systemInstruction = 'You are an elite Hollywood Casting Director and Character Developer. Read the provided Pitch and Broad Outline, and generate deep character profiles for EVERY named character. CRITICAL RULES: 1. Psychological Core: Give characters a Wound, False Belief, Fear, Desire, and Need to drive their growth. 2. Voice & Deflection: Define how they speak, what they NEVER say, and their specific deflection tactic when avoiding truth. 3. Subtlety (90/10 Rule): Characters must behave like grounded humans. Their specific tics/deflections should only surface 10% of the time under stress.';

    const characterSchema = {
        type: Type.OBJECT,
        required: ['characters'],
        properties: {
            characters: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    required: ['name', 'role', 'psychological_core', 'voice_and_behavior', 'subtlety_guidelines'],
                    properties: {
                        name: { type: Type.STRING },
                        role: { type: Type.STRING, description: "e.g., Protagonist, Antagonist, Supporting" },
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
