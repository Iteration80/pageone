const { GoogleGenAI } = require('@google/genai');

// Initialize the Google Gen AI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const agent2Outline = async (pitchData) => {
    const systemInstruction = "You are an elite Hollywood Story Architect. Your objective is to take a movie pitch and expand it into a professional, highly readable 8-Sequence Broad Outline. CRITICAL RULES: The 8-Sequence Structure: Divide the narrative into 8 sequences (2 for Act I, 4 for Act II, 2 for Act III). Give each sequence a thematic title. Plant the Tentpoles: Ensure the major structural pillars serve as the climaxes of their respective sequences. Invisible Cause-and-Effect: The narrative must flow using the Therefore/But engine naturally. Lean Formatting: Write exclusively in present tense.";

    const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [JSON.stringify(pitchData)],
        config: {
            temperature: 0.7,
            thinkingConfig: { thinkingLevel: "HIGH" },
            systemInstruction: systemInstruction,
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    title: { type: "STRING" },
                    genre: { type: "STRING" },
                    logline: { type: "STRING" },
                    outline: {
                        type: "OBJECT",
                        properties: {
                            act_1: {
                                type: "ARRAY",
                                items: {
                                    type: "OBJECT",
                                    properties: {
                                        sequence_number_and_title: { type: "STRING" },
                                        beats: {
                                            type: "ARRAY",
                                            items: {
                                                type: "OBJECT",
                                                properties: {
                                                    beat_label: { type: "STRING" },
                                                    description: { type: "STRING" }
                                                },
                                                required: ["beat_label", "description"]
                                            }
                                        }
                                    },
                                    required: ["sequence_number_and_title", "beats"]
                                }
                            },
                            act_2: {
                                type: "ARRAY",
                                items: {
                                    type: "OBJECT",
                                    properties: {
                                        sequence_number_and_title: { type: "STRING" },
                                        beats: {
                                            type: "ARRAY",
                                            items: {
                                                type: "OBJECT",
                                                properties: {
                                                    beat_label: { type: "STRING" },
                                                    description: { type: "STRING" }
                                                },
                                                required: ["beat_label", "description"]
                                            }
                                        }
                                    },
                                    required: ["sequence_number_and_title", "beats"]
                                }
                            },
                            act_3: {
                                type: "ARRAY",
                                items: {
                                    type: "OBJECT",
                                    properties: {
                                        sequence_number_and_title: { type: "STRING" },
                                        beats: {
                                            type: "ARRAY",
                                            items: {
                                                type: "OBJECT",
                                                properties: {
                                                    beat_label: { type: "STRING" },
                                                    description: { type: "STRING" }
                                                },
                                                required: ["beat_label", "description"]
                                            }
                                        }
                                    },
                                    required: ["sequence_number_and_title", "beats"]
                                }
                            }
                        },
                        required: ["act_1", "act_2", "act_3"]
                    }
                },
                required: ["title", "genre", "logline", "outline"]
            }
        }
    });

    const rawText = response.text;
    const cleanedText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

    return JSON.parse(cleanedText);
};

module.exports = { agent2Outline };
