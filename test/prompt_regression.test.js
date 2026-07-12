const test = require('node:test');
const assert = require('node:assert/strict');

const {
    agent2Outline,
    outlineHasContent,
    buildRevisionChecklist,
    applyStructuralOutlinePatches
} = require('../agents/agent_2_outline');
const { sanitizeOutlineMetaBeats } = require('../utils/outline_sanitizer');
const { agent3Characters } = require('../agents/agent_3_characters');
const { agent4Beats } = require('../agents/agent_4_beats');
const { agent5Treatment } = require('../agents/agent_5_treatment');
const { generateStage6Scenes } = require('../agents/agent_6_scenes');
const { reviseStage6Scenes } = require('../agents/agent_6_revise');
const { generateSceneDraft } = require('../agents/agent_8_draft');
const { agent8Coverage } = require('../agents/agent_9_coverage');
const { rewriteScene } = require('../agents/agent_10_rewrite');
const {
    createRevisionTransaction,
    outlineRevisionAdapter,
    characterRevisionAdapter,
    stage4RevisionAdapter,
    treatmentRevisionAdapter,
    sceneBlueprintRevisionAdapter
} = require('../utils/revision_transaction');
const { labelsEqual, parseStructuralPatchOps } = require('../utils/revision_patch');
const {
    appendArtifactSnapshot,
    recordStageMutationSnapshots
} = require('../utils/artifact_snapshots');
const {
    applyStageRevisionPlan,
    STAGE_REVISION_ADAPTERS
} = require('../utils/stage_revision_kernel');
const {
    buildSourceGenerationPacket,
    buildStage10RewritePlanPrompt,
    buildStage10RewritePlannerSystemInstruction
} = require('../server');

const BASE_KNOWLEDGE_PACKET = `### Compact Memory Snapshot
- Source Bible: Mara keeps the blue key after the flooded arcade.
- Accepted Source Divergence: Jules is renamed June.
- Approved Stage Handoff: The arcade climax remains the project anchor.

### Relevant Source Documents
Graphic Novel.pdf: Mara refuses to leave June behind.`;

const DAPPLE_STAGE2_PROTECTED_BEATS = [
    {
        label: 'Dapple Rising - The Anchor',
        description: "Through the diner window: a yellow-gold pillar of light erupts over downtown Seattle. Dapple has hijacked the Mobile Processing Core, chained Furdlegurr to it, and is using the bear's pure, recently-betrayed bond with Elliot as the perfect anchor to drag the Breach into reality.",
        sequenceHint: 'Sequence E'
    },
    {
        label: 'Aftermath - A New Order',
        description: "Quist's old order is broken. Rebecca declines the badge but agrees to consult on Dapple containment.",
        sequenceHint: 'Sequence H'
    },
    {
        label: 'Closing Image - The Photo on the Wall',
        description: "Rebecca's kitchen holds the framed photo of young Becky and Dapple.",
        sequenceHint: 'Sequence H'
    }
];

test('artifact snapshots preserve WIP, exported, and approved restore points', () => {
    const project = { id: '1234567890123', data: {} };
    const entries = recordStageMutationSnapshots(project, {
        projectId: project.id,
        stage: 2,
        before: { outline: { act_1: [{ beats: [{ beat_label: 'Old', description: 'Old.' }] }] } },
        after: { outline: { act_1: [{ beats: [{ beat_label: 'New', description: 'New.' }] }] } },
        operation: 'revision',
        note: 'Update one beat',
        revisionReceipt: { verified: true }
    });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].snapshotType, 'pre_revision');
    assert.equal(entries[1].snapshotType, 'post_revision');
    assert.equal(entries[1].revisionReceipt.verified, true);

    const exported = appendArtifactSnapshot(project, {
        projectId: project.id,
        stage: 2,
        snapshot: { outline: { act_1: [{ beats: [{ beat_label: 'Exported', description: 'Exported.' }] }] } },
        snapshotType: 'exported',
        reason: 'export',
        force: true
    });
    assert.equal(exported.snapshotType, 'exported');

    const approved = appendArtifactSnapshot(project, {
        projectId: project.id,
        stage: 2,
        snapshot: { outline: { act_1: [{ beats: [{ beat_label: 'Approved', description: 'Approved.' }] }] } },
        snapshotType: 'approved',
        reason: 'approval',
        force: true
    });
    assert.equal(approved.snapshotType, 'approved');
    assert.ok(project.data.versionHistory.some(entry => entry.snapshotType === 'pre_revision'));
    assert.ok(project.data.versionHistory.some(entry => entry.snapshotType === 'post_revision'));
    assert.ok(project.data.versionHistory.some(entry => entry.snapshotType === 'exported'));
    assert.ok(project.data.versionHistory.some(entry => entry.snapshotType === 'approved'));
});

const pitch = {
    title: 'Arcade Night',
    genre: 'Thriller',
    logline: 'Mara searches a flooded arcade for the blue key.'
};

const characters = [
    { name: 'Mara', role: 'Lead', brief_summary: 'Carries the blue key.' },
    { name: 'June', role: 'Ally', brief_summary: 'Formerly Jules in source canon.' }
];

const beats = Array.from({ length: 8 }, (_, index) => ({
    sequence_number: index + 1,
    sequence_title: `Sequence ${index + 1}`,
    beats: [{ beat: 'source beat', description: 'Mara keeps the blue key in the flooded arcade.' }]
}));

const outlineWithSeparatedMidpointAndSpectacle = {
    act_1: [{
        sequence_number_and_title: 'Sequence A: The Mystery Begins',
        beats: [{ beat_label: 'Opening', description: 'Slatern begins investigating the strange resonance around Fairview.' }]
    }, {
        sequence_number_and_title: 'Sequence B: The Predicament',
        beats: [{ beat_label: 'Catalyst', description: 'Snowgoose warns that Code Wendy is dangerous but not yet active.' }]
    }],
    act_2: [{
        sequence_number_and_title: 'Sequence C: Into Fairview',
        beats: [{ beat_label: 'First Attempt', description: 'Slatern and Rebecca follow the Dapple trail into the suburbs.' }]
    }, {
        sequence_number_and_title: 'Sequence D: First Culmination / Midpoint',
        beats: [{ beat_label: 'Midpoint Reveal', description: 'At the Fairview dinner table, Slatern realizes Scott is Dapple.' }]
    }, {
        sequence_number_and_title: 'Sequence E: Warehouse Congress',
        beats: [{ beat_label: 'Bad Guys Close In', description: 'The heroes race toward the warehouse congress before the merger scales up.' }]
    }, {
        sequence_number_and_title: 'Sequence F: Code Wendy',
        beats: [{ beat_label: 'All Is Lost', description: 'Code Wendy triggers the Kaiju transformation as the explosive bridge into Act 3.' }]
    }],
    act_3: [{
        sequence_number_and_title: 'Sequence G: Inside the Kaiju',
        beats: [{ beat_label: 'Dark Night', description: 'Slatern enters the Kaiju belly and finds Robotobob.' }]
    }, {
        sequence_number_and_title: 'Sequence H: Resolution',
        beats: [{ beat_label: 'Finale', description: 'Rebecca and Snowgoose help the city break adult blindness.' }]
    }]
};

function stage4ResponseFixture() {
    return {
        stc_genre_category: 'Whydunit',
        hybrid_beat_sheet: Array.from({ length: 8 }, (_, index) => ({
            sequence_number: index + 1,
            sequence_title: `Sequence ${index + 1}`,
            beats: [{
                beat_name: index === 3 ? 'Midpoint' : `Beat ${index + 1}`,
                genre_variation_notes: 'Genre notes.',
                emotional_arc: 'Emotional arc.',
                pacing_notes: 'Pacing notes.',
                detailed_action: 'Mara protects the blue key in the approved sequence.'
            }]
        }))
    };
}

function treatmentFixture() {
    const blocks = beats.map(({ sequence_number }) => (
        `[SEQUENCE ${sequence_number} START]
SEQUENCE ${sequence_number}: Arcade Thread ${sequence_number}
Mara protects the blue key near the flooded arcade.
[SEQUENCE ${sequence_number} END]`
    ));

    return {
        title_logline_characters: 'Title and characters.',
        act_1: blocks.slice(0, 2).join('\n\n'),
        act_2a: blocks.slice(2, 4).join('\n\n'),
        act_2b: blocks.slice(4, 6).join('\n\n'),
        act_3: blocks.slice(6, 8).join('\n\n')
    };
}

function collectText(contents) {
    const items = Array.isArray(contents) ? contents : [contents];
    return items.map(item => {
        if (typeof item === 'string') return item;
        if (item?.parts) return item.parts.map(part => part.text || '').join('\n');
        return JSON.stringify(item);
    }).join('\n');
}

function assertSourceAwareCall(call, stageName) {
    const promptText = collectText(call.contents);
    assert.match(promptText, /PROJECT MEMORY AND SOURCE PACKET/);
    assert.match(promptText, /Mara keeps the blue key/);
    assert.match(promptText, /Graphic Novel\.pdf/);
    assert.match(call.config?.systemInstruction || '', /MEMORY AND SOURCE CONTRACT/);
    assert.match(call.config?.systemInstruction || '', new RegExp(stageName));
}

function makeRecorder(responder) {
    const calls = [];
    const generateContentFn = async request => {
        calls.push(request);
        return responder(request, calls.length);
    };
    return { calls, generateContentFn };
}

test('Stage 2 outline sanitizer removes leaked tone guidance beats', () => {
    const outline = {
        outline: {
            act_1: [],
            act_2: [],
            act_3: [{
                sequence_number_and_title: 'Sequence H: Resolution',
                beats: [{
                    beat_label: 'Closing Image',
                    description: 'Mara returns the blue key to the silent arcade.'
                }, {
                    beat_label: 'Tone',
                    description: 'Ensure the "Saul Goodman" and "Dirty Rotten Scoundrels" likeability is present. Remove any remaining "AI-style" jargon.'
                }]
            }]
        }
    };

    sanitizeOutlineMetaBeats(outline);

    assert.deepEqual(outline.outline.act_3[0].beats, [{
        beat_label: 'Closing Image',
        description: 'Mara returns the blue key to the silent arcade.'
    }]);
});

test('Stage 2 outline agent output filters leaked tone guidance beats before returning', async () => {
    const outlineResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            act_1: [],
            act_2: [],
            act_3: [{
                sequence_number_and_title: 'Sequence H: Resolution',
                beats: [{
                    beat_label: 'Closing Image',
                    description: 'Mara returns the blue key to the silent arcade.'
                }, {
                    beat_label: 'Tone',
                    description: 'Ensure the likeability is present. Remove any remaining AI-style jargon.'
                }]
            }]
        }
    };
    const { generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(outlineResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, null, null, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.deepEqual(result.outline.act_3[0].beats, [{
        beat_label: 'Closing Image',
        description: 'Mara returns the blue key to the silent arcade.'
    }]);
});

test('Stage 2 outline notes with an empty scraped outline generate a fresh outline', async () => {
    const emptyScrapedOutline = { act_1: [], act_2: [], act_3: [] };
    const outlineResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
            act_2: [],
            act_3: []
        }
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(outlineResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    assert.equal(outlineHasContent(emptyScrapedOutline), false);

    await agent2Outline(pitch, emptyScrapedOutline, 'Make the midpoint more dramatic.', null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 1);
    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /User Notes: Make the midpoint more dramatic/);
    assert.doesNotMatch(promptText, /EXISTING OUTLINE/);
    assert.doesNotMatch(calls[0].config.systemInstruction, /Apply the user's note to the existing 8-sequence outline/);
});

test('Stage 2 outline notes with real outline content use surgical revision mode', async () => {
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
        act_2: [],
        act_3: []
    };
    const outlineResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: currentOutline
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(outlineResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    assert.equal(outlineHasContent(currentOutline), true);

    await agent2Outline(pitch, currentOutline, 'Make the midpoint more dramatic.', null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 1);
    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /EXISTING OUTLINE/);
    assert.match(calls[0].config.systemInstruction, /Apply the user's note to the existing 8-sequence outline/);
});

