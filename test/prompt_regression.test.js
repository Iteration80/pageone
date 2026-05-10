const test = require('node:test');
const assert = require('node:assert/strict');

const { agent5Treatment } = require('../agents/agent_5_treatment');
const { generateStage6Scenes } = require('../agents/agent_6_scenes');
const { reviseStage6Scenes } = require('../agents/agent_6_revise');
const { generateSceneDraft } = require('../agents/agent_8_draft');
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
    calls.forEach(call => assertSourceAwareCall(call, 'Stage 5 Treatment'));
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
    const { calls, generateContentFn } = makeRecorder(() => ({
        text: JSON.stringify(currentBlueprint),
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
    }, 'Sparse dialogue and tense physical action.', '## CONTINUITY CONTEXT\nMara still has the blue key.');

    assert.equal(calls.length, 1);
    assertSourceAwareCall(calls[0], 'Stage 8 Draft Scene');
    const promptText = collectText(calls[0].contents);
    assert.match(promptText, /STYLE DIRECTIVES/);
    assert.match(promptText, /CONTINUITY CONTEXT/);
    assert.match(promptText, /SPECIFIC SCENE BLUEPRINT/);
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
            characters: 'Mara: keeps source continuity visible.'
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
        sceneList: 'SCENE 12 - INT. FLOODED ARCADE - NIGHT'
    });
    const plannerSystem = buildStage10RewritePlannerSystemInstruction('Planner SOP');

    assert.match(plannerPrompt, /PROJECT MEMORY AND SOURCE PACKET/);
    assert.match(plannerPrompt, /Mara keeps the blue key/);
    assert.match(plannerPrompt, /MACRO TO-DO P1/);
    assert.match(plannerPrompt, /SCENE 12 - INT\. FLOODED ARCADE/);
    assert.match(plannerSystem, /Planner SOP/);
    assert.match(plannerSystem, /MEMORY AND SOURCE CONTRACT/);
    assert.match(plannerSystem, /Stage 10 Rewrite Plan/);
});
