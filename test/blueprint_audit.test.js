const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    parseFunctionDeclarations,
    nominateRedundant,
    nominateNoShift,
    nominateOverloaded,
    nominateAll,
    hashBlueprintScenes,
    formatAuditFlagsForCoverage
} = require('../utils/blueprint_audit');
const {
    AUDIT_VERDICT_SCHEMA,
    AUDIT_DEFENSE_SCHEMA,
    adjudicateCandidates
} = require('../agents/agent_scene_audit');
const { agent8Coverage } = require('../agents/agent_9_coverage');

function scene(scene_number, dramaturgical_function, extras = {}) {
    return {
        scene_number,
        scene_heading: `INT. ROOM ${scene_number}`,
        narrative_action: `Scene ${scene_number} action.`,
        dramaturgical_function,
        estimated_page_count: 1,
        ...extras
    };
}

function sequences(scenes) {
    return [{ sequence_number: 1, sequence_title: 'Sequence One', scenes }];
}

test('Stage 6 necessity markers parse round-trip from dramaturgical_function', () => {
    const parsed = parseFunctionDeclarations(scene(1, `Structural purpose: expose the lie.
VALUE SHIFT: protected (+) to exposed (-)
SETS UP: the blue key, paid off in Scene 7
PAYS OFF: the diner lie, planted in Scene 1
UNIQUE JOB: Mara realizes the key is safer with June than with her.`));

    assert.equal(parsed.valueShift, 'protected (+) to exposed (-)');
    assert.equal(parsed.setsUp, 'the blue key, paid off in Scene 7');
    assert.equal(parsed.paysOff, 'the diner lie, planted in Scene 1');
    assert.equal(parsed.uniqueJob, 'Mara realizes the key is safer with June than with her.');
});

test('quiet-function scenes are not nominated as no-shift filler', () => {
    const result = nominateNoShift(sequences([
        scene(1, `Structural purpose: process the explosion.
QUIET FUNCTION: aftermath
UNIQUE JOB: The team absorbs the cost before choosing the next risk.`)
    ]));
    assert.deepEqual(result, []);
});

test('legacy scenes without markers are nominated unless organic VALUE SHIFT prose exists', () => {
    const result = nominateNoShift(sequences([
        scene(1, 'Structural Purpose: Mara talks through the plan without a turn.'),
        scene(2, 'Structural Purpose: The value shift is confidence (+) to doubt (-).')
    ]));
    assert.deepEqual(result.map(item => item.scene_number), [1]);
});

test('redundant nominee finds highly similar function lines conservatively', () => {
    const result = nominateRedundant(sequences([
        scene(1, `VALUE SHIFT: confident (+) to shaken (-)
UNIQUE JOB: Mara discovers the arcade key betrayal and loses trust in June.`),
        scene(2, `VALUE SHIFT: hopeful (+) to suspicious (-)
UNIQUE JOB: Mara discovers the arcade key betrayal and loses trust in June again.`)
    ]), { threshold: 0.45 });
    assert.equal(result.length, 1);
    assert.equal(result[0].scene_number, 2);
    assert.equal(result[0].counterpart_scene, 1);
    assert.ok(result[0].sharedTerms.includes('arcade'));
});

test('overload nominee counts named beats and event-class verbs', () => {
    const result = nominateOverloaded(sequences([
        scene(1, `VALUE SHIFT: trapped (-) to armed (+)
Structural purpose: Midpoint reveal, betrayal, escape, capture, and final image all happen here.
UNIQUE JOB: Too many turns are stacked into one room.`)
    ]));
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'overloaded');
    assert.ok(result[0].jobCount >= 3);
});

test('nominateAll merges deterministic candidates without mutating scenes', () => {
    const input = sequences([
        scene(1, 'Structural Purpose: no declared turn.'),
        scene(2, `VALUE SHIFT: calm (+) to afraid (-)
UNIQUE JOB: Mara discovers the arcade key betrayal and loses trust in June.`),
        scene(3, `VALUE SHIFT: calm (+) to afraid (-)
UNIQUE JOB: Mara discovers the arcade key betrayal and loses trust in June.`)
    ]);
    const before = JSON.stringify(input);
    const result = nominateAll(input, { threshold: 0.45 });
    assert.ok(result.some(item => item.type === 'no_shift'));
    assert.ok(result.some(item => item.type === 'redundant'));
    assert.equal(JSON.stringify(input), before);
});

function makeAuditResponder(responses) {
    let index = 0;
    return async () => {
        const response = responses[index++];
        if (response instanceof Error) throw response;
        return {
            text: JSON.stringify(response),
            usage: { model: 'mock-audit', inputTokens: 1, outputTokens: 1 }
        };
    };
}

test('adjudication records no flag when prosecutor acquits', async () => {
    const candidate = nominateNoShift(sequences([scene(1, 'Structural Purpose: no turn.')]))[0];
    const result = await adjudicateCandidates(sequences([candidate.scene]), [candidate], {
        model: 'mock',
        generateContentFn: makeAuditResponder([
            { verdict: 'acquit', evidence: 'The scene has a quiet purpose.' }
        ])
    });
    assert.deepEqual(result.flags, []);
});

test('adjudication records no flag when defense proves the scene survives', async () => {
    const candidate = nominateNoShift(sequences([scene(1, 'Structural Purpose: no turn.')]))[0];
    const result = await adjudicateCandidates(sequences([candidate.scene]), [candidate], {
        model: 'mock',
        generateContentFn: makeAuditResponder([
            { verdict: 'confirm', evidence: 'No value shift is declared.' },
            { scene_survives: true, justification: 'The next scene depends on this aftermath beat.' }
        ])
    });
    assert.deepEqual(result.flags, []);
});

