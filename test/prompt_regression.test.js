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
    assert.match(promptText, /full-target-context/);
});

test('Stage 6 revision retries when the first response produces no saved changes', async () => {
    const currentBlueprint = [{
        sequence_number: 7,
        sequence_title: 'Inside the Kaiju',
        total_estimated_pages: 8,
        scenes: [{
            scene_number: 57,
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
        'Yes, refine Scene 57 so the porcelain floor has a real value shift.',
        { generateContentFn }
    );

    assert.equal(calls.length, 2);
    assert.match(collectText(calls[1].contents), /MANDATORY SECOND PASS/);
    assert.match(result[0].scenes[0].dramaturgical_function, /mercy bargain/);
    assert.equal(usage.length, 2);
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
