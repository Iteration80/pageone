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
                    required: ['name', 'role', 'brief_summary', 'psychological_core', 'voice_and_behavior', 'arc', 'ticks', '_deep_profile'],
                    properties: {
                        name: { type: 'string' },
                        role: { type: 'string', description: "e.g., Protagonist, Antagonist, Catalyst, Adjuster, Supporting" },
                        brief_summary: { type: 'string', description: "A punchy, 2-sentence bio encapsulating who they are, their occupation/status, and their exact narrative function." },
                        psychological_core: {
                            type: 'object',
                            required: ['ghost_and_wound', 'the_lie', 'fear', 'desire', 'psychological_need', 'moral_need', 'paradox'],
                            properties: {
                                ghost_and_wound: { type: 'string', description: "The specific traumatic past event that still haunts them and caused an unhealed psychological injury." },
                                the_lie: { type: 'string', description: "The false worldview adopted to protect them from the Ghost — a belief that once served them but now holds them back." },
                                fear: { type: 'string' },
                                desire: { type: 'string', description: "A highly specific, visible, and trackable external goal they are chasing." },
                                psychological_need: { type: 'string', description: "The internal flaw they must overcome that is hurting themselves." },
                                moral_need: { type: 'string', description: "The internal flaw they must overcome that is actively hurting others." },
                                paradox: { type: 'string', description: "A contradictory trait that defies stereotypes and adds complex layers (e.g., a tough cop who writes poetry)." }
                            }
                        },
                        voice_and_behavior: {
                            type: 'object',
                            required: ['voice_tag', 'pressure_tag', 'humor_tag', 'speech_patterns', 'deflection_tactic'],
                            properties: {
                                voice_tag: { type: 'string', description: "Select from: Sparse & precise, Warm & meandering, Sharp & confrontational, Measured & diplomatic, Stream-of-consciousness, Performative & deflecting, Blunt & clipped, Lyrical & indirect. Or provide a custom tag." },
                                pressure_tag: { type: 'string', description: "How they behave under pressure. Select from: Withdraws, Controls, Lashes out, People-pleases, Dissociates, Doubles down, Goes numb, Deflects with humor. Or provide a custom tag." },
                                humor_tag: { type: 'string', description: "Their humor style. Select from: Dry wit, Self-deprecating, Dark / gallows, Physical, Deflection, None. Or provide a custom tag." },
                                speech_patterns: { type: 'string', description: "How they talk and what they NEVER say. Concrete sentence-level rules derived from their personality type." },
                                deflection_tactic: { type: 'string', description: "Their go-to deflection when they don't want to answer honestly." }
                            }
                        },
                        arc: {
                            type: 'object',
                            required: ['core_drive', 'direction'],
                            properties: {
                                core_drive: { type: 'string', description: "Select from: To be right, To be needed, To succeed, To be unique, To understand, To be safe, To be free, To be in control, To keep peace. Or provide a custom drive." },
                                direction: { type: 'string', description: "Growth, Decline, or Circular" }
                            }
                        },
                        ticks: {
                            type: 'object',
                            required: ['enabled'],
                            properties: {
                                enabled: { type: 'boolean', description: "Whether this character has a physical tic or behavioral tell. Not every character needs one." },
                                description: { type: 'string', description: "The specific tic/tell and what psychological function it serves." },
                                frequency_gate: { type: 'string', description: "Exactly when this tic surfaces (e.g., 'Only when she is alone and feels financially trapped'). Must include when the tic evolves or disappears as the arc completes." }
                            }
                        },
                        _deep_profile: {
                            type: 'object',
                            required: ['mbti_type', 'enneagram_type', 'enneagram_wing', 'stress_behavior', 'growth_behavior', 'dialogue_fingerprint', 'relationship_dynamics', 'scene_behavior_predictions'],
                            properties: {
                                mbti_type: { type: 'string', description: "4-letter MBTI code (e.g., INTJ, ESFP). Inferred from voice style and decision-making patterns." },
                                enneagram_type: { type: 'string', description: "Enneagram number 1-9 (e.g., 'Type 4'). Inferred from core_drive, fear, and pressure response." },
                                enneagram_wing: { type: 'string', description: "Adjacent wing (e.g., '4w5'). Refines the core type." },
                                stress_behavior: { type: 'string', description: "Concrete behavioral description of what happens when this character is under maximum pressure (Enneagram stress arrow). Write as instructions for a drafting agent." },
                                growth_behavior: { type: 'string', description: "Concrete behavioral description of what emerges when this character is growing/healing (Enneagram growth arrow). Write as instructions for a drafting agent." },
                                dialogue_fingerprint: { type: 'string', description: "Technical writing rules for this character's dialogue: preferred sentence length, vocabulary domain, question style, interruption tendency, topics they avoid, filler words they use or never use. Written as concrete instructions a drafting agent can follow." },
                                relationship_dynamics: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        required: ['with_character', 'dynamic', 'friction_points', 'alliance_points'],
                                        properties: {
                                            with_character: { type: 'string', description: "Name of the other character." },
                                            dynamic: { type: 'string', description: "One-line summary of how these two interact." },
                                            friction_points: { type: 'string', description: "What triggers conflict between them." },
                                            alliance_points: { type: 'string', description: "What creates cooperation or bonding." }
                                        }
                                    }
                                },
                                scene_behavior_predictions: { type: 'string', description: "How this character behaves in low-stakes vs. high-stakes scenes. What does their stress arrow look like at the Act 2 midpoint? What does their growth arrow look like in the climax? Written as instructions for a drafting agent." }
                            }
                        }
                    }
                }
            }
        }
    };

    // Revision Bypass Logic
    if (notes && currentCharacters) {
        console.log("  Surgical Revision Mode: Updating characters...");
        const revisionSystemInstruction = `${charactersSOP}\n\nROLE: Surgical Casting Director. Apply the user's note ONLY to the specific character(s) mentioned in the feedback. Leave all other character profiles 100% identical to the provided JSON. Do not alter unmentioned traits. If the note describes or discusses a new character who is not in the existing list, create a full profile for them and add them to the cast. Maintain the exact same JSON schema.\n\nCRITICAL: Preserve the \`_deep_profile\` field exactly as provided for each character UNLESS the user's note specifically addresses personality typing, voice, or behavioral patterns. If any character's core psychological traits (ghost_and_wound, the_lie, fear, desire, paradox) or voice tags change, regenerate their \`_deep_profile\` to stay consistent. If ANY character's core traits change, regenerate \`relationship_dynamics\` for ALL characters (relationships are bidirectional).`;

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

    let contentsText = `MANDATORY FIRST STEP — OUTLINE CHARACTER COVERAGE: Before creating any characters, read the outline below and identify every distinct character it describes — whether referred to by proper name (e.g., "Jax", "Silas") or by a specific role or function (e.g., "a hacker", "the engineer", "an acrobat", "an enforcer"). Every such individual MUST receive a full profile. Invent a proper name for any role-only character. Only after all outline characters are profiled may you invent additional characters.

BEHAVIORAL ENGINE INSTRUCTIONS: For each character, after determining their psychological core and voice:
1. Internally infer their MBTI type (from voice style, decision-making, social orientation) and Enneagram type + wing (from core_drive, fear, pressure response).
2. Select the closest matching tags for voice_tag, pressure_tag, humor_tag, and core_drive from the curated options. Use the type inference to guide selection but write all visible fields in concrete, story-specific terms — never expose type codes to the user.
3. Generate the _deep_profile LAST — it depends on all visible fields. Write _deep_profile fields as technical instructions that a downstream drafting agent can follow directly. The _deep_profile is HIDDEN from the user.

Here is the approved pitch:
${JSON.stringify(pitchData, null, 2)}

Here is the broad outline (beats):
${JSON.stringify(beatsData, null, 2)}`;

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