test('adjudication records a flag only when prosecutor confirms and defense fails', async () => {
    const candidate = nominateNoShift(sequences([scene(1, 'Structural Purpose: no turn.')]))[0];
    const result = await adjudicateCandidates(sequences([candidate.scene]), [candidate], {
        model: 'mock',
        generateContentFn: makeAuditResponder([
            { verdict: 'confirm', evidence: 'No value shift or quiet function.' },
            { scene_survives: false, justification: 'Cutting it changes nothing in the sequence.' }
        ])
    });
    assert.equal(result.flags.length, 1);
    assert.equal(result.flags[0].type, 'no_shift');
    assert.equal(result.flags[0].dismissed, false);
});

test('defense rescues connective tissue even if a quiet aftermath scene was nominated', async () => {
    const aftermath = scene(1, `QUIET FUNCTION: aftermath
UNIQUE JOB: The team absorbs the betrayal before choosing to continue.`);
    const candidate = {
        type: 'no_shift',
        scene_number: 1,
        scene: aftermath,
        evidence: 'Forced nominee for regression coverage.',
        parsedDeclarations: parseFunctionDeclarations(aftermath)
    };
    const result = await adjudicateCandidates(sequences([aftermath]), [candidate], {
        model: 'mock',
        generateContentFn: makeAuditResponder([
            { verdict: 'confirm', evidence: 'No explicit value shift.' },
            { scene_survives: true, justification: 'The aftermath processes fallout and motivates the next scene.' }
        ])
    });
    assert.deepEqual(result.flags, []);
});

test('audit schemas stay compact', () => {
    const countNodes = node => {
        if (!node || typeof node !== 'object') return 0;
        return 1 + Object.values(node).reduce((sum, value) => sum + countNodes(value), 0);
    };
    assert.ok(countNodes(AUDIT_VERDICT_SCHEMA) < 15);
    assert.ok(countNodes(AUDIT_DEFENSE_SCHEMA) < 15);
});

test('audit code does not write to blueprint scenes or sequences', () => {
    const sources = [
        fs.readFileSync(path.join(__dirname, '..', 'utils', 'blueprint_audit.js'), 'utf8'),
        fs.readFileSync(path.join(__dirname, '..', 'agents', 'agent_scene_audit.js'), 'utf8')
    ].join('\n');
    assert.doesNotMatch(sources, /\.scenes\s*=/);
    assert.doesNotMatch(sources, /\.sequences\s*=/);
    assert.doesNotMatch(sources, /\bsplice\s*\(/);
});

test('dismissed flags are excluded from the coverage injection block', async () => {
    const block = formatAuditFlagsForCoverage({
        flags: [
            { scene_number: 41, type: 'redundant', counterpart_scene: 33, evidence: 'Repeats the same trust beat.', dismissed: false },
            { scene_number: 42, type: 'no_shift', evidence: 'Dismissed by writer.', dismissed: true }
        ]
    });
    assert.match(block, /Scene 41 REDUNDANT with Scene 33/);
    assert.doesNotMatch(block, /Scene 42/);

    const prompts = [];
    let calls = 0;
    const coverageResponse = {
        title: 'T',
        genre: 'Drama',
        logline: 'A logline.',
        evaluation_grid: { concept: 'Good', structure: 'Good', characterization: 'Good', pacing: 'Good', dialogue: 'Good' },
        synopsis: { setup: 's', escalation: 'e', resolution: 'r' },
        authenticity: { assessment: 'Highly Authentic / Human', red_flags: [] },
        strengths: [],
        weaknesses: [],
        macro_todo: [],
        micro_todo: [],
        recommendation: { grade: 'CONSIDER', justification: 'j' }
    };
    await agent8Coverage('FADE IN.', { title: 'T', characters: [] }, {
        model: 'mock',
        stage6AuditBlock: block,
        generateContentFn: async request => {
            calls += 1;
            prompts.push(Array.isArray(request.contents) ? request.contents.join('\n') : String(request.contents || ''));
            if (calls > 1) throw new Error('Only one mock coverage run succeeds.');
            return { text: JSON.stringify(coverageResponse), usage: { model: 'mock-coverage', inputTokens: 1, outputTokens: 1 } };
        }
    });
    assert.match(prompts[0], /BLUEPRINT-STAGE DRAMATURGICAL FLAGS/);
    assert.match(prompts[0], /Scene 41 REDUNDANT/);
    assert.doesNotMatch(prompts[0], /Scene 42/);
});

test('empty report is explicitly valid in the audit skill', () => {
    const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'skill_scene_audit.md'), 'utf8');
    assert.match(skill, /An empty report is a valid report/);
});

test('blueprint audit hash changes only when normalized blueprint fields change', () => {
    const first = sequences([scene(1, 'VALUE SHIFT: calm (+) to afraid (-)\nUNIQUE JOB: turn.')]);
    const second = JSON.parse(JSON.stringify(first));
    second[0].scenes[0].draft_text = 'Draft text does not affect blueprint audit staleness.';
    assert.equal(hashBlueprintScenes(first), hashBlueprintScenes(second));
    second[0].scenes[0].dramaturgical_function += '\nPAYS OFF: a prior plant.';
    assert.notEqual(hashBlueprintScenes(first), hashBlueprintScenes(second));
});
