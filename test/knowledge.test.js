const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ensureProjectKnowledge,
    buildKnowledgeContextBlock,
    buildKnowledgeDiagnostics,
    compactAuditForKnowledge,
    sanitizeStageCurationProposal,
    sourceBibleSummary
} = require('../server');

test('ensureProjectKnowledge initializes persistent memory buckets without clobbering notes', () => {
    const project = {
        data: {
            knowledge: {
                source_bible: {
                    summary: 'Canon summary',
                    curated_notes: ['Stage 2: Adaptation note']
                }
            }
        }
    };

    const knowledge = ensureProjectKnowledge(project);

    assert.deepEqual(knowledge.source_bible.curated_notes, ['Stage 2: Adaptation note']);
    assert.deepEqual(knowledge.source_registry, []);
    assert.deepEqual(knowledge.accepted_divergences, []);
    assert.deepEqual(knowledge.stage_handoffs, {});
});

test('knowledge context includes accepted divergences and relevant source provenance', () => {
    const project = {
        data: {
            knowledge: {
                source_registry: [{
                    id: 'src_1',
                    name: 'Graphic Novel.pdf',
                    type: 'source_reference',
                    summary: 'Mara finds the blue key in the flooded arcade.',
                    text: 'Mara finds the blue key in the flooded arcade and refuses to leave Jules behind.'
                }],
                source_bible: {
                    summary: 'Mara and Jules are central.',
                    curated_notes: ['Stage 3: Jules is combined with June for the adaptation.']
                },
                accepted_divergences: [{
                    summary: 'Accepted combining Jules and June into one screenplay character.'
                }],
                continuity_watchlist: [],
                decision_log: [],
                stage_handoffs: {}
            }
        }
    };

    const context = buildKnowledgeContextBlock(project, {
        stageId: 3,
        userMessage: 'What should we do with Jules?',
        stageName: 'Characters',
        stageData: 'Jules appears as June.'
    });

    assert.match(context, /Graphic Novel\.pdf/);
    assert.match(context, /Accepted Source Divergences/);
    assert.match(context, /combining Jules and June/);
    assert.match(sourceBibleSummary(project.data.knowledge), /Project Adaptation Notes/);
});

test('compactAuditForKnowledge bounds noisy audit payloads', () => {
    const audit = {
        stageId: 4,
        stageName: 'Beats',
        aligned_items: Array.from({ length: 12 }, (_, i) => `aligned ${i}`),
        possible_source_mismatches: ['x'.repeat(900)],
        missing_source_elements: ['missing'],
        recommended_fixes: ['fix']
    };

    const compact = compactAuditForKnowledge(audit);

    assert.equal(compact.aligned_items.length, 5);
    assert.ok(compact.possible_source_mismatches[0].length < 650);
    assert.equal(compact.stageName, 'Beats');
});

test('sanitizeStageCurationProposal provides safe fallback text', () => {
    const proposal = sanitizeStageCurationProposal({}, {
        stageId: 5,
        stageName: 'Treatment',
        stageData: 'A very small treatment.'
    });

    assert.equal(proposal.stageId, 5);
    assert.match(proposal.handoff_summary, /Treatment approved/);
    assert.deepEqual(proposal.continuity_watchlist_additions, []);
});

test('buildKnowledgeDiagnostics flags memory gaps and duplicate divergences', () => {
    const project = {
        data: {
            stage1_pitch: { pitch: { title: 'Test' } },
            versionHistory: [{ stage: 1, approvedAt: '2026-01-02T00:00:00.000Z' }],
            knowledge: {
                source_registry: [],
                source_bible: { summary: '', curated_notes: [] },
                continuity_watchlist: [],
                decision_log: [],
                stage_handoffs: {},
                accepted_divergences: [
                    { summary: 'Keep the invented ending.' },
                    { summary: 'Keep the invented ending.' }
                ]
            }
        }
    };

    const diagnostics = buildKnowledgeDiagnostics(project);
    const kinds = diagnostics.issues.map(issue => issue.kind);

    assert.ok(kinds.includes('no_sources'));
    assert.ok(kinds.includes('missing_stage_handoff'));
    assert.ok(kinds.includes('duplicate_divergence'));
});
