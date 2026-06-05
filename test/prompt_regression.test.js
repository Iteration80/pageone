const test = require('node:test');
const assert = require('node:assert/strict');

const { agent2Outline, outlineHasContent } = require('../agents/agent_2_outline');
const { agent4Beats } = require('../agents/agent_4_beats');
const { agent5Treatment } = require('../agents/agent_5_treatment');
const { generateStage6Scenes } = require('../agents/agent_6_scenes');
const { reviseStage6Scenes } = require('../agents/agent_6_revise');
const { generateSceneDraft } = require('../agents/agent_8_draft');
const { agent8Coverage } = require('../agents/agent_9_coverage');
const { rewriteScene } = require('../agents/agent_10_rewrite');
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
    const notesBundle = `LATEST USER REQUEST:
Kitchen closing image
Photo of young Becky and Dapple framed in the light. Breakfast for three. Furdlegurr visible to both. Visitor passes for Dapple and Scott. That image should stay.

USER REQUESTS:
Stuff To Restore
Dapple's voluntary surrender
He shrinks, could run, sees Scott, chooses kindness, lets himself be cuffed.

Kitchen closing image
Photo of young Becky and Dapple framed in the light.

RECENT ASSISTANT CONTEXT:
On it — restoring the kitchen closing image to the end of Sequence H.

ASSISTANT DIRECTION:
On it — restoring the kitchen closing image to the end of Sequence H.`;
    const { calls, generateContentFn } = makeRecorder((_request, callIndex) => ({
        text: JSON.stringify(callIndex === 1 ? firstResponse : repairedResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, notesBundle, null, {
        model: 'gemini-test',
        geminiApiKey: 'test-key',
        generateContentFn
    });

    assert.equal(calls.length, 2);
    const firstPrompt = collectText(calls[0].contents);
    const repairPrompt = collectText(calls[1].contents);
    assert.match(firstPrompt, /ACTIVE REVISION REQUEST/);
    assert.match(firstPrompt, /BACKGROUND CONVERSATION NOTES \(context only/);
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

    const { result } = await agent2Outline(pitch, currentOutline, `LATEST USER REQUEST:
itchen closing image
Photo of young Becky and Dapple framed in the light. Breakfast for three. Furdlegurr visible to both. Visitor passes for Dapple and Scott. That image is doing a lot of emotional work and should absolutely stay. --> this is still missing; please restore.

USER REQUESTS:
Older request that should not become the active checklist.`, null, {
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

test('Stage 2 outline confirmation handoff verifies the prior concrete restore request', async () => {
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
    const notesBundle = `LATEST USER REQUEST:
yes

USER REQUESTS:
Kitchen closing image
Photo of young Becky and Dapple framed in the light. Breakfast for three. Furdlegurr visible to both. Visitor passes for Dapple and Scott. That image is doing a lot of emotional work and should absolutely stay. --> this is still missing; please restore.
yes

CONFIRMATION HANDOFF:
The latest user message is a short confirmation. Apply the most recent concrete revision proposal from RECENT ASSISTANT CONTEXT and RECENT CONVERSATION CONTEXT; do not treat the confirmation text alone as the full brief.

RECENT ASSISTANT CONTEXT:
The kitchen closing image has been consistently dropped from the saved outline. I am ready to restore that final emotional image.

RECENT CONVERSATION CONTEXT:
USER:
Kitchen closing image
Photo of young Becky and Dapple framed in the light. Breakfast for three. Furdlegurr visible to both. Visitor passes for Dapple and Scott. That image is doing a lot of emotional work and should absolutely stay. --> this is still missing; please restore.

---

ASSISTANT:
Want me to go ahead and restore that final beat to the outline now?

---

USER:
yes

ASSISTANT DIRECTION:
Apply the most recent concrete assistant revision proposal while preserving the user constraints in the latest confirmation.`;

    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(missingKitchenResponse),
        usage: { inputTokens: 1, outputTokens: 1 }
    }));

    const { result } = await agent2Outline(pitch, currentOutline, notesBundle, null, {
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
    const notes = `DIRECT USER REVISION REQUEST:
We've lost the following two beats in Seq H, please restore:

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

    assert.equal(calls.length, 2);
    const firstPrompt = collectText(calls[0].contents);
    assert.match(firstPrompt, /REVISION CHECKLIST/);
    assert.match(firstPrompt, /Aftermath - A New Order/);
    assert.match(firstPrompt, /Closing Image - The Photo on the Wall/);
    const finalText = JSON.stringify(result.outline.act_3[0].beats);
    assert.match(finalText, /Aftermath - A New Order/);
    assert.match(finalText, /Rebecca declines the badge/i);
    assert.match(finalText, /Kitchen Closing Image/);
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
    const notes = `DIRECT USER REVISION REQUEST:
Replace sequence H with these beats:

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