test('Stage 2 outline checklist repairs missing concrete restore beats', async () => {
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
        act_2: [],
        act_3: [{ sequence_number_and_title: 'Sequence H', beats: [{ beat_label: 'Final Image', description: 'The house is quiet.' }] }]
    };
    const firstResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            ...currentOutline,
            act_3: [{
                sequence_number_and_title: 'Sequence H',
                beats: [
                    { beat_label: 'Dapple Surrenders', description: 'Dapple shrinks, sees Scott, chooses kindness, and lets himself be cuffed.' },
                    { beat_label: 'Morning After', description: 'Rebecca sets breakfast for three while Furdlegurr is visible to both survivors.' },
                    { beat_label: 'Containment Visits', description: 'Visitor passes for Dapple and Scott are approved elsewhere in the aftermath.' },
                    { beat_label: 'Old Photo', description: 'A photo of young Becky catches light in the hallway, away from the kitchen.' }
                ]
            }]
        }
    };
    const repairedResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            ...currentOutline,
            act_3: [{
                sequence_number_and_title: 'Sequence H',
                beats: [
                    { beat_label: 'Dapple Surrenders', description: 'Dapple shrinks, sees Scott, chooses kindness, and lets himself be cuffed.' },
                    { beat_label: 'Kitchen Closing Image', description: 'In the kitchen, a photo of young Becky and Dapple sits framed in the light. Breakfast is set for three, Furdlegurr is visible to both, and visitor passes for Dapple and Scott wait beside the plates.' }
                ]
            }]
        }
    };
    const { calls, generateContentFn } = makeRecorder((_request, callIndex) => ({
        text: JSON.stringify(callIndex === 1 ? firstResponse : repairedResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, `Stuff To Restore

Dapple's voluntary surrender
Dapple shrinks, could run, sees Scott, chooses kindness, lets himself be cuffed.

Kitchen closing image
Photo of young Becky and Dapple framed in the light. Breakfast for three. Furdlegurr visible to both. Visitor passes for Dapple and Scott.`, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 2);
    assert.match(collectText(calls[0].contents), /REVISION CHECKLIST/);
    assert.match(collectText(calls[1].contents), /MANDATORY CHECKLIST REPAIR/);
    assert.match(collectText(calls[1].contents), /Kitchen closing image/);
    assert.match(JSON.stringify(result.outline), /visitor passes for Dapple and Scott/);
});

test('Stage 2 outline checklist scopes repair to latest concrete request', async () => {
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
        act_2: [],
        act_3: [{ sequence_number_and_title: 'Sequence H', beats: [{ beat_label: 'Final Image', description: 'The house is quiet.' }] }]
    };
    const firstResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            ...currentOutline,
            act_3: [{
                sequence_number_and_title: 'Sequence H',
                beats: [
                    { beat_label: 'Dapple Surrenders', description: 'Dapple shrinks, sees Scott, chooses kindness, and lets himself be cuffed.' },
                    { beat_label: 'Morning After', description: 'Rebecca sets breakfast for three.' }
                ]
            }]
        }
    };
    const repairedResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            ...currentOutline,
            act_3: [{
                sequence_number_and_title: 'Sequence H',
                beats: [
                    { beat_label: 'Dapple Surrenders', description: 'Dapple shrinks, sees Scott, chooses kindness, and lets himself be cuffed.' },
                    { beat_label: 'Kitchen Closing Image', description: 'A photo of young Becky and Dapple is framed in the kitchen light. Breakfast for three waits on the table, Furdlegurr is visible to both, and visitor passes for Dapple and Scott sit beside the plates.' }
                ]
            }]
        }
    };
    const revisionBrief = `Kitchen closing image
Photo of young Becky and Dapple framed in the light. Breakfast for three. Furdlegurr visible to both. Visitor passes for Dapple and Scott. That image should stay.`;
    const { calls, generateContentFn } = makeRecorder((_request, callIndex) => ({
        text: JSON.stringify(callIndex === 1 ? firstResponse : repairedResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, revisionBrief, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 2);
    const firstPrompt = collectText(calls[0].contents);
    const repairPrompt = collectText(calls[1].contents);
    assert.match(firstPrompt, /ACTIVE REVISION REQUEST/);
    assert.doesNotMatch(firstPrompt, /BACKGROUND CONVERSATION NOTES/);
    const missingSection = repairPrompt.match(/MISSING OR UNDERREPRESENTED CHECKLIST ITEMS:\n([\s\S]*?)\n\nORIGINAL USER NOTE:/)?.[1] || '';
    assert.match(missingSection, /Kitchen closing image/);
    assert.doesNotMatch(missingSection, /voluntary surrender/i);
    assert.match(JSON.stringify(result.outline), /visitor passes for Dapple and Scott/);
});

test('Stage 2 outline deterministically appends checklist beat after failed repair', async () => {
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
        act_2: [],
        act_3: [{ sequence_number_and_title: 'Sequence H', beats: [{ beat_label: 'Final Image', description: 'The house is quiet.' }] }]
    };
    const missingKitchenResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            ...currentOutline,
            act_3: [{
                sequence_number_and_title: 'Sequence H',
                beats: [
                    { beat_label: 'Aftermath', description: 'Dapple and Scott receive visitor approvals, while Rebecca makes breakfast elsewhere.' }
                ]
            }]
        }
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(missingKitchenResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, `Kitchen closing image
Photo of young Becky and Dapple framed in the light. Breakfast for three. Furdlegurr visible to both. Visitor passes for Dapple and Scott. That image is doing a lot of emotional work and should absolutely stay. --> this is still missing; please restore.
`, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 2);
    const finalSequence = result.outline.act_3[0];
    assert.equal(finalSequence.sequence_number_and_title, 'Sequence H');
    assert.match(JSON.stringify(finalSequence.beats), /Kitchen Closing Image/);
    assert.match(JSON.stringify(finalSequence.beats), /photo of young Becky and Dapple framed in the light/i);
    assert.match(JSON.stringify(finalSequence.beats), /visitor passes for Dapple and Scott/i);
});

test('Stage 2 outline tool revision brief verifies the concrete restore request', async () => {
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
        act_2: [],
        act_3: [{ sequence_number_and_title: 'Sequence H', beats: [{ beat_label: 'Final Image', description: 'The house is quiet.' }] }]
    };
    const missingKitchenResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            ...currentOutline,
            act_3: [{
                sequence_number_and_title: 'Sequence H',
                beats: [
                    { beat_label: 'Aftermath', description: 'Rebecca sets the table after the crisis, but the protected kitchen photo and visitor passes are absent.' }
                ]
            }]
        }
    };
    const revisionBrief = `Kitchen closing image
Photo of young Becky and Dapple framed in the light. Breakfast for three. Furdlegurr visible to both. Visitor passes for Dapple and Scott. That image is doing a lot of emotional work and should absolutely stay. --> this is still missing; please restore.
`;

    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(missingKitchenResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, revisionBrief, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 2);
    const firstPrompt = collectText(calls[0].contents);
    assert.match(firstPrompt, /ACTIVE REVISION REQUEST:\nKitchen closing image/);
    assert.match(firstPrompt, /REVISION CHECKLIST/);
    assert.match(firstPrompt, /visitor passes for Dapple and Scott/i);
    const finalSequence = result.outline.act_3[0];
    assert.match(JSON.stringify(finalSequence.beats), /Kitchen Closing Image/);
    assert.match(JSON.stringify(finalSequence.beats), /photo of young Becky and Dapple framed in the light/i);
    assert.match(JSON.stringify(finalSequence.beats), /visitor passes for Dapple and Scott/i);
});

test('Stage 2 outline extracts bracketed one-line restore beats as checklist items', async () => {
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
        act_2: [],
        act_3: [{ sequence_number_and_title: 'Sequence H', beats: [{ beat_label: 'Final Image', description: 'The house is quiet.' }] }]
    };
    const missingRestoreResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: currentOutline
    };
    const notes = `We've lost the following two beats in Seq H, please restore:

[Aftermath - A New Order] Quist surveys the wreckage. The public optics have broken her old order. Rebecca declines the badge, but agrees to consult on Dapple's containment. Dave and Robotobob walk off with Blounder. Terry takes custody of Moog and Big Doll. Scott gets real help. Molly briefly sees pink and smiles.

[Closing Image - The Photo on the Wall] Rebecca's kitchen. The photo of young Becky and Dapple is framed on the wall in the light. Elliot sets breakfast for three: him, Mom, and Furdlegurr, visible to both. On the fridge are visitor passes for Dapple and Scott.`;
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(missingRestoreResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, notes, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 1);
    const firstPrompt = collectText(calls[0].contents);
    assert.match(firstPrompt, /REVISION CHECKLIST/);
    assert.match(firstPrompt, /Aftermath - A New Order/);
    assert.match(firstPrompt, /Closing Image - The Photo on the Wall/);
    const finalText = JSON.stringify(result.outline.act_3[0].beats);
    assert.match(finalText, /Aftermath - A New Order/);
    assert.match(finalText, /Rebecca declines the badge/i);
    assert.match(finalText, /Closing Image - The Photo on the Wall/);
    assert.match(finalText, /visitor passes for Dapple and Scott/i);
});

test('Stage 2 outline deterministically replaces Sequence H with explicit bracketed beats', async () => {
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
        act_2: [],
        act_3: [{
            sequence_number_and_title: 'Sequence H: Old Ending',
            beats: [
                { beat_label: 'Old Climax', description: 'The old climax remains in place.' },
                { beat_label: 'Old Coda', description: 'The old coda remains in place.' }
            ]
        }]
    };
    const unchangedResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: currentOutline
    };
    const notes = `Replace sequence H with these beats:

Sequence H: A World That Remembers

[Climax - The Apology and the Key] Rebecca remembers Dapple, uses the Bonded Authorization Key, and aborts Protocol Erasure. Scott is freed nearby.

[Dapple's Last Choice] Dapple shrinks back to a small fox figment, chooses kindness toward Scott, and lets the containment team cuff him.

[Aftermath - A New Order] Quist's old order is broken. Rebecca declines the badge but agrees to consult on Dapple containment. Dave, Robotobob, Blounder, Terry, Moog, Big Doll, Scott, and Molly each get their humane aftermath.

[Closing Image - The Photo on the Wall] Rebecca's kitchen holds the framed photo of young Becky and Dapple. Elliot sets breakfast for three with Furdlegurr visible to both, and visitor passes for Dapple and Scott sit on the fridge.`;
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(unchangedResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, notes, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 1);
    assert.equal(result.outline.act_3[0].sequence_number_and_title, 'Sequence H: A World That Remembers');
    assert.deepEqual(result.outline.act_3[0].beats.map(beat => beat.beat_label), [
        'Climax - The Apology and the Key',
        "Dapple's Last Choice",
        'Aftermath - A New Order',
        'Closing Image - The Photo on the Wall'
    ]);
    assert.doesNotMatch(JSON.stringify(result.outline.act_3[0].beats), /Old Climax/);
    assert.match(JSON.stringify(result.outline.act_3[0].beats), /Bonded Authorization Key/);
    assert.match(JSON.stringify(result.outline.act_3[0].beats), /visitor passes for Dapple and Scott/i);
});

