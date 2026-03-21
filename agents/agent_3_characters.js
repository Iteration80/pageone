const { generateContent } = require('./ai-client');
const fs = require('fs');
const path = require('path');

const agent3Characters = async (pitchData, beatsData, currentCharacters = null, notes = null, pdfFile = null, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    const skillPath = path.join(__dirname, '../skills/skill_stage3_characters.md');
    const charactersSOP = fs.readFileSync(skillPath, 'utf8');

    const characterSchema = {
        type: 'object',
        required: ['characters'],
        properties: {
            characters: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['name', 'role', 'brief_summary', 'psychological_core', 'voice_and_behavior', 'subtlety_guidelines'],
                    properties: {
                        name: { type: 'string' },
                        role: { type: 'string', description: "e.g., Protagonist, Antagonist, Catalyst, Adjuster, Supporting" },
                        brief_summary: { type: 'string', description: "A punchy, 2-sentence bio encapsulating who they are, their occupation/status, and their exact narrative function." },
                        psychological_core: {
                            type: 'object',
                            required: ['ghost_and_wound', 'the_lie', 'fear', 'desire', 'psychological_need', 'moral_need'],
                            properties: {
                                ghost_and_wound: { type: 'string', description: "The specific traumatic past event that still haunts them and caused an unhealed psychological injury." },
                                the_lie: { type: 'string', description: "The false worldview adopted to protect them from the Ghost — a belief that once served them but now holds them back." },
                                fear: { type: 'string' },
                                desire: { type: 'string', description: "A highly specific, visible, and trackable external goal they are chasing." },
                                psychological_need: { type: 'string', description: "The internal flaw they must overcome that is hurting themselves." },
                                moral_need: { type: 'string', description: "The internal flaw they must overcome that is actively hurting others." }
                            }
                        },
                        voice_and_behavior: {
                            type: 'object',
                            required: ['speech_patterns', 'deflection_tactic', 'paradox'],
                            properties: {
                                speech_patterns: { type: 'string', description: "How they talk and what they NEVER say." },
                                deflection_tactic: { type: 'string', description: "Their go-to deflection when they don't want to answer honestly." },
                                paradox: { type: 'string', description: "A contradictory trait that defies stereotypes and adds complex layers (e.g., a tough cop who writes poetry)." }
                            }
                        },
                        subtlety_guidelines: { type: 'string', description: "How they mask their flaws 90% of the time, and what behavioral contradiction surfaces under stress." }
                    }
                }
            }
        }
    };

    // Revision Bypass Logic
    if (notes && currentCharacters) {
        console.log("  Surgical Revision Mode: Updating characters...");
        const revisionSystemInstruction = `${charactersSOP}\n\nROLE: Surgical Casting Director. Apply the user's note ONLY to the specific character(s) mentioned in the feedback. Leave all other character profiles 100% identical to the provided JSON. Do not alter unmentioned traits. Do not invent new characters unless explicitly asked. Maintain the exact same JSON schema.`;

        const revisionPrompt = `USER NOTE: ${notes}

EXISTING CHARACTERS:
${JSON.stringify(currentCharacters, null, 2)}

Please apply the note surgically and return the full updated character list in JSON format.`;

        const response = await generateContent({
            model, geminiApiKey, anthropicApiKey,
            contents: [revisionPrompt],
            config: {
                systemInstruction: revisionSystemInstruction,
                temperature: 0.3,
            },
            schema: characterSchema
        });

        return { result: JSON.parse(response.text), usage: response.usage };
    }

    const systemInstruction = charactersSOP;

    const contents = [];

    if (pdfFile) {
        contents.push({
            inlineData: {
                data: pdfFile.buffer.toString("base64"),
                mimeType: pdfFile.mimetype || "application/pdf"
            }
        });
    }

    let contentsText = `MANDATORY FIRST STEP — OUTLINE CHARACTER COVERAGE: Before creating any characters, read the outline below and identify every distinct character it describes — whether referred to by proper name (e.g., "Jax", "Silas") or by a specific role or function (e.g., "a hacker", "the engineer", "an acrobat", "an enforcer"). Every such individual MUST receive a full profile. Invent a proper name for any role-only character. Only after all outline characters are profiled may you invent additional characters.\n\nHere is the approved pitch:\n${JSON.stringify(pitchData, null, 2)}\n\nHere is the broad outline (beats):\n${JSON.stringify(beatsData, null, 2)}`;

    if (notes && currentCharacters) {
        contentsText += `\n\nThe user has provided feedback for the characters. Revise the existing characters based on these notes.\n\nEXISTING CHARACTERS:\n${JSON.stringify(currentCharacters, null, 2)}\n\nNOTES: ${notes}\n\nEnsure you return the FULL cast of characters, including unrevised ones, in the proper JSON format.`;
    }
    contents.push(contentsText);

    const response = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            systemInstruction,
            temperature: 0.6,
            thinkingConfig: { thinkingLevel: 'HIGH' },
        },
        schema: characterSchema
    });

    return { result: JSON.parse(response.text), usage: response.usage };
};

module.exports = { agent3Characters };