test('Stage 2 outline recognition pass preserves existing ending beats from a tool revision brief', async () => {
    const recognitionNote = `The main thing I would still address:

Rebecca Should Know At The Midpoint
Right now [Midpoint - The Name Drop] still says Rebecca "doesn't consciously recognize him." I'd change that. When Dapple says "Hello, Becky," Rebecca should know.

Not the whole memory. Not the bonded phrase. But she should understand: Dapple was mine.

Then Act III becomes cleaner:

Midpoint reveal: "Oh God. He was my imaginary friend."
Diner: "How long have you known he was mine?"
Act III [Rebecca's Realization - The Quiet Kingdom] becomes [Rebecca's Memory - The Quiet Kingdom] or [The Bonded Phrase].
The climax is not "who is Dapple?" It is "can Rebecca own the bond and reach him?"

One source-faithfulness note: the latest calls the Quiet Kingdom memory "source-true," but the source-derived breakdown we've been using points to the storm drain. If Quiet Kingdom is your preferred movie invention, great, but don't label it source-true. If you want maximum source fidelity, use the storm drain.

Two small polish notes:

Dapple's ending line "I'm not letting them warehouse you again" is emotionally right, but maybe add accountability: "But you answer for what you did."
Act I is doing a lot now: Blounder, Moog, Rebecca/Elliot, Pono, Furdlegurr capture, Quist, Scott. It works as an outline, but in pages it will need ruthless pacing.`;
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A: Setup', beats: [{ beat_label: 'Opening', description: 'Blounder ages out.' }] }],
        act_2: [{
            sequence_number_and_title: "Sequence D: The Manifesto and the Mother's Name",
            beats: [{
                beat_label: 'Midpoint - The Name Drop',
                description: "Rebecca, hidden in the rafters, locks eyes with Dapple across the room. He stops mid-speech. Smiles, all teeth. 'Hello, Becky.' Rebecca freezes. She doesn't consciously recognize him -- but her hands shake. He recognizes her completely. REVELATION FOR THE AUDIENCE (Dramatic Irony): Dapple is her abandoned childhood figment, and she is Patient Zero of his revolution. Rebecca doesn't fully know yet -- but Dave does, and he's been hiding it."
            }]
        }, {
            sequence_number_and_title: 'Sequence E: The Wound Beneath the Suit',
            beats: [{
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: "In a diner at 3 AM, Rebecca holds Elliot. Rebecca confronts Dave: 'Why did Dapple know my name?' Dave deflects."
            }]
        }, {
            sequence_number_and_title: 'Sequence F: The Fox Beneath the Coat',
            beats: [{
                beat_label: 'False Rescue - The Body in Her Arms',
                description: "Rebecca has rescued Elliot's friend. The real dramatic question -- can Rebecca remember what she abandoned -- remains untouched. She has rescued Elliot's friend. She has not yet faced her own."
            }]
        }],
        act_3: [{
            sequence_number_and_title: 'Sequence G: The Forgotten Friend',
            beats: [{
                beat_label: "Rebecca's Realization - The Quiet Kingdom",
                description: "Outside, Rebecca stares up at Dapple's giant fox face. She gasps. Dapple is hers. One specific memory surfaces, sharper than the others, source-true and private -- a private game only the two of them played in the crawlspace under her porch. They called it the QUIET KINGDOM. There was a battered tin can buried in the dirt beneath the steps where they hid their treasures and a single secret PASSWORD -- a nonsense word, PILLERMOSS -- that Becky promised, on her honor as Queen, she would never forget. The day she stopped seeing him she promised it to him last. Only the two of them ever knew."
            }]
        }, {
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: [{
                beat_label: 'Climax - The Apology and the Key',
                description: "Rebecca steps into the street beneath the cracking fox-god. She doesn't fight Dapple. She SEES him. 'Dapple. Pillermoss. The Quiet Kingdom. I remember the can. I remember the password. I remember you.' She apologizes and aborts Protocol Erasure."
            }, {
                beat_label: "Dapple's Last Choice",
                description: "Dapple shrinks back into the small fox figment. He looks at Rebecca and rasps, 'You came back.' She nods. 'And I'm not letting them warehouse you again.'"
            }, {
                beat_label: 'Aftermath - A New Order',
                description: "Quist's old order breaks. Rebecca agrees to consult on Dapple's containment. Scott gets help. Molly briefly sees pink and smiles."
            }, {
                beat_label: 'Closing Image - The Photo on the Wall',
                description: 'Rebecca frames the photo of young Becky and Dapple in the kitchen light. Elliot sets breakfast for three, Furdlegurr is visible to both, and visitor passes for Dapple and Scott sit on the fridge.'
            }]
        }]
    };
    const regressedOutline = {
        ...currentOutline,
        act_3: [
            currentOutline.act_3[0],
            {
                sequence_number_and_title: 'Sequence H: A World That Remembers',
                beats: [currentOutline.act_3[1].beats[0]]
            }
        ]
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify({
            title: 'I.M.A.G.I.N.E.',
            genre: 'Animated Family Adventure',
            logline: 'A mother must remember her abandoned imaginary friend.',
            outline: regressedOutline
        }),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, recognitionNote, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 1);
    assert.match(collectText(calls[0].contents), /REVISION CHECKLIST/);
    assert.match(collectText(calls[0].contents), /Dapple's ending line/);
    const resultText = JSON.stringify(result.outline);
    assert.doesNotMatch(resultText, /doesn't consciously recognize him/i);
    assert.match(resultText, /Dapple was mine/i);
    assert.match(resultText, /How long have you known he was mine\?/i);
    assert.match(resultText, /Rebecca's Memory - The Storm Drain/i);
    assert.match(resultText, /storm drain/i);
    assert.doesNotMatch(resultText, /source-true/i);
    assert.doesNotMatch(resultText, /Quiet Kingdom/i);
    assert.match(resultText, /own the bond she abandoned/i);
    assert.match(resultText, /answer for what you did/i);
    assert.match(resultText, /Dapple's Last Choice/);
    assert.match(resultText, /Aftermath - A New Order/);
    assert.match(resultText, /Closing Image - The Photo on the Wall/);
    assert.match(resultText, /visitor passes for Dapple and Scott/i);
});

test('Stage 2 outline midpoint-only revisions cannot alter Sequence H ending beats', async () => {
    const currentSequenceH = {
        sequence_number_and_title: 'Sequence H: A World That Remembers',
        beats: [{
            beat_label: 'Climax - The Apology and the Key',
            description: 'Rebecca uses the Bonded Authorization Key and aborts Protocol Erasure.'
        }, {
            beat_label: "Dapple's Last Choice",
            description: "Dapple shrinks, chooses kindness toward Scott, and lets the containment team cuff him."
        }, {
            beat_label: 'Aftermath - A New Order',
            description: "Rebecca consults on Dapple's containment while Scott, Dave, Robotobob, Blounder, Terry, Moog, Big Doll, and Molly each get humane aftermath beats."
        }, {
            beat_label: 'Closing Image - The Photo on the Wall',
            description: 'The photo of young Becky and Dapple is framed in the kitchen light. Breakfast is set for three, Furdlegurr is visible to both, and visitor passes for Dapple and Scott sit on the fridge.'
        }]
    };
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A: Setup', beats: [{ beat_label: 'Opening', description: 'Blounder ages out.' }] }],
        act_2: [{
            sequence_number_and_title: "Sequence D: The Manifesto and the Mother's Name",
            beats: [{
                beat_label: 'Midpoint - The Name Drop',
                description: "Dapple says, 'Hello, Becky.' Rebecca freezes. She doesn't consciously recognize him -- but her hands shake."
            }]
        }],
        act_3: [currentSequenceH]
    };
    const damagedModelOutline = {
        ...currentOutline,
        act_2: [{
            sequence_number_and_title: "Sequence D: The Manifesto and the Mother's Name",
            beats: [{
                beat_label: 'Midpoint - The Name Drop',
                description: "Dapple says, 'Hello, Becky.' Rebecca freezes. She knows enough: this was her friend. Dapple is hers. Dave sees it land and looks away."
            }]
        }],
        act_3: [{
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: [{
                beat_label: 'Climax - The Apology and the Key',
                description: 'Rebecca remembers Dapple and the story ends quickly.'
            }]
        }]
    };
    const { generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify({
            title: 'I.M.A.G.I.N.E.',
            genre: 'Animated Family Adventure',
            logline: 'A mother must remember her abandoned imaginary friend.',
            outline: damagedModelOutline
        }),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, `Only revise [Midpoint - The Name Drop]. When Dapple says "Hello, Becky," Rebecca should know enough: this was her friend. Dapple is hers. Dave sees it land and looks away. Do not change any ending beats.`, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.match(JSON.stringify(result.outline.act_2), /Dapple is hers/i);
    assert.deepEqual(result.outline.act_3[0], currentSequenceH);
});

test('Stage 2 outline structural replace and delete notes apply against the saved outline', async () => {
    const currentSequenceH = {
        sequence_number_and_title: 'Sequence H: A World That Remembers',
        beats: [{
            beat_label: 'Climax - The Bonded Phrase',
            description: 'Rebecca uses the bonded phrase to reach Dapple.'
        }, {
            beat_label: "Dapple's Last Choice",
            description: 'Dapple lets the containment team cuff him.'
        }, {
            beat_label: 'Aftermath - A New Order',
            description: 'Rebecca consults on Dapple containment while the visible city rebuilds.'
        }, {
            beat_label: 'Closing Image - The Photo on the Wall',
            description: 'The photo of young Becky and Dapple is framed in the kitchen light.'
        }, {
            beat_label: "The Rebecca's Memory - The Storm Drain",
            description: 'This paragraph works but repeats itself.'
        }]
    };
    const currentOutline = {
        act_1: [{ sequence_number_and_title: 'Sequence A: Setup', beats: [{ beat_label: 'Opening', description: 'Blounder ages out.' }] }],
        act_2: [{
            sequence_number_and_title: 'Sequence E: The Breach Starts Counting Down',
            beats: [{
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Rebecca and Dave face the diner fallout.'
            }, {
                beat_label: "Quist's Betrayal & The Bonded Key",
                description: 'Quist betrays the old agency order and gives Rebecca the key.'
            }, {
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Duplicate placeholder after the Quist betrayal.'
            }]
        }],
        act_3: [currentSequenceH]
    };
    const damagedModelOutline = {
        ...currentOutline,
        act_3: [{
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: currentSequenceH.beats.concat([{
                beat_label: 'Resolution - A New Accord',
                description: 'A contradictory second ending where Dapple is held, not cuffed.'
            }])
        }]
    };
    const notes = `1. Dapple Rising - The Anchor is still missing.
You still have two copies of [Aftermath - A Quiet Reckoning]. Delete the second [Aftermath - A Quiet Reckoning], after [Quist's Betrayal & The Bonded Key], and replace it with the Dapple Rising beat.

[Dapple Rising - The Anchor] Through the diner window: a yellow-gold pillar of light erupts over downtown Seattle. Dapple has hijacked the Mobile Processing Core, chained Furdlegurr to it, and is using the bear's pure, recently-betrayed bond with Elliot as the perfect anchor to drag the Breach into reality. Every retired figment in Seattle is being pulled toward him. Protocol Erasure is counting down. Rebecca: 'We go now. No more agency.' Elliot, fierce: 'I'm coming. He came for me even after I told him not to.'

2. There's an accidental note left as a final beat.
The last paragraph is [The Rebecca's Memory - The Storm Drain] and says the paragraph works but repeats itself. Delete that entirely.`;
    const { generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify({
            title: 'I.M.A.G.I.N.E.',
            genre: 'Animated Family Adventure',
            logline: 'A mother must remember her abandoned imaginary friend.',
            outline: damagedModelOutline
        }),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, notes, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    const sequenceEBeats = result.outline.act_2[0].beats;
    const sequenceHBeats = result.outline.act_3[0].beats;
    assert.deepEqual(sequenceEBeats.map(beat => beat.beat_label), [
        'Aftermath - A Quiet Reckoning',
        "Quist's Betrayal & The Bonded Key",
        'Dapple Rising - The Anchor'
    ]);
    assert.equal(sequenceEBeats[2].beat_label, 'Dapple Rising - The Anchor');
    assert.match(sequenceEBeats[2].description, /Mobile Processing Core/);
    assert.doesNotMatch(JSON.stringify(sequenceHBeats), /The Rebecca's Memory - The Storm Drain/);
    assert.doesNotMatch(JSON.stringify(sequenceHBeats), /Resolution - A New Accord/);
    assert.equal(sequenceHBeats.at(-1).beat_label, 'Closing Image - The Photo on the Wall');
});

test('Stage 2 outline structural parser does not delete merge or keep-nearby labels', () => {
    const notes = `Delete the second [Aftermath - A Quiet Reckoning] after [Quist's Betrayal & The Bonded Key] and replace it with the exact [Dapple Rising - The Anchor] beat.

[Dapple Rising - The Anchor] Through the diner window: a yellow-gold pillar of light erupts over downtown Seattle.

Also delete [Resolution - A New Accord] entirely or merge only its best ideas into [Aftermath - A New Order]. The final beat should remain [Closing Image - The Photo on the Wall].`;

    const operations = parseStructuralPatchOps(notes);
    assert.deepEqual(operations.map(op => [op.type, op.oldLabel || op.newLabel]), [
        ['replace', 'Aftermath - A Quiet Reckoning'],
        ['delete', 'Aftermath - A Quiet Reckoning'],
        ['delete', 'Resolution - A New Accord']
    ]);
    assert.equal(operations[0].newLabel, 'Dapple Rising - The Anchor');
    assert.equal(operations[0].newBody, 'Through the diner window: a yellow-gold pillar of light erupts over downtown Seattle.');
    assert.equal(operations[0].anchorLabel, "Quist's Betrayal & The Bonded Key");
    assert.equal(operations[1].anchorLabel, "Quist's Betrayal & The Bonded Key");
    assert.doesNotMatch(JSON.stringify(operations), /Aftermath - A New Order/);
    assert.doesNotMatch(JSON.stringify(operations), /Closing Image - The Photo on the Wall/);
});

test('Stage 2 outline parser handles unbracketed anchors without swallowing later preserve notes', () => {
    const notes = `Please stop working from version 15. Revert to version 13 as the base.

From version 13, make ONLY these changes:
Keep Quist's Betrayal & The Bonded Key exactly where it is. Do not delete it.
Delete the second duplicate [Aftermath - A Quiet Reckoning] that comes after Quist's Betrayal & The Bonded Key.
Replace that deleted duplicate with [Dapple Rising - The Anchor].
Delete the accidental final note beat: [The Rebecca's Memory - The Storm Drain].
Preserve [Aftermath - A New Order] and [Closing Image - The Photo on the Wall] as the final ending beats.
Do not add Resolution - A New Accord.`;

    const operations = parseStructuralPatchOps(notes);

    assert.equal(operations[0].type, 'replace');
    assert.equal(operations[0].oldLabel, 'Aftermath - A Quiet Reckoning');
    assert.equal(operations[0].newLabel, 'Dapple Rising - The Anchor');
    assert.equal(operations[0].anchorLabel, "Quist's Betrayal & The Bonded Key");
    assert.equal(operations[0].newBody, '');
    assert.doesNotMatch(JSON.stringify(operations), /Aftermath - A New Order/);
    assert.doesNotMatch(JSON.stringify(operations), /Closing Image - The Photo on the Wall/);
});

test('Stage 2 outline finalizer restores requested protected ending beats from damaged output', () => {
    const beforeOutline = {
        act_1: [],
        act_2: [{
            sequence_number_and_title: 'Sequence E: The Breach Starts Counting Down',
            beats: [{
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Rebecca and Dave face the diner fallout.'
            }, {
                beat_label: "Quist's Betrayal & The Bonded Key",
                description: 'Quist gives Rebecca the key.'
            }, {
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Duplicate placeholder after Quist.'
            }]
        }],
        act_3: [{
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: [{
                beat_label: "Dapple's Last Choice",
                description: 'Dapple surrenders but must answer for what he did.'
            }]
        }]
    };
    const afterOutline = JSON.parse(JSON.stringify(beforeOutline));
    const notes = `Please stop working from version 15. Revert to version 13 as the base.

From version 13, make ONLY these changes:
Keep Quist's Betrayal & The Bonded Key exactly where it is. Do not delete it.
Delete the second duplicate [Aftermath - A Quiet Reckoning] that comes after Quist's Betrayal & The Bonded Key.
Replace that deleted duplicate with [Dapple Rising - The Anchor].
Preserve [Aftermath - A New Order] and [Closing Image - The Photo on the Wall] as the final ending beats.
Do not add Resolution - A New Accord.`;

    const structuralPatch = applyStructuralOutlinePatches(afterOutline, notes);
    const receipt = createRevisionTransaction({
        stageId: 'stage2_outline',
        before: beforeOutline,
        after: afterOutline,
        notes,
        structuralPatch,
        adapter: outlineRevisionAdapter
    }).receipt;

    assert.deepEqual(afterOutline.act_2[0].beats.map(beat => beat.beat_label), [
        'Aftermath - A Quiet Reckoning',
        "Quist's Betrayal & The Bonded Key",
        'Dapple Rising - The Anchor'
    ]);
    assert.deepEqual(afterOutline.act_3[0].beats.slice(-2).map(beat => beat.beat_label), [
        'Aftermath - A New Order',
        'Closing Image - The Photo on the Wall'
    ]);
    assert.equal(afterOutline.act_3[0].beats.at(-1).beat_label, 'Closing Image - The Photo on the Wall');
    assert.equal(receipt.verified, true);
    assert.equal(receipt.failures.length, 0);
});

test('Stage 2 outline finalizer verifies protected endings preserved from original outline', () => {
    const beforeOutline = {
        act_1: [],
        act_2: [],
        act_3: [{
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: [{
                beat_label: "Dapple's Last Choice",
                description: 'Dapple surrenders but must answer for what he did.'
            }, {
                beat_label: 'Aftermath - A New Order',
                description: 'The previous saved ending aftermath.'
            }, {
                beat_label: 'Closing Image - The Photo on the Wall',
                description: 'The previous saved kitchen closing image.'
            }]
        }]
    };
    const afterOutline = {
        act_1: [],
        act_2: [],
        act_3: [{
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: [{
                beat_label: "Dapple's Last Choice",
                description: 'Dapple surrenders but must answer for what he did.'
            }]
        }]
    };
    const notes = `We've lost the following two beats in Seq H, please restore:

[Aftermath - A New Order] Quist surveys the wreckage. Rebecca declines the badge but agrees to consult on Dapple containment.

[Closing Image - The Photo on the Wall] Rebecca's kitchen. The photo of young Becky and Dapple is framed on the wall, and visitor passes for Dapple and Scott sit on the fridge.`;

    const structuralPatch = applyStructuralOutlinePatches(afterOutline, notes);
    const receipt = createRevisionTransaction({
        stageId: 'stage2_outline',
        before: beforeOutline,
        after: afterOutline,
        notes,
        structuralPatch,
        adapter: outlineRevisionAdapter
    }).receipt;

    assert.deepEqual(structuralPatch.operations.map(op => [op.newLabel, op.verifyMode]), [
        ['Aftermath - A New Order', 'present'],
        ['Closing Image - The Photo on the Wall', 'present']
    ]);
    assert.deepEqual(afterOutline.act_3[0].beats.slice(-2).map(beat => beat.beat_label), [
        'Aftermath - A New Order',
        'Closing Image - The Photo on the Wall'
    ]);
    assert.match(afterOutline.act_3[0].beats.at(-2).description, /Rebecca declines the badge/);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.failures.length, 0);
});

test('Stage 2 deterministic revision kernel applies structural outline repairs without model rewrite', () => {
    assert.ok(STAGE_REVISION_ADAPTERS.stage2_outline);
    const outline = {
        act_1: [],
        act_2: [{
            sequence_number_and_title: 'Sequence E: The Breach Starts Counting Down',
            beats: [{
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Rebecca and Dave face the diner fallout.'
            }, {
                beat_label: "Quist's Betrayal & The Bonded Key",
                description: 'Quist gives Rebecca the key.'
            }, {
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Duplicate placeholder after Quist.'
            }]
        }],
        act_3: [{
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: [{
                beat_label: "Dapple's Last Choice",
                description: 'Dapple surrenders but must answer for what he did.'
            }, {
                beat_label: 'Resolution - A New Accord',
                description: 'A contradictory extra ending.'
            }]
        }]
    };
    const notes = `Delete the second duplicate [Aftermath - A Quiet Reckoning] that comes after Quist's Betrayal & The Bonded Key.
Replace that deleted duplicate with [Dapple Rising - The Anchor].
Preserve [Aftermath - A New Order] and [Closing Image - The Photo on the Wall] as the final ending beats.
Do not add Resolution - A New Accord.`;

    const revision = applyStageRevisionPlan({
        stageId: 'stage2_outline',
        artifact: outline,
        notes,
        protectedBeats: DAPPLE_STAGE2_PROTECTED_BEATS
    });

    assert.equal(revision.receipt.verified, true);
    assert.equal(revision.receipt.planner, 'stage_revision_kernel');
    assert.deepEqual(revision.receipt.operations.map(op => [op.type, op.oldLabel || op.newLabel]), [
        ['replace_beat', 'Aftermath - A Quiet Reckoning'],
        ['ensure_beat_present', 'Aftermath - A New Order'],
        ['ensure_beat_present', 'Closing Image - The Photo on the Wall'],
        ['delete_beat', 'Resolution - A New Accord']
    ]);
    assert.deepEqual(revision.after.act_2[0].beats.map(beat => beat.beat_label), [
        'Aftermath - A Quiet Reckoning',
        "Quist's Betrayal & The Bonded Key",
        'Dapple Rising - The Anchor'
    ]);
    assert.deepEqual(revision.after.act_3[0].beats.map(beat => beat.beat_label), [
        "Dapple's Last Choice",
        'Aftermath - A New Order',
        'Closing Image - The Photo on the Wall'
    ]);
    assert.match(revision.after.act_2[0].beats[2].description, /Mobile Processing Core/);
});

test('Stage 2 deterministic revision kernel honors surgical guardrails in exact outline feedback', () => {
    const outline = {
        act_1: [],
        act_2: [{
            sequence_number_and_title: 'Sequence E: The Breach Starts Counting Down',
            beats: [{
                beat_label: 'B-Story Collides - Robotobob',
                description: 'Robotobob collides with the B-story.'
            }, {
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Duplicate placeholder after Robotobob.'
            }]
        }, {
            sequence_number_and_title: 'Sequence F: The Fox Beneath the Coat',
            beats: [{
                beat_label: 'Furdlegurr Moves',
                description: 'The next sequence stays in place.'
            }]
        }],
        act_3: [{
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: [{
                beat_label: "Dapple's Last Choice",
                description: 'Dapple surrenders but must answer for what he did.'
            }, {
                beat_label: 'Resolution - A New Accord',
                description: 'A contradictory extra ending.'
            }]
        }]
    };
    const notes = `Please make surgical fixes to the current outline only. Do not restructure broadly.

First: after [B-Story Collides - Robotobob], there is currently a second duplicate [Aftermath - A Quiet Reckoning]. Delete that duplicate beat and replace it with these TWO beats, in this exact order:

[Quist's Betrayal & The Bonded Key] Quist arrives and pulls Dave aside. Rebecca eavesdrops. Quist confirms Protocol Erasure and explains the bonded authorization key. Rebecca palms the key off Quist's neck.

[Dapple Rising - The Anchor] Through the diner window: a yellow-gold pillar of light erupts over downtown Seattle. Dapple has hijacked the Mobile Processing Core and chained Furdlegurr to it. Rebecca: 'We go now. No more agency.'

Then keep Sequence F: The Fox Beneath the Coat immediately after those two beats.

Second: the current outline ends too early after [Dapple's Last Choice]. After [Dapple's Last Choice], add these TWO final beats, in this exact order:

[Aftermath - A New Order] Quist surveys the wreckage, furious about the key, but the public optics have already broken her old order. Rebecca declines the badge, then says she will consult.

[Closing Image - The Photo on the Wall] Rebecca's kitchen. The dusty photo of young Becky and Dapple is now framed on the wall, in the light.

Do not add a separate [Resolution - A New Accord]. The final beat should be [Closing Image - The Photo on the Wall].

Do not delete [Quist's Betrayal & The Bonded Key]. Do not delete [Aftermath - A New Order]. Do not delete [Closing Image - The Photo on the Wall]. The only deletion needed in the middle is the duplicate second [Aftermath - A Quiet Reckoning].`;

    const revision = applyStageRevisionPlan({
        stageId: 'stage2_outline',
        artifact: outline,
        notes,
        protectedBeats: DAPPLE_STAGE2_PROTECTED_BEATS
    });

    assert.equal(revision.receipt.verified, true);
    assert.deepEqual(revision.receipt.operations.map(op => [op.type, op.oldLabel || op.newLabel, op.anchorLabel]), [
        ['replace_beat', 'Aftermath - A Quiet Reckoning', 'B-Story Collides - Robotobob'],
        ['ensure_beat_present', 'Aftermath - A New Order', "Dapple's Last Choice"],
        ['ensure_beat_present', 'Dapple Rising - The Anchor', "Quist's Betrayal & The Bonded Key"],
        ['ensure_beat_present', 'Closing Image - The Photo on the Wall', ''],
        ['delete_beat', 'Resolution - A New Accord', '']
    ]);
    assert.deepEqual(revision.after.act_2[0].beats.map(beat => beat.beat_label), [
        'B-Story Collides - Robotobob',
        "Quist's Betrayal & The Bonded Key",
        'Dapple Rising - The Anchor'
    ]);
    assert.equal(revision.after.act_2[1].sequence_number_and_title, 'Sequence F: The Fox Beneath the Coat');
    assert.deepEqual(revision.after.act_3[0].beats.map(beat => beat.beat_label), [
        "Dapple's Last Choice",
        'Aftermath - A New Order',
        'Closing Image - The Photo on the Wall'
    ]);
    assert.doesNotMatch(revision.after.act_2[0].beats[2].description, /Then keep|Second:/);
    assert.doesNotMatch(JSON.stringify(revision.after), /Resolution - A New Accord/);
});

test('Stage 2 local polish notes cannot turn guardrails into checklist beats or alter protected Sequence H', async () => {
    const currentOutline = {
        act_1: [],
        act_2: [],
        act_3: [{
            sequence_number_and_title: 'Sequence G: The Bonded Key',
            beats: [{
                beat_label: "Rebecca's Memory - The Storm Drain",
                description: 'Memory. They called it PILLERMOSS. Not a password exactly — a whole kingdom compressed into one nonsense word.'
            }]
        }, {
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: [{
                beat_label: 'Climax - The Bonded Phrase',
                description: 'Rebecca says PILLERMOSS and cancels Protocol Erasure.'
            }, {
                beat_label: "Dapple's Last Choice",
                description: 'Dapple surrenders.'
            }, {
                beat_label: 'Aftermath - A New Order',
                description: 'New order.'
            }, {
                beat_label: 'Closing Image - The Photo on the Wall',
                description: 'Kitchen.'
            }]
        }]
    };
    const notes = `One tiny local polish only. Do not restructure anything.

In [Rebecca's Memory - The Storm Drain], the PILLERMOSS clarification is working. Please keep the new language that explains PILLERMOSS as the private name for the rusted tin can / tiny childhood kingdom.

Only add back one final key-mechanics payoff sentence at the end of that same beat, so the memory connects cleanly to the Bonded Authorization Key.

Suggested sentence:

The bonded key in her hand blazes — not because she has solved a code, but because the relay has registered the remembered bond.

Do not change any other beat. Do not change Sequence H. Do not change [Climax - The Bonded Phrase]. This is only a local polish to [Rebecca's Memory - The Storm Drain].`;
    const attemptedModelOutline = JSON.parse(JSON.stringify(currentOutline));
    attemptedModelOutline.act_3[0].beats[0].description += ' The bonded key in her hand blazes — not because she has solved a code, but because the relay has registered the remembered bond.';
    attemptedModelOutline.act_3[1].beats[0].description = 'BAD CLIMAX DRIFT.';
    attemptedModelOutline.act_3[1].beats[1].description = 'BAD DAPPLE DRIFT.';
    const { generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify({
            title: 'I.M.A.G.I.N.E.',
            genre: 'Animated Family Adventure',
            logline: 'A mother must remember.',
            outline: attemptedModelOutline
        }),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, notes, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.deepEqual(buildRevisionChecklist(notes), [
        'The bonded key in her hand blazes — not because she has solved a code, but because the relay has registered the remembered bond.'
    ]);
    assert.deepEqual(result.outline.act_3.map(sequence => sequence.beats.length), [1, 4]);
    assert.match(result.outline.act_3[0].beats[0].description, /relay has registered the remembered bond/);
    assert.equal(result.outline.act_3[1].beats[0].description, 'Rebecca says PILLERMOSS and cancels Protocol Erasure.');
    assert.equal(result.outline.act_3[1].beats[1].description, 'Dapple surrenders.');
    assert.doesNotMatch(JSON.stringify(result.outline), /BAD CLIMAX DRIFT|BAD DAPPLE DRIFT|Do Not Change Any Other Beat/);
});

test('Stage 2 wording polish inside a named beat protects surrounding beats', async () => {
    const currentOutline = {
        act_1: [],
        act_2: [],
        act_3: [{
            sequence_number_and_title: 'Sequence G: The Bonded Key',
            beats: [{
                beat_label: "Rebecca's Memory - The Storm Drain",
                description: 'Outside, Rebecca remembers the storm drain. And the OBJECT comes back with him: a rusted tin can hidden behind the garage, their private treasury for pebbles and feathers. They called it PILLERMOSS.'
            }]
        }, {
            sequence_number_and_title: 'Sequence H: A World That Remembers',
            beats: [{
                beat_label: 'Climax - The Bonded Phrase',
                description: 'Rebecca says PILLERMOSS and cancels Protocol Erasure.'
            }, {
                beat_label: "Dapple's Last Choice",
                description: 'Dapple surrenders.'
            }]
        }]
    };
    const notes = `One tiny language polish in [Rebecca's Memory - The Storm Drain]:

The phrase “And the OBJECT comes back with him” feels a little like an internal outline note. Please make it feel more lyrical and in-world.

Change:

“And the OBJECT comes back with him: a rusted tin can hidden behind the garage...”

To something like:

“And then the object comes back with him: a rusted tin can hidden behind the garage...”

Optional: add one small key-causality sentence near the end of the beat so the memory connects cleanly to the Bonded Authorization Key:

“The bonded key in her hand warms, recognizing what she has finally admitted.”

Do not change the structure or any surrounding beats. This is only a wording polish inside [Rebecca's Memory - The Storm Drain].`;
    const attemptedModelOutline = JSON.parse(JSON.stringify(currentOutline));
    attemptedModelOutline.act_3[0].beats[0].description = 'Outside, Rebecca remembers the storm drain. And then the object comes back with him: a rusted tin can hidden behind the garage, their private treasury for pebbles and feathers. They called it PILLERMOSS. The bonded key in her hand warms, recognizing what she has finally admitted.';
    attemptedModelOutline.act_3[1].beats[0].description = 'BAD CLIMAX DRIFT.';
    attemptedModelOutline.act_3[1].beats[1].description = 'BAD DAPPLE DRIFT.';
    const { generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify({
            title: 'I.M.A.G.I.N.E.',
            genre: 'Animated Family Adventure',
            logline: 'A mother must remember.',
            outline: attemptedModelOutline
        }),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, notes, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.deepEqual(buildRevisionChecklist(notes), [
        'And then the object comes back with him: a rusted tin can hidden behind the garage...'
    ]);
    assert.match(result.outline.act_3[0].beats[0].description, /And then the object comes back with him/);
    assert.match(result.outline.act_3[0].beats[0].description, /bonded key in her hand warms/);
    assert.doesNotMatch(result.outline.act_3[0].beats[0].description, /OBJECT/);
    assert.equal(result.outline.act_3[1].beats[0].description, 'Rebecca says PILLERMOSS and cancels Protocol Erasure.');
    assert.equal(result.outline.act_3[1].beats[1].description, 'Dapple surrenders.');
    assert.doesNotMatch(JSON.stringify(result.outline), /BAD CLIMAX DRIFT|BAD DAPPLE DRIFT/);
});

test('Stage 2 deterministic revision kernel unwraps saved outline artifacts', () => {
    const artifact = {
        title: 'I.M.A.G.I.N.E.',
        genre: 'Animated Family Adventure',
        logline: 'A mother must remember.',
        outline: {
            act_1: [],
            act_2: [{
                sequence_number_and_title: 'Sequence E: The Breach Starts Counting Down',
                beats: [{
                    beat_label: 'Aftermath - A Quiet Reckoning',
                    description: 'First aftermath.'
                }, {
                    beat_label: "Quist's Betrayal & The Bonded Key",
                    description: 'Quist gives Rebecca the key.'
                }, {
                    beat_label: 'Aftermath - A Quiet Reckoning',
                    description: 'Duplicate aftermath.'
                }]
            }],
            act_3: [{
                sequence_number_and_title: 'Sequence H: A World That Remembers',
                beats: [{
                    beat_label: "Dapple's Last Choice",
                    description: 'Dapple surrenders.'
                }]
            }]
        }
    };
    const notes = `Delete the second duplicate [Aftermath - A Quiet Reckoning] that comes after Quist's Betrayal & The Bonded Key.
Replace that deleted duplicate with [Dapple Rising - The Anchor].
Preserve [Aftermath - A New Order] and [Closing Image - The Photo on the Wall] as the final ending beats.`;

    artifact.protected_beats = DAPPLE_STAGE2_PROTECTED_BEATS;
    const revision = applyStageRevisionPlan({ stageId: 'stage2_outline', artifact, notes });

    assert.equal(revision.receipt.verified, true);
    assert.equal(revision.after.title, undefined);
    assert.deepEqual(revision.after.act_2[0].beats.map(beat => beat.beat_label), [
        'Aftermath - A Quiet Reckoning',
        "Quist's Betrayal & The Bonded Key",
        'Dapple Rising - The Anchor'
    ]);
    assert.equal(revision.after.act_3[0].beats.at(-1).beat_label, 'Closing Image - The Photo on the Wall');
});

test('Stage 2 outline verification tolerates curly anchors and already-absent deletes', () => {
    assert.equal(labelsEqual("Quist’s Betrayal & The Bonded Key", "Quist's Betrayal & The Bonded Key"), true);
    const beforeOutline = {
        act_1: [],
        act_2: [{
            sequence_number_and_title: 'Sequence E',
            beats: [{
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'First aftermath.'
            }, {
                beat_label: 'Quist’s Betrayal & The Bonded Key',
                description: 'Quist gives Rebecca the key.'
            }, {
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Duplicate aftermath.'
            }]
        }],
        act_3: [{
            sequence_number_and_title: 'Sequence H',
            beats: [{
                beat_label: 'Closing Image - The Photo on the Wall',
                description: 'The final image stays intact.'
            }]
        }]
    };
    const afterOutline = JSON.parse(JSON.stringify(beforeOutline));
    const notes = `Delete the second [Aftermath - A Quiet Reckoning] after [Quist's Betrayal & The Bonded Key] and replace it with the exact [Dapple Rising - The Anchor] beat.

[Dapple Rising - The Anchor] Dapple hijacks the Mobile Processing Core.

Delete [Resolution - A New Accord] entirely.`;

    const structuralPatch = applyStructuralOutlinePatches(afterOutline, notes);
    const receipt = createRevisionTransaction({
        stageId: 'stage2_outline',
        before: beforeOutline,
        after: afterOutline,
        notes,
        structuralPatch,
        adapter: outlineRevisionAdapter
    }).receipt;

    assert.equal(afterOutline.act_2[0].beats[2].beat_label, 'Dapple Rising - The Anchor');
    assert.equal(receipt.verified, true);
    assert.equal(receipt.failures.length, 0);
});

test('Stage 2 server finalizer applies structural outline patches to unchanged model output', () => {
    const outline = {
        act_1: [],
        act_2: [{
            sequence_number_and_title: 'Sequence E: The Breach Starts Counting Down',
            beats: [{
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Rebecca and Dave face the diner fallout.'
            }, {
                beat_label: "Quist's Betrayal & The Bonded Key",
                description: 'Quist gives Rebecca the key.'
            }, {
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Duplicate placeholder after Quist.'
            }]
        }],
        act_3: []
    };
    const notes = `Delete the second [Aftermath - A Quiet Reckoning], after [Quist's Betrayal & The Bonded Key], and replace it with the Dapple Rising beat.

[Dapple Rising - The Anchor] Dapple hijacks the Mobile Processing Core.`;

    const patch = applyStructuralOutlinePatches(outline, notes);

    assert.equal(patch.appliedCount, 1);
    assert.deepEqual(outline.act_2[0].beats.map(beat => beat.beat_label), [
        'Aftermath - A Quiet Reckoning',
        "Quist's Betrayal & The Bonded Key",
        'Dapple Rising - The Anchor'
    ]);
    assert.match(outline.act_2[0].beats[2].description, /Mobile Processing Core/);
});

test('revision transactions produce verified receipts across structured stages', () => {
    const beforeOutline = {
        act_1: [],
        act_2: [{
            sequence_number_and_title: 'Sequence E',
            beats: [{
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'First aftermath.'
            }, {
                beat_label: "Quist's Betrayal & The Bonded Key",
                description: 'Quist gives the key.'
            }, {
                beat_label: 'Aftermath - A Quiet Reckoning',
                description: 'Duplicate aftermath.'
            }]
        }],
        act_3: []
    };
    const afterOutline = JSON.parse(JSON.stringify(beforeOutline));
    const notes = `Delete the second [Aftermath - A Quiet Reckoning], after [Quist's Betrayal & The Bonded Key], and replace it with the Dapple Rising beat.

[Dapple Rising - The Anchor] Dapple hijacks the Mobile Processing Core.`;
    const structuralPatch = applyStructuralOutlinePatches(afterOutline, notes);
    const outlineTx = createRevisionTransaction({
        stageId: 'stage2_outline',
        before: beforeOutline,
        after: afterOutline,
        notes,
        structuralPatch,
        adapter: outlineRevisionAdapter
    });
    assert.equal(outlineTx.changed, true);
    assert.equal(outlineTx.receipt.verified, true);
    assert.match(outlineTx.receipt.summary, /structural outline operation/);

    const failedOutlineTx = createRevisionTransaction({
        stageId: 'stage2_outline',
        before: beforeOutline,
        after: beforeOutline,
        notes,
        structuralPatch: { operations: structuralPatch.operations, appliedCount: 0 },
        adapter: outlineRevisionAdapter
    });
    assert.equal(failedOutlineTx.changed, false);
    assert.equal(failedOutlineTx.receipt.verified, false);
    assert.ok(failedOutlineTx.receipt.failures.length > 0);

    const characterTx = createRevisionTransaction({
        stageId: 'stage3_characters',
        before: [{ name: 'Mara', role: 'Lead' }],
        after: [{ name: 'Mara', role: 'Lead', brief_summary: 'Now trusts June.' }],
        adapter: characterRevisionAdapter
    });
    assert.equal(characterTx.receipt.operations[0].itemType, 'character');

    const stage4Tx = createRevisionTransaction({
        stageId: 'stage4_beats',
        before: { hybrid_beat_sheet: [{ sequence_number: 1, beats: [{ beat_name: 'Opening', detailed_action: 'Old.' }] }] },
        after: { hybrid_beat_sheet: [{ sequence_number: 1, beats: [{ beat_name: 'Opening', detailed_action: 'New.' }] }] },
        adapter: stage4RevisionAdapter
    });
    assert.equal(stage4Tx.receipt.operations[0].itemType, 'stage4_beat');

    const treatmentTx = createRevisionTransaction({
        stageId: 'stage5_treatment',
        before: { act_3: 'Old ending.' },
        after: { act_3: 'New ending.' },
        adapter: treatmentRevisionAdapter
    });
    assert.equal(treatmentTx.receipt.operations[0].itemType, 'treatment_section');

    const sceneTx = createRevisionTransaction({
        stageId: 'stage6_scenes',
        before: [{ scenes: [{ scene_number: 1, scene_heading: 'INT. ROOM', narrative_action: 'Old.' }] }],
        after: [{ scenes: [{ scene_number: 1, scene_heading: 'INT. ROOM', narrative_action: 'New.' }] }],
        adapter: sceneBlueprintRevisionAdapter
    });
    assert.equal(sceneTx.receipt.operations[0].itemType, 'scene');
});

test('Stage 2 outline checklist delete items use the label nearest the delete instruction', () => {
    const notes = `1. Dapple Rising - The Anchor is still missing.
You still have two copies of [Aftermath - A Quiet Reckoning]. Delete the second [Aftermath - A Quiet Reckoning], after [Quist's Betrayal & The Bonded Key], and replace it with the Dapple Rising beat.
[Dapple Rising - The Anchor] Dapple has hijacked the Mobile Processing Core.
2. There's an accidental note left as a final beat.
The last paragraph is [The Rebecca's Memory - The Storm Drain] and says the paragraph works but repeats itself. Delete that entirely.`;

    const checklist = buildRevisionChecklist(notes);

    assert.ok(checklist.includes("Delete [The Rebecca's Memory - The Storm Drain]"));
    assert.ok(!checklist.includes('Delete [Aftermath - A Quiet Reckoning]'));
});

test('Stage 2 outline parser repairs missing commas between generated beat objects', async () => {
    const malformedOutlineJson = `{
        "title": "Arcade Night",
        "genre": "Thriller",
        "logline": "Mara searches a flooded arcade for the blue key.",
        "outline": {
            "act_1": [{
                "sequence_number_and_title": "Sequence A",
                "beats": [
                    { "beat_label": "Opening", "description": "Mara enters." }
                    { "beat_label": "Turn", "description": "The blue key appears." }
                ]
            }],
            "act_2": [],
            "act_3": []
        }
    }`;
    const { generateContentFn } = makeRecorder(() => ({
        text: malformedOutlineJson,
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, null, '', null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(result.outline.act_1[0].beats.length, 2);
    assert.equal(result.outline.act_1[0].beats[1].beat_label, 'Turn');
});

test('Stage 2 outline retries with model repair when JSON has an unterminated string', async () => {
    const repairedOutline = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
            act_2: [],
            act_3: []
        }
    };
    const { calls, generateContentFn } = makeRecorder((_request, callNumber) => ({
        text: callNumber === 1
            ? `{"title":"Arcade Night","genre":"Thriller","logline":"Mara searches.","outline":{"act_1":[{"sequence_number_and_title":"Sequence A","beats":[{"beat_label":"Opening","description":"Mara enters.`
            : JSON.stringify(repairedOutline),
        usage: { model: 'gemini-test', inputTokens: 1, outputTokens: 1 }
    }));

    const { result, usage } = await agent2Outline(pitch, null, '', null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 2);
    assert.match(collectText(calls[1].contents), /Repair ONLY the JSON syntax/);
    assert.equal(calls[1].config.temperature, 0);
    assert.equal(result.outline.act_1[0].beats[0].description, 'Mara enters.');
    assert.equal(usage.inputTokens, 2);
    assert.equal(usage.outputTokens, 2);
});

test('Stage 2 outline retries transient terminated generation errors', async () => {
    const outlineResponse = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
            act_2: [],
            act_3: []
        }
    };
    const { calls, generateContentFn } = makeRecorder((_request, callNumber) => {
        if (callNumber === 1) throw new Error('terminated');
        return {
            text: JSON.stringify(outlineResponse),
            usage: { model: 'gemini-test', inputTokens: 1, outputTokens: 1 }
        };
    });

    const { result } = await agent2Outline(pitch, null, '', null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn,
        retryDelayMs: 0
    });

    assert.equal(calls.length, 2);
    assert.equal(result.outline.act_1[0].beats[0].beat_label, 'Opening');
});

test('Stage 2 outline retries transient terminated JSON repair errors', async () => {
    const repairedOutline = {
        title: pitch.title,
        genre: pitch.genre,
        logline: pitch.logline,
        outline: {
            act_1: [{ sequence_number_and_title: 'Sequence A', beats: [{ beat_label: 'Opening', description: 'Mara enters.' }] }],
            act_2: [],
            act_3: []
        }
    };
    const { calls, generateContentFn } = makeRecorder((_request, callNumber) => {
        if (callNumber === 1) {
            return {
                text: `{"title":"Arcade Night","genre":"Thriller","logline":"Mara searches.","outline":{"act_1":[{"sequence_number_and_title":"Sequence A","beats":[{"beat_label":"Opening","description":"Mara enters.`,
                usage: { model: 'gemini-test', inputTokens: 1, outputTokens: 1 }
            };
        }
        if (callNumber === 2) throw new Error('terminated');
        return {
            text: JSON.stringify(repairedOutline),
            usage: { model: 'gemini-test', inputTokens: 1, outputTokens: 1 }
        };
    });

    const { result, usage } = await agent2Outline(pitch, null, '', null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn,
        retryDelayMs: 0
    });

    assert.equal(calls.length, 3);
    assert.match(collectText(calls[1].contents), /Repair ONLY the JSON syntax/);
    assert.match(collectText(calls[2].contents), /Repair ONLY the JSON syntax/);
    assert.equal(result.outline.act_1[0].beats[0].description, 'Mara enters.');
    assert.equal(usage.inputTokens, 2);
});

test('Stage 3 character revisions preserve unmentioned profiles from the saved cast', async () => {
    const deepProfile = {
        mbti_type: 'INTJ',
        enneagram_type: 'Type 5',
        enneagram_wing: '5w6',
        stress_behavior: 'Withdraws under pressure.',
        growth_behavior: 'Shares responsibility.',
        dialogue_fingerprint: 'Short declarative sentences.',
        relationship_dynamics: [],
        scene_behavior_predictions: 'Quiet in low stakes, precise in high stakes.'
    };
    const makeCharacter = (name, brief) => ({
        name,
        role: name === 'Mara' ? 'Lead' : 'Ally',
        brief_summary: brief,
        psychological_core: {
            ghost_and_wound: 'Old wound.',
            the_lie: 'She must solve it alone.',
            fear: 'Being trapped.',
            desire: 'Find the blue key.',
            psychological_need: 'Trust someone else.',
            moral_need: 'Stop controlling allies.',
            paradox: 'Guarded but tender.'
        },
        voice_and_behavior: {
            voice_tag: 'Sparse & precise',
            pressure_tag: 'Controls',
            humor_tag: 'Dry wit',
            speech_patterns: 'Keeps sentences clipped.',
            deflection_tactic: 'Changes the subject.'
        },
        arc: { core_drive: 'To be safe', direction: 'Growth' },
        ticks: { enabled: false, description: '', frequency_gate: '' },
        _deep_profile: deepProfile
    });
    const currentCharacters = {
        characters: [
            makeCharacter('Mara', 'Mara carries the blue key.'),
            makeCharacter('June', 'June keeps the flooded arcade source continuity.')
        ]
    };
    const modelCharacters = {
        characters: [
            makeCharacter('Mara', 'Mara now admits she needs June before using the blue key.'),
            makeCharacter('June', 'June has been accidentally rewritten by the model.')
        ]
    };
    const { generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(modelCharacters),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent3Characters(
        pitch,
        beats,
        currentCharacters,
        'Only update Mara so she admits she needs June before using the blue key.',
        null,
        { generateContentFn }
    );

    assert.match(result.characters[0].brief_summary, /admits she needs June/);
    assert.equal(result.characters[1].brief_summary, currentCharacters.characters[1].brief_summary);
});

test('Stage 3 character generation keeps cameo profiles light by default', async () => {
    const modelCharacters = {
        characters: [{
            name: 'Receptionist',
            role: 'Scene Utility',
            profile_tier: 'Tier 3',
            brief_summary: 'A front-desk obstacle who makes Mara wait while the blue key clock is running.',
            cameo_profile: {
                scene_purpose: 'Delays Mara long enough for the pressure of the search to sharpen.',
                casting_energy: 'Bright, procedural, mildly unbothered.',
                playable_behavior: 'Keeps prioritizing forms over panic.',
                line_style_example: 'One form per emergency.'
            }
        }]
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(modelCharacters),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent3Characters(
        pitch,
        beats,
        null,
        null,
        null,
        { generateContentFn }
    );

    assert.equal(calls.length, 1);
    const required = calls[0].schema.properties.characters.items.required;
    assert.ok(required.includes('profile_tier'));
    assert.ok(!required.includes('psychological_core'));
    assert.ok(!required.includes('ticks'));
    assert.ok(!required.includes('_deep_profile'));
    assert.ok(!required.includes('backstory'));
    assert.ok(calls[0].schema.properties.characters.items.properties.backstory);

    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /profile_tier: "Tier 3"/);
    assert.match(promptText, /Do NOT generate Ghost & Wound, The Lie, Fear, Psychological Need, Moral Need/);
    assert.match(promptText, /Backstory is not required/);
    assert.match(calls[0].config.systemInstruction, /Giving a full therapeutic profile to a utility role is also an error/);

    const cameo = result.characters[0];
    assert.equal(cameo.profile_tier, 'Tier 3');
    assert.equal(cameo.cameo_profile.scene_purpose, modelCharacters.characters[0].cameo_profile.scene_purpose);
    assert.deepEqual(cameo.backstory, {});
    assert.deepEqual(cameo.psychological_core, {});
    assert.deepEqual(cameo.voice_and_behavior, {});
    assert.deepEqual(cameo.arc, {});
    assert.equal(cameo.ticks.enabled, false);
    assert.equal(cameo._deep_profile, undefined);
});

test('Stage 3 character generation keeps backstory optional and tier-aware', async () => {
    const modelCharacters = {
        characters: [
            {
                name: 'Mara',
                role: 'Protagonist',
                profile_tier: 'Tier 1',
                brief_summary: 'Mara carries the blue key into the flooded arcade.',
                backstory: {
                    essential_history: 'Mara found the blue key during the first flood and never told June.',
                    formative_event: 'She was blamed for opening the wrong door.',
                    relationship_history: 'June covered for her once and has been waiting for honesty since.',
                    secret_or_reveal: 'The key was not found; it was stolen.',
                    onscreen_relevance: 'She avoids locked doors until the midpoint forces a confession.'
                },
                psychological_core: {
                    ghost_and_wound: 'Old wound.',
                    the_lie: 'She must solve it alone.',
                    fear: 'Being trapped.',
                    desire: 'Find the exit.',
                    psychological_need: 'Trust someone else.',
                    moral_need: 'Stop hiding costs from allies.'
                },
                voice_and_behavior: {},
                arc: { core_drive: 'To be safe', direction: 'Growth' },
                ticks: {}
            },
            {
                name: 'Pono',
                role: 'Supporting',
                profile_tier: 'Tier 2',
                brief_summary: 'Pono keeps the crew honest about practical obstacles.',
                backstory: {
                    relevant_history: 'Pono used to maintain the arcade flood gates.',
                    why_they_matter_now: 'They know which warning lights are lying.'
                },
                functional_profile: {
                    narrative_function: 'Forces the crew to solve problems in the right order.',
                    emotional_truth: 'Wants competence to count for something.',
                    comic_or_tension_function: 'Dry logistical friction.',
                    pressure_behavior: 'Names the cost before the room is ready.',
                    voice_flavor: 'Plainspoken and unimpressed.'
                }
            }
        ]
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(modelCharacters),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent3Characters(
        pitch,
        beats,
        null,
        null,
        null,
        { generateContentFn }
    );

    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /Tier 1 may use essential_history, formative_event, relationship_history, secret_or_reveal, and onscreen_relevance/);
    assert.match(promptText, /Tier 2 may use only relevant_history and why_they_matter_now/);

    const mara = result.characters.find(c => c.name === 'Mara');
    assert.equal(mara.backstory.essential_history, modelCharacters.characters[0].backstory.essential_history);
    assert.equal(mara.backstory.secret_or_reveal, modelCharacters.characters[0].backstory.secret_or_reveal);

    const pono = result.characters.find(c => c.name === 'Pono');
    assert.equal(pono.backstory.relevant_history, modelCharacters.characters[1].backstory.relevant_history);
    assert.equal(pono.backstory.why_they_matter_now, modelCharacters.characters[1].backstory.why_they_matter_now);
    assert.deepEqual(pono.psychological_core, {});
});

test('Stage 3 character generation coerces configured project tiers and strips minor psychology', async () => {
    const badModelCharacters = {
        characters: [
            {
                name: 'Molly',
                role: 'Supporting',
                profile_tier: 'Tier 1',
                brief_summary: 'Molly creates a quick handoff problem.',
                cameo_profile: {
                    scene_purpose: 'Complicates the handoff for a single scene.',
                    casting_energy: 'Busy, bright, slightly distracted.',
                    playable_behavior: 'Keeps moving while half-listening.',
                    line_style_example: 'Can this be a walking conversation?'
                },
                psychological_core: {
                    ghost_and_wound: 'Overbuilt wound.',
                    the_lie: 'Overbuilt lie.',
                    fear: 'Overbuilt fear.',
                    desire: 'Overbuilt desire.',
                    psychological_need: 'Overbuilt need.',
                    moral_need: 'Overbuilt moral need.'
                },
                voice_and_behavior: {
                    voice_tag: 'Sharp & confrontational',
                    pressure_tag: 'Controls',
                    humor_tag: 'Dry wit',
                    speech_patterns: 'Overbuilt speech rules.',
                    deflection_tactic: 'Overbuilt tactic.'
                },
                arc: { core_drive: 'To be right', direction: 'Growth' },
                ticks: { enabled: true, description: 'Overbuilt tick.', frequency_gate: 'Always.' },
                _deep_profile: { mbti_type: 'INTJ' }
            },
            {
                name: 'Pono',
                role: 'Supporting',
                profile_tier: 'Tier 1',
                brief_summary: 'Pono keeps the pressure moving without a full inner journey.',
                functional_profile: {
                    narrative_function: 'Keeps Rebecca pointed toward the next practical obstacle.',
                    emotional_truth: 'Wants everyone to stop pretending chaos is a plan.',
                    comic_or_tension_function: 'Dry logistical friction.',
                    pressure_behavior: 'Names the obvious cost before anyone wants to hear it.',
                    voice_flavor: 'Plainspoken, unimpressed, fast with a correction.'
                },
                psychological_core: {
                    ghost_and_wound: 'Should be stripped.',
                    the_lie: 'Should be stripped.',
                    fear: 'Should be stripped.',
                    desire: 'Should be stripped.',
                    psychological_need: 'Should be stripped.',
                    moral_need: 'Should be stripped.'
                },
                arc: { core_drive: 'To be safe', direction: 'Growth' },
                _deep_profile: { mbti_type: 'ISTJ' }
            },
            {
                name: 'Moog',
                role: 'Repeat Offender',
                profile_tier: 'Tier 1',
                brief_summary: 'A hulking stone-and-root figment whose desperate attempts to be seen by his aged-out child result in massive property damage.',
                functional_profile: {},
                cameo_profile: {},
                psychological_core: {},
                voice_and_behavior: {},
                arc: {},
                ticks: {}
            }
        ]
    };
    const { generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(badModelCharacters),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent3Characters(
        pitch,
        beats,
        null,
        null,
        null,
        {
            generateContentFn,
            tierOverrides: { Molly: 3, Pono: 2, Moog: 2 }
        }
    );

    const molly = result.characters.find(c => c.name === 'Molly');
    assert.equal(molly.profile_tier, 'Tier 3');
    assert.equal(molly.cameo_profile.scene_purpose, 'Complicates the handoff for a single scene.');
    assert.deepEqual(molly.functional_profile, {});
    assert.deepEqual(molly.psychological_core, {});
    assert.deepEqual(molly.voice_and_behavior, {});
    assert.deepEqual(molly.arc, {});
    assert.equal(molly.ticks.enabled, false);
    assert.equal(molly.ticks.description, '');
    assert.equal(molly.ticks.frequency_gate, '');
    assert.equal(molly._deep_profile, undefined);

    const pono = result.characters.find(c => c.name === 'Pono');
    assert.equal(pono.profile_tier, 'Tier 2');
    assert.equal(pono.functional_profile.narrative_function, 'Keeps Rebecca pointed toward the next practical obstacle.');
    assert.equal(pono.functional_profile.voice_flavor, 'Plainspoken, unimpressed, fast with a correction.');
    assert.deepEqual(pono.cameo_profile, {});
    assert.deepEqual(pono.psychological_core, {});
    assert.deepEqual(pono.arc, {});
    assert.equal(pono.ticks.enabled, false);
    assert.equal(pono.ticks.description, '');
    assert.equal(pono.ticks.frequency_gate, '');
    assert.equal(pono._deep_profile, undefined);

    const moog = result.characters.find(c => c.name === 'Moog');
    assert.equal(moog.profile_tier, 'Tier 2');
    assert.equal(moog.functional_profile.narrative_function, badModelCharacters.characters[2].brief_summary);
    assert.deepEqual(moog.psychological_core, {});
    assert.deepEqual(moog.arc, {});
    assert.equal(moog._deep_profile, undefined);
});

test('Stage 3 tier guidance uses project tier overrides when names appear', async () => {
    const beatsWithNamedCast = {
        act_1: [{
            sequence_number_and_title: 'Sequence A',
            beats: [{
                beat_label: 'Office Pressure',
                description: 'Rebecca, Terry, Robotobob, Pono, Moog, Big Doll, Pretz, Molly, Dylan, Ms. Alvarado, Carol, Brenda, Vance, Gary, Tyler, and Dylan’s parents all appear in the same pressure run.'
            }]
        }],
        act_2: [],
        act_3: []
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify({ characters: [] }),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));
    const tierOverrides = {
        Rebecca: 1,
        Terry: 1,
        Robotobob: 1,
        Pono: 2,
        Moog: 2,
        'Big Doll': 2,
        Pretz: 2,
        Molly: 3,
        Dylan: 3,
        'Dylan’s parents': 3,
        'Ms. Alvarado': 3,
        Carol: 3,
        Brenda: 3,
        Vance: 3,
        Gary: 3,
        Tyler: 3
    };

    await agent3Characters(
        pitch,
        beatsWithNamedCast,
        null,
        null,
        null,
        { generateContentFn, tierOverrides }
    );

    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /Treat these named arc-bearing characters as Tier 1[^:]*: Rebecca, Terry, Robotobob/);
    assert.match(promptText, /Treat these functional supporting characters as Tier 2[^:]*: Pono, Moog, Big Doll, Pretz/);
    assert.match(promptText, /Treat these scene utility \/ cameo characters as Tier 3[^:]*: Molly, Dylan, Dylan’s parents, Ms\. Alvarado, Carol, Brenda, Vance, Gary, Tyler/);
    assert.match(promptText, /Fill `functional_profile` with narrative_function, emotional_truth, comic_or_tension_function, pressure_behavior, and voice_flavor/);
    assert.match(promptText, /Fill only `cameo_profile` with scene_purpose, casting_energy, playable_behavior, and line_style_example/);
});

test('Stage 4 beat revisions preserve unmentioned beats from the saved sheet', async () => {
    const currentBeats = stage4ResponseFixture();
    const damagedModelBeats = stage4ResponseFixture();
    damagedModelBeats.hybrid_beat_sheet[0].beats[0].detailed_action = 'The opening has been accidentally rewritten.';
    damagedModelBeats.hybrid_beat_sheet[3].beats[0].detailed_action = 'Mara recognizes June at the flooded arcade midpoint.';
    const { generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(damagedModelBeats),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent4Beats(
        pitch,
        outlineWithSeparatedMidpointAndSpectacle,
        characters,
        currentBeats,
        'Only revise [Midpoint] so Mara recognizes June at the flooded arcade.',
        null,
        null,
        { generateContentFn }
    );

    assert.equal(
        result.hybrid_beat_sheet[0].beats[0].detailed_action,
        currentBeats.hybrid_beat_sheet[0].beats[0].detailed_action
    );
    assert.match(result.hybrid_beat_sheet[3].beats[0].detailed_action, /recognizes June/);
});

test('Stage 4 beat generation treats Stage 2 outline sequence placement as binding', async () => {
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(stage4ResponseFixture()),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await agent4Beats(pitch, outlineWithSeparatedMidpointAndSpectacle, characters, null, null, null, null, {
        knowledgeContext: BASE_KNOWLEDGE_PACKET,
        generateContentFn
    });

    assert.equal(calls.length, 1);
    assertSourceAwareCall(calls[0], 'Stage 4 Beat Sheet');
    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /APPROVED STAGE 2 OUTLINE LOCK/);
    assert.match(promptText, /Stage 4 is an expansion pass/);
    assert.match(promptText, /Do not move a major event/);
    assert.match(promptText, /Scott is Dapple/);
    assert.match(promptText, /Code Wendy triggers the Kaiju transformation/);
    assert.match(promptText, /same-numbered Stage 2 sequence/);
});

test('Stage 4 beat revisions include the approved outline lock beside current beats', async () => {
    const currentBeats = stage4ResponseFixture();
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(currentBeats),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await agent4Beats(
        pitch,
        outlineWithSeparatedMidpointAndSpectacle,
        characters,
        currentBeats,
        'Restore the Fairview dinner reveal as the Midpoint and keep Code Wendy in Sequence F.',
        null,
        null,
        {
            knowledgeContext: BASE_KNOWLEDGE_PACKET,
            generateContentFn
        }
    );

    assert.equal(calls.length, 1);
    assertSourceAwareCall(calls[0], 'Stage 4 Beat Sheet');
    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /APPROVED STAGE 2 OUTLINE LOCK/);
    assert.match(promptText, /EXISTING BEATS/);
    assert.match(promptText, /Fairview dinner table/);
    assert.match(promptText, /Code Wendy triggers the Kaiju transformation/);
    assert.match(calls[0].config.systemInstruction, /approved Stage 2 sequence boundaries/);
    assert.equal(calls[0].config.maxOutputTokens, 32000);
});

test('Stage 4 beat revisions repair malformed JSON responses', async () => {
    const currentBeats = stage4ResponseFixture();
    const repairedBeats = stage4ResponseFixture();
    const { calls, generateContentFn } = makeRecorder((request, callNumber) => ({
        text: callNumber === 1
            ? '{"stc_genre_category":"Whydunit","hybrid_beat_sheet":[{"sequence_number":1,"sequence_title":"Sequence 1","beats":[{"beat_name":"Opening","genre_variation_notes":"Genre notes.","emotional_arc":"Arc.","pacing_notes":"Pacing.","detailed_action":"Mara enters."}]}'
            : JSON.stringify(repairedBeats),
        usage: { inputTokens: callNumber, outputTokens: 1 }
    }));

    const { result, usage } = await agent4Beats(
        pitch,
        outlineWithSeparatedMidpointAndSpectacle,
        characters,
        currentBeats,
        'Make the Sequence 7 inside-monster visuals clearer.',
        null,
        null,
        {
            knowledgeContext: BASE_KNOWLEDGE_PACKET,
            generateContentFn,
            retryDelayMs: 0
        }
    );

    assert.equal(calls.length, 2);
    assert.match(collectText(calls[1].contents), /Repair ONLY the JSON syntax/);
    assert.equal(calls[0].config.maxOutputTokens, 32000);
    assert.equal(calls[1].config.maxOutputTokens, 32000);
    assert.equal(result.hybrid_beat_sheet.length, 8);
    assert.equal(usage.inputTokens, 3);
});

test('Stage 4 beat generation retries transient model failures', async () => {
    const { calls, generateContentFn } = makeRecorder((request, callNumber) => {
        if (callNumber === 1) throw new Error('terminated');
        return {
            text: JSON.stringify(stage4ResponseFixture()),
            usage: { inputTokens: 1, outputTokens: 1 }
        };
    });

    const { result } = await agent4Beats(
        pitch,
        outlineWithSeparatedMidpointAndSpectacle,
        characters,
        null,
        null,
        null,
        null,
        {
            knowledgeContext: BASE_KNOWLEDGE_PACKET,
            generateContentFn,
            retryDelayMs: 0
        }
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].config.maxOutputTokens, 32000);
    assert.equal(result.hybrid_beat_sheet.length, 8);
});

test('Stage 5 treatment generation carries project memory into each chained prompt', async () => {
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify({
            title_logline_characters: 'Title. Mara carries the blue key.',
            act_1: 'Act I keeps the flooded arcade.',
            act_2a: 'Act IIA keeps the flooded arcade.',
            act_2b: 'Act IIB keeps the flooded arcade.',
            act_3: 'Act III keeps the flooded arcade.'
        }),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await agent5Treatment(pitch, characters, beats, null, null, null, {
        knowledgeContext: BASE_KNOWLEDGE_PACKET,
        generateContentFn
    });

    assert.equal(calls.length, 4);
    calls.forEach(call => {
        assertSourceAwareCall(call, 'Stage 5 Treatment');
        const promptText = collectText(call.contents);
        assert.match(promptText, /APPROVED FULL-STORY TREATMENT CONTRACT/);
        assert.match(promptText, /Global 8-Sequence Beat Map/i);
    });
    assert.match(collectText(calls[2].contents), /PRIOR GENERATED CONTEXT \(Sequences 1-4/);
    assert.match(collectText(calls[3].contents), /PRIOR GENERATED CONTEXT \(Sequences 1-6/);
});

test('Stage 6 scene generation carries project memory into every sequence prompt', async () => {
    const { calls, generateContentFn } = makeRecorder(request => {
        if (/Extract every distinct physical location/.test(collectText(request.contents))) {
            return {
                text: JSON.stringify({ locations: ['FLOODED ARCADE'] }),
                usage: { inputTokens: 1, outputTokens: 1 }
            };
        }
        if (/Build a Stage 6 continuity ledger/.test(collectText(request.contents))) {
            return {
                text: JSON.stringify({
                    global_locks: [{
                        category: 'prop',
                        detail: 'Mara keeps the blue key visible through the flooded arcade escape.',
                        source_anchor: 'Approved treatment',
                        sequences: [1, 2, 3]
                    }],
                    sequence_contracts: Array.from({ length: 8 }, (_, index) => ({
                        sequence_number: index + 1,
                        starts_after: index === 0 ? 'Start of film' : `Sequence ${index} climax`,
                        ends_with: `Sequence ${index + 1} endpoint`,
                        must_include: ['Mara keeps the blue key.'],
                        must_not_change: ['Do not move the key to another character.'],
                        continuity_dependencies: ['The key remains visible for later payoff.']
                    }))
                }),
                usage: { inputTokens: 1, outputTokens: 1 }
            };
        }

        return {
            text: JSON.stringify({
                sequence_title: 'Arcade Sequence',
                total_estimated_pages: 1,
                scenes: [{
                    scene_number: 1,
                    scene_heading: 'INT. FLOODED ARCADE - NIGHT',
                    narrative_action: 'Mara keeps the blue key visible.',
                    dramaturgical_function: 'Preserves source continuity.',
                    estimated_page_count: 1
                }]
            }),
            usage: { inputTokens: 1, outputTokens: 1 }
        };
    });

    await generateStage6Scenes(pitch, characters, beats, treatmentFixture(), null, BASE_KNOWLEDGE_PACKET, {
        generateContentFn
    });

    const sequenceCalls = calls.filter(call => {
        const text = collectText(call.contents);
        return !/Extract every distinct physical location/.test(text) && !/Build a Stage 6 continuity ledger/.test(text);
    });
    assert.equal(sequenceCalls.length, 8);
    sequenceCalls.forEach(call => {
        assertSourceAwareCall(call, 'Stage 6 Scene Blueprint');
        const promptText = collectText(call.contents);
        assert.match(promptText, /GLOBAL TREATMENT SEQUENCE INDEX/);
        assert.match(promptText, /GLOBAL CONTINUITY LEDGER/);
        assert.match(promptText, /CURRENT SEQUENCE CONTINUITY CONTRACT/);
        assert.match(promptText, /Mara keeps the blue key/);
    });
});

test('Stage 6 scene generation repairs malformed late sequence JSON', async () => {
    const sceneResponse = {
        sequence_title: 'Arcade Sequence',
        total_estimated_pages: 1,
        scenes: [{
            scene_number: 1,
            scene_heading: 'INT. FLOODED ARCADE - NIGHT',
            narrative_action: 'Mara keeps the blue key visible.',
            dramaturgical_function: 'Preserves source continuity.',
            estimated_page_count: 1
        }]
    };
    let malformedSequence8Returned = false;
    const { calls, generateContentFn } = makeRecorder(request => {
        const text = collectText(request.contents);
        if (/Extract every distinct physical location/.test(text)) {
            return {
                text: JSON.stringify({ locations: ['FLOODED ARCADE'] }),
                usage: { inputTokens: 1, outputTokens: 1 }
            };
        }
        if (/Build a Stage 6 continuity ledger/.test(text)) {
            return {
                text: JSON.stringify({ global_locks: [], sequence_contracts: [] }),
                usage: { inputTokens: 1, outputTokens: 1 }
            };
        }
        if (/Repair ONLY the JSON syntax/.test(text)) {
            return {
                text: JSON.stringify(sceneResponse),
                usage: { inputTokens: 2, outputTokens: 1 }
            };
        }
        if (/OBJECTIVE: Break down Sequence 8/.test(text) && !malformedSequence8Returned) {
            malformedSequence8Returned = true;
            return {
                text: '{"sequence_title":"Arcade Sequence","total_estimated_pages":1,"scenes":[{"scene_number":1,"scene_heading":"INT. FLOODED ARCADE - NIGHT","narrative_action":"Mara keeps the blue key visible."',
                usage: { inputTokens: 1, outputTokens: 1 }
            };
        }
        return {
            text: JSON.stringify(sceneResponse),
            usage: { inputTokens: 1, outputTokens: 1 }
        };
    });

    const { result } = await generateStage6Scenes(pitch, characters, beats, treatmentFixture(), null, BASE_KNOWLEDGE_PACKET, {
        generateContentFn,
        retryDelayMs: 0
    });

    assert.equal(result.length, 8);
    assert.equal(result[7].scenes.length, 1);
    assert.ok(calls.some(call => /Repair ONLY the JSON syntax/.test(collectText(call.contents))));
    const sequenceCalls = calls.filter(call => /OBJECTIVE: Break down Sequence/.test(collectText(call.contents)));
    assert.equal(sequenceCalls.length, 8);
    assert.equal(sequenceCalls[0].config.maxOutputTokens, 32000);
});

test('Stage 6 scene generation retries transient late sequence failures', async () => {
    const sceneResponse = {
        sequence_title: 'Arcade Sequence',
        total_estimated_pages: 1,
        scenes: [{
            scene_number: 1,
            scene_heading: 'INT. FLOODED ARCADE - NIGHT',
            narrative_action: 'Mara keeps the blue key visible.',
            dramaturgical_function: 'Preserves source continuity.',
            estimated_page_count: 1
        }]
    };
    let sequence7Failed = false;
    const { calls, generateContentFn } = makeRecorder(request => {
        const text = collectText(request.contents);
        if (/Extract every distinct physical location/.test(text)) {
            return {
                text: JSON.stringify({ locations: ['FLOODED ARCADE'] }),
                usage: { inputTokens: 1, outputTokens: 1 }
            };
        }
        if (/Build a Stage 6 continuity ledger/.test(text)) {
            return {
                text: JSON.stringify({ global_locks: [], sequence_contracts: [] }),
                usage: { inputTokens: 1, outputTokens: 1 }
            };
        }
        if (/OBJECTIVE: Break down Sequence 7/.test(text) && !sequence7Failed) {
            sequence7Failed = true;
            throw new Error('terminated');
        }
        return {
            text: JSON.stringify(sceneResponse),
            usage: { inputTokens: 1, outputTokens: 1 }
        };
    });

    const { result } = await generateStage6Scenes(pitch, characters, beats, treatmentFixture(), null, BASE_KNOWLEDGE_PACKET, {
        generateContentFn,
        retryDelayMs: 0
    });

    assert.equal(result.length, 8);
    assert.equal(calls.filter(call => /OBJECTIVE: Break down Sequence 7/.test(collectText(call.contents))).length, 2);
});

test('Stage 6 revision carries project memory beside director feedback', async () => {
    const currentBlueprint = [{
        sequence_number: 1,
        sequence_title: 'Arcade Sequence',
        total_estimated_pages: 1,
        scenes: [{
            scene_number: 1,
            scene_heading: 'INT. FLOODED ARCADE - NIGHT',
            narrative_action: 'Mara drops the key.',
            dramaturgical_function: 'Needs correction.',
            estimated_page_count: 1,
            draft_text: 'INT. FLOODED ARCADE - NIGHT\nMara drops the key.'
        }]
    }];
    const revisedBlueprint = [{
        ...currentBlueprint[0],
        scenes: [{
            ...currentBlueprint[0].scenes[0],
            narrative_action: 'Mara keeps the blue key.'
        }]
    }];
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(revisedBlueprint),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await reviseStage6Scenes(currentBlueprint, 'Restore the blue key continuity.', {
        knowledgeContext: BASE_KNOWLEDGE_PACKET,
        generateContentFn
    });

    assert.equal(calls.length, 1);
    assertSourceAwareCall(calls[0], 'Stage 6 Scene Blueprint Revision');
    assert.match(collectText(calls[0].contents), /Restore the blue key continuity/);
});

test('Stage 6 revision sends full text for explicitly targeted scenes', async () => {
    const longPrefix = 'This scene establishes the wrong relationship framing. '.repeat(8);
    const currentBlueprint = [{
        sequence_number: 4,
        sequence_title: 'Rebecca',
        total_estimated_pages: 10,
        scenes: [{
            scene_number: 33,
            scene_heading: 'INT. REBECCA HOUSE - NIGHT',
            narrative_action: `${longPrefix}The scene continues with visual business.`,
            dramaturgical_function: `${longPrefix}The two former childhood friends are now uneasy allies bound by her son.`,
            estimated_page_count: 2
        }]
    }, {
        sequence_number: 5,
        sequence_title: 'Road',
        total_estimated_pages: 10,
        scenes: [{
            scene_number: 40,
            scene_heading: 'EXT. INTERSTATE - NIGHT',
            narrative_action: 'Mara keeps driving.',
            dramaturgical_function: 'Compact context only.',
            estimated_page_count: 1
        }]
    }];
    const revisedSequence = {
        ...currentBlueprint[0],
        scenes: [{
            ...currentBlueprint[0].scenes[0],
            dramaturgical_function: 'The man who lied to her twenty years ago and the woman he lied to are now uneasy allies bound by her son.'
        }]
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify([revisedSequence]),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await reviseStage6Scenes(currentBlueprint, 'Scene 33: strip "former childhood friends" framing.', {
        knowledgeContext: BASE_KNOWLEDGE_PACKET,
        generateContentFn
    });

    assert.equal(calls.length, 1);
    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /REVISION TARGETS/);
    assert.match(promptText, /Scenes: 33/);
    assert.match(promptText, /former childhood friends/);
    assert.match(promptText, /compact-context/);
    assert.doesNotMatch(promptText, /full-target-context/);
});

test('Stage 6 revision sends full context for explicitly targeted sequences', async () => {
    const currentBlueprint = [{
        sequence_number: 4,
        sequence_title: 'Rebecca',
        total_estimated_pages: 10,
        scenes: [{
            scene_number: 33,
            scene_heading: 'INT. REBECCA HOUSE - NIGHT',
            narrative_action: 'Rebecca catches the lie.',
            dramaturgical_function: 'Turns suspicion into action.',
            estimated_page_count: 2
        }]
    }];
    const revisedSequence = {
        ...currentBlueprint[0],
        scenes: [{
            ...currentBlueprint[0].scenes[0],
            dramaturgical_function: 'Clarifies the sequence pressure.'
        }]
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify([revisedSequence]),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await reviseStage6Scenes(currentBlueprint, 'Sequence 4: clarify the pressure ladder.', {
        generateContentFn
    });

    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /Sequences: 4/);
    assert.match(promptText, /full-target-context/);
});

test('Stage 6 revision parses list-style scene targets', async () => {
    const currentBlueprint = [{
        sequence_number: 1,
        sequence_title: 'Opening Protocol',
        total_estimated_pages: 4,
        scenes: [{
            scene_number: 1,
            scene_heading: 'EXT. BACKYARD - DAY',
            narrative_action: 'The backyard is a mess.',
            dramaturgical_function: 'Starts the case.',
            estimated_page_count: 1
        }, {
            scene_number: 2,
            scene_heading: 'INT. AGENCY SUV - DAY',
            narrative_action: 'Slatern reads protocol.',
            dramaturgical_function: 'Explains the response.',
            estimated_page_count: 1
        }]
    }];
    const revisedSequence = {
        ...currentBlueprint[0],
        scenes: currentBlueprint[0].scenes.map(scene => ({ ...scene }))
    };
    revisedSequence.scenes[1].narrative_action = 'Slatern reads protocol after the kid protests, "It wasn\'t me!"';
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify([revisedSequence]),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await reviseStage6Scenes(
        currentBlueprint,
        'Scene 1 and 2. Add the missing protest before the child-welfare protocol lands.',
        { generateContentFn }
    );

    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /Scenes: 1, 2/);
});

test('Stage 6 untargeted revision uses surgical inference instead of full-blueprint rewrite context', async () => {
    const longOpening = 'A long opening setup that should stay intact. '.repeat(30);
    const currentBlueprint = [{
        sequence_number: 1,
        sequence_title: 'Opening Protocol',
        total_estimated_pages: 6,
        scenes: [{
            scene_number: 1,
            scene_heading: 'EXT. BACKYARD - DAY',
            narrative_action: longOpening,
            dramaturgical_function: 'Establishes ordinary domestic chaos.',
            estimated_page_count: 1
        }, {
            scene_number: 2,
            scene_heading: 'INT. AGENCY SUV - DAY',
            narrative_action: 'Slatern reads the child-welfare-call protocol.',
            dramaturgical_function: 'Introduces the Agency response.',
            estimated_page_count: 1
        }]
    }, {
        sequence_number: 2,
        sequence_title: 'Later Trouble',
        total_estimated_pages: 6,
        scenes: [{
            scene_number: 3,
            scene_heading: 'INT. OFFICE - DAY',
            narrative_action: 'A later scene that should remain untouched.',
            dramaturgical_function: 'Continues the investigation.',
            estimated_page_count: 1
        }]
    }];
    const revisedScene = {
        sequence_number: 1,
        sequence_title: 'Opening Protocol',
        total_estimated_pages: 6,
        scenes: [{
            scene_number: 2,
            scene_heading: 'INT. AGENCY SUV - DAY',
            narrative_action: 'Slatern reads the child-welfare-call protocol after the kid in the backyard protests, "It wasn\'t me!" over the impossible mess.',
            dramaturgical_function: 'Introduces the Agency response only after the child has clearly been blamed for a mess he did not make.',
            estimated_page_count: 1
        }]
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify([revisedScene]),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await reviseStage6Scenes(
        currentBlueprint,
        'We are missing the child protesting that it was not him before the child-welfare protocol lands.',
        { generateContentFn }
    );

    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /Surgical inference mode/);
    assert.doesNotMatch(promptText, /full-target-context/);
    assert.match(promptText, /compact-context/);
    assert.equal(result[0].scenes[0].narrative_action, longOpening);
    assert.match(result[0].scenes[1].narrative_action, /It wasn't me/);
    assert.match(result[1].scenes[0].narrative_action, /remain untouched/);
});

test('Stage 6 revision applies structural scene deletes against the saved blueprint', async () => {
    const currentBlueprint = [{
        sequence_number: 1,
        sequence_title: 'Opening Protocol',
        total_estimated_pages: 6,
        scenes: [{
            scene_number: 1,
            scene_heading: 'INT. WRONG ROOM - DAY',
            narrative_action: 'This scene should be removed.',
            dramaturgical_function: 'A mistaken duplicate.',
            estimated_page_count: 1
        }, {
            scene_number: 2,
            scene_heading: 'INT. KEEP ROOM - DAY',
            narrative_action: 'This scene should remain.',
            dramaturgical_function: 'The actual opening handoff.',
            estimated_page_count: 1
        }]
    }];
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify([]),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await reviseStage6Scenes(
        currentBlueprint,
        'Delete [INT. WRONG ROOM - DAY].',
        { generateContentFn }
    );

    assert.equal(calls.length, 1);
    assert.equal(result[0].scenes.length, 1);
    assert.equal(result[0].scenes[0].scene_heading, 'INT. KEEP ROOM - DAY');
    assert.equal(result[0].scenes[0].scene_number, 1);
});

test('Stage 6 revision retries when the first response produces no saved changes', async () => {
    const currentBlueprint = [{
        sequence_number: 1,
        sequence_title: 'Inside the Kaiju',
        total_estimated_pages: 8,
        scenes: [{
            scene_number: 1,
            scene_heading: 'INT. KAIJU PORCELAIN FLOOR - NIGHT',
            narrative_action: 'Slatern crosses porcelain and capes.',
            dramaturgical_function: 'Connective tissue.',
            estimated_page_count: 1
        }]
    }];
    const revisedSequence = {
        ...currentBlueprint[0],
        scenes: [{
            ...currentBlueprint[0].scenes[0],
            dramaturgical_function: 'Forces Slatern to confess that every preserved relic is another version of the mercy bargain he has avoided naming.'
        }]
    };
    const { calls, generateContentFn } = makeRecorder((request, callNumber) => ({
        text: callNumber === 1 ? JSON.stringify([]) : JSON.stringify([revisedSequence]),
        usage: { model: 'test-model', inputTokens: callNumber, outputTokens: callNumber }
    }));

    const { result, usage } = await reviseStage6Scenes(
        currentBlueprint,
        'Yes, refine Scene 1 so the porcelain floor has a real value shift.',
        { generateContentFn }
    );

    assert.equal(calls.length, 2);
    assert.match(collectText(calls[1].contents), /MANDATORY SECOND PASS/);
    assert.match(result[0].scenes[0].dramaturgical_function, /mercy bargain/);
    assert.equal(usage.length, 2);
});

test('Stage 6 revision final repair handles unchanged non-empty responses', async () => {
    const currentBlueprint = [{
        sequence_number: 1,
        sequence_title: 'Inside the Kaiju',
        total_estimated_pages: 8,
        scenes: [{
            scene_number: 1,
            scene_heading: 'INT. KAIJU PORCELAIN FLOOR - NIGHT',
            narrative_action: 'Slatern crosses porcelain and capes.',
            dramaturgical_function: 'Connective tissue.',
            estimated_page_count: 1
        }]
    }];
    const unchangedSequence = {
        ...currentBlueprint[0],
        scenes: [{ ...currentBlueprint[0].scenes[0] }]
    };
    const revisedSequence = {
        ...currentBlueprint[0],
        scenes: [{
            ...currentBlueprint[0].scenes[0],
            narrative_action: 'Slatern crosses porcelain and capes, but each cape now shows a child he once failed to protect.'
        }]
    };
    const { calls, generateContentFn } = makeRecorder((_request, callNumber) => ({
        text: JSON.stringify(callNumber < 3 ? [unchangedSequence] : [revisedSequence]),
        usage: { inputTokens: callNumber, outputTokens: callNumber }
    }));

    const { result, usage } = await reviseStage6Scenes(
        currentBlueprint,
        'Scene 1: make the cape chamber emotionally specific.',
        { generateContentFn }
    );

    assert.equal(calls.length, 3);
    assert.match(collectText(calls[1].contents), /MANDATORY SECOND PASS/);
    assert.match(collectText(calls[2].contents), /FINAL REPAIR PASS/);
    assert.match(result[0].scenes[0].narrative_action, /failed to protect/);
    assert.equal(usage.length, 3);
});

test('Stage 6 revision throws a specific no-change error after failed repair passes', async () => {
    const currentBlueprint = [{
        sequence_number: 1,
        sequence_title: 'Inside the Kaiju',
        total_estimated_pages: 8,
        scenes: [{
            scene_number: 1,
            scene_heading: 'INT. KAIJU PORCELAIN FLOOR - NIGHT',
            narrative_action: 'Slatern crosses porcelain and capes.',
            dramaturgical_function: 'Connective tissue.',
            estimated_page_count: 1
        }]
    }];
    const unchangedSequence = {
        ...currentBlueprint[0],
        scenes: [{ ...currentBlueprint[0].scenes[0] }]
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify([unchangedSequence]),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await assert.rejects(
        reviseStage6Scenes(
            currentBlueprint,
            'Scene 1: make the cape chamber emotionally specific.',
            { generateContentFn }
        ),
        error => error.code === 'NO_BLUEPRINT_CHANGES'
            && /after three attempts/.test(error.message)
    );
    assert.equal(calls.length, 3);
});

test('Stage 6 revision merges numeric sequence ids against string blueprint ids', async () => {
    const currentBlueprint = [{
        sequence_number: '7',
        sequence_title: 'Inside the Kaiju',
        total_estimated_pages: 8,
        scenes: [{
            scene_number: '57',
            scene_heading: 'INT. KAIJU PORCELAIN FLOOR - NIGHT',
            narrative_action: 'Slatern crosses porcelain and capes.',
            dramaturgical_function: 'Connective tissue.',
            estimated_page_count: 1
        }]
    }];
    const revisedSequence = {
        sequence_number: 7,
        sequence_title: 'Inside the Kaiju',
        total_estimated_pages: 8,
        scenes: [{
            scene_number: 57,
            scene_heading: 'INT. KAIJU PORCELAIN FLOOR - NIGHT',
            narrative_action: 'Slatern crosses porcelain and capes, but each object now mirrors a lie he preserved.',
            dramaturgical_function: 'Turns the chamber into pressure on Slatern rather than travelogue.',
            estimated_page_count: 1
        }]
    };
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify([revisedSequence]),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await reviseStage6Scenes(
        currentBlueprint,
        'Scene 57: add a value shift to the porcelain chamber.',
        { generateContentFn }
    );

    assert.equal(calls.length, 1);
    assert.match(result[0].scenes[0].narrative_action, /mirrors a lie/);
});

test('Stage 8 draft receives source packet, style, continuity, and scene context', async () => {
    const project = {
        data: {
            knowledge: {
                source_registry: [{
                    id: 'src_graphic_novel',
                    name: 'Graphic Novel.pdf',
                    type: 'source_reference',
                    tags: ['source_reference'],
                    summary: 'Mara keeps the blue key after the flooded arcade.',
                    text: 'Mara keeps the blue key after the flooded arcade and refuses to leave June behind.'
                }],
                source_bible: {
                    summary: 'Mara keeps the blue key after the flooded arcade.',
                    curated_notes: []
                },
                continuity_watchlist: ['The blue key stays with Mara.'],
                decision_log: [],
                accepted_divergences: [{ summary: 'Jules is renamed June.' }],
                stage_handoffs: {
                    stage6: { summary: 'Scene blueprint preserves the arcade climax.' }
                }
            }
        }
    };
    const packet = buildSourceGenerationPacket(project, 8, 'Mara enters the flooded arcade with the blue key.', {
        userMessage: 'Draft the flooded arcade scene.'
    });
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: 'INT. FLOODED ARCADE - NIGHT\nMara grips the blue key.',
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await generateSceneDraft({
        scene_number: 12,
        scene_heading: 'INT. FLOODED ARCADE - NIGHT',
        narrative_action: 'Mara enters with the blue key.',
        dramaturgical_function: 'Pays off source continuity.',
        estimated_page_count: 2,
        draft_text: 'Old draft.'
    }, {
        synopsis: 'Mara protects June.',
        characters
    }, 'Keep the source key moment.', {
        knowledgeContext: packet.contextBlock,
        generateContentFn
    }, 'Sparse dialogue and tense physical action.', '## CONTINUITY CONTEXT\nMara still has the blue key.', 'Previous scene handoff: Scene 11. Current scene to draft: Mara enters with the blue key. Next scene handoff: Scene 13.');

    assert.equal(calls.length, 1);
    assertSourceAwareCall(calls[0], 'Stage 8 Draft Scene');
    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /STYLE DIRECTIVES/);
    assert.match(promptText, /CONTINUITY CONTEXT/);
    assert.match(promptText, /SCENE LOCK PACKET/);
    assert.match(promptText, /SPECIFIC SCENE BLUEPRINT/);
});

test('Stage 9 coverage receives source packet and memory contract', async () => {
    let callCount = 0;
    const { calls, generateContentFn } = makeRecorder(() => {
        callCount += 1;
        if (callCount > 1) throw new Error('intentionally fail extra coverage passes');
        return {
            text: JSON.stringify({
                title: 'Arcade Night',
                genre: 'Thriller',
                logline: 'Mara searches a flooded arcade for the blue key.',
                evaluation_grid: {
                    concept: 'Good',
                    structure: 'Good',
                    characterization: 'Good',
                    pacing: 'Good',
                    dialogue: 'Good'
                },
                synopsis: {
                    setup: 'Mara enters the arcade.',
                    escalation: 'The water rises.',
                    resolution: 'Mara keeps the key.'
                },
                authenticity: { assessment: 'Mixed', red_flags: [] },
                source_alignment: {
                    assessment: 'Preserves the blue key.',
                    protected_elements: ['Mara keeps the blue key.'],
                    drift_risks: []
                },
                strengths: [{ headline: 'Protected lock', detail: 'The draft keeps the key with Mara.' }],
                weaknesses: [],
                macro_todo: [],
                micro_todo: [],
                recommendation: { grade: 'CONSIDER', justification: 'Promising and source-aligned.' }
            }),
            usage: { inputTokens: 1, outputTokens: 1 }
        };
    });

    await agent8Coverage('INT. FLOODED ARCADE - NIGHT\nMara grips the blue key.', {
        title: 'Arcade Night',
        genre: 'Thriller',
        logline: 'Mara searches for the key.',
        synopsis: 'Mara protects June.',
        characters
    }, {
        knowledgeContext: BASE_KNOWLEDGE_PACKET,
        generateContentFn
    });

    assert.equal(calls.length, 3);
    assertSourceAwareCall(calls[0], 'Stage 9 Coverage');
    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /PROJECT MEMORY AND SOURCE PACKET/);
    assert.match(promptText, /FULL SCREENPLAY/);
});

test('Stage 10 rewrite and planner prompts carry the memory contract', async () => {
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: 'INT. FLOODED ARCADE - NIGHT\nMara keeps the blue key.',
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    await rewriteScene(
        'INT. FLOODED ARCADE - NIGHT\nMara loses the key.',
        'MACRO TO-DO P1: Fix source continuity around the blue key.',
        {
            title: 'Arcade Night',
            sceneNumber: 12,
            slugline: 'INT. FLOODED ARCADE - NIGHT',
            characters: 'Mara: keeps source continuity visible.',
            blueprint: 'Current scene to draft: Mara keeps the blue key in the flooded arcade. Next scene handoff: June sees the key.'
        },
        'Keep the key with Mara.',
        {
            knowledgeContext: BASE_KNOWLEDGE_PACKET,
            generateContentFn
        },
        'Sparse dialogue and tense physical action.',
        'Full style reference text.'
    );

    assert.equal(calls.length, 1);
    assertSourceAwareCall(calls[0], 'Stage 10 Rewrite');
    const rewritePrompt = collectText(calls[0].contents);
    assert.match(rewritePrompt, /MACRO TO-DO P1/);
    assert.match(rewritePrompt, /PLANNED CHANGE FOR THIS SCENE/);
    assert.match(rewritePrompt, /APPROVED SCENE LOCKS/);
    assert.match(rewritePrompt, /Mara keeps the blue key in the flooded arcade/);
    assert.match(rewritePrompt, /STYLE DIRECTIVES/);
    assert.match(rewritePrompt, /CHARACTER PROFILES/);

    const plannerPrompt = buildStage10RewritePlanPrompt({
        sourceContext: BASE_KNOWLEDGE_PACKET,
        title: 'Arcade Night',
        charBlock: '\n\n## CHARACTERS\nMara (Lead): arc=protect June, drive=keep the blue key',
        styleNote: '\n\n## STYLE CONTEXT\nThe rewrite agent will maintain this style.',
        priorityTask: 'MACRO TO-DO P1: Fix source continuity around the blue key.',
        feedbackSection: '\n\n## WRITER NOTES ON SCOPE\nOnly fix scenes in the arcade thread.',
        contextSection: '\n\n## BRAINSTORM CONTEXT\nThe writer wants source alignment.',
        sceneList: 'SCENE 12 - INT. FLOODED ARCADE - NIGHT\nBlueprint: Mara enters with the blue key.\nDraft excerpt: Mara loses the key.'
    });
    const plannerSystem = buildStage10RewritePlannerSystemInstruction('Planner SOP');

    assert.match(plannerPrompt, /PROJECT MEMORY AND SOURCE PACKET/);
    assert.match(plannerPrompt, /Mara keeps the blue key/);
    assert.match(plannerPrompt, /MACRO TO-DO P1/);
    assert.match(plannerPrompt, /SCENE 12 - INT\. FLOODED ARCADE/);
    assert.match(plannerPrompt, /Blueprint: Mara enters with the blue key/);
    assert.match(plannerPrompt, /Draft excerpt: Mara loses the key/);
    assert.match(plannerSystem, /Planner SOP/);
    assert.match(plannerSystem, /MEMORY AND SOURCE CONTRACT/);
    assert.match(plannerSystem, /Stage 10 Rewrite Plan/);
});
