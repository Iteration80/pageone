const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildKnowledgeDiagnostics,
    buildSourceReadiness,
    ensureProjectKnowledge,
    persistChatAttachmentToKnowledge,
    recordStageSourceAudit,
    recordSourcePlanUsage,
    removeKnowledgeSource,
    updateKnowledgeReview,
    updateKnowledgeSourceMetadata
} = require('../server');

test('project knowledge review sanitizes manual edits and refreshes compact memory', async () => {
    const now = '2026-05-10T12:00:00.000Z';
    const project = {
        id: '1779000000000',
        title: 'Knowledge Review Test',
        data: {
            stage1_pitch: {
                pitch: {
                    title: 'Blue Key',
                    synopsis: 'Mara finds a blue key in a flooded arcade.'
                }
            },
            knowledge: {
                source_registry: [],
                source_bible: { summary: '', curated_notes: ['Old note'] },
                continuity_watchlist: ['Old continuity'],
                decision_log: [],
                accepted_divergences: [],
                stage_handoffs: {
                    stage1: { at: '2026-01-01T00:00:00.000Z', type: 'stage_approved_handoff', summary: 'Old handoff.' },
                    stage2: { at: '2026-01-01T00:00:00.000Z', type: 'stage_approved_handoff', summary: 'Remove by omission.' }
                }
            }
        }
    };

    await persistChatAttachmentToKnowledge(project, {
        name: 'Source Notes.txt',
        mimeType: 'text/plain',
        data: Buffer.from('Mara finds the blue key under the flooded arcade cabinet.').toString('base64')
    }, {
        userMessage: 'Core project source upload.',
        originTag: 'project_upload'
    });
    const sourceId = ensureProjectKnowledge(project).source_registry[0].id;
    const source = updateKnowledgeSourceMetadata(project, sourceId, {
        type: 'development_notes',
        tags: ['Canon Tag', 'source_reference']
    }, { now });

    assert.equal(source.type, 'development_notes');
    assert.deepEqual(source.tags, ['canontag', 'notes']);

    const knowledge = updateKnowledgeReview(project, {
        stage_handoffs: {
            stage1: 'Pitch establishes Mara, the flooded arcade, and the blue key.',
            stage11: 'Invalid stage should not persist.',
            junk: 'Invalid key should not persist.'
        },
        continuity_watchlist: ['Mara keeps the blue key.', '', 'Mara keeps the blue key.'],
        curated_notes: ['Stage 1: Keep the arcade key discovery.', '']
    }, { now });

    assert.equal(knowledge.stage_handoffs.stage1.type, 'manual_memory_review');
    assert.equal(knowledge.stage_handoffs.stage1.at, now);
    assert.equal(knowledge.stage_handoffs.stage1.summary, 'Pitch establishes Mara, the flooded arcade, and the blue key.');
    assert.equal(knowledge.stage_handoffs.stage2, undefined);
    assert.equal(knowledge.stage_handoffs.stage11, undefined);
    assert.equal(knowledge.stage_handoffs.junk, undefined);
    assert.deepEqual(knowledge.continuity_watchlist, ['Mara keeps the blue key.']);
    assert.deepEqual(knowledge.source_bible.curated_notes, ['Stage 1: Keep the arcade key discovery.']);
    assert.ok(knowledge.decision_log.some(item => item.type === 'project_memory_review_updated'));
    assert.match(knowledge.memory_snapshot.summary, /blue key/i);
    assert.match(knowledge.source_bible.sources_summary, /Source Notes\.txt/);
});

test('removing a source invalidates cached plans and audits that referenced it', async () => {
    const now = '2026-05-10T13:00:00.000Z';
    const project = {
        id: '1779000000001',
        title: 'Knowledge Delete Test',
        data: {
            stage1_pitch: {
                pitch: {
                    title: 'Blue Key',
                    synopsis: 'Mara finds the blue key in the flooded arcade.'
                }
            },
            knowledge: {}
        }
    };

    await persistChatAttachmentToKnowledge(project, {
        name: 'Blue Key Source.txt',
        mimeType: 'text/plain',
        data: Buffer.from('Mara finds the blue key under the flooded arcade cabinet.').toString('base64')
    }, { originTag: 'project_upload' });
    await persistChatAttachmentToKnowledge(project, {
        name: 'Lantern Source.txt',
        mimeType: 'text/plain',
        data: Buffer.from('June waits outside the arcade with a brass lantern.').toString('base64')
    }, { originTag: 'project_upload' });

    const knowledge = ensureProjectKnowledge(project);
    const removedSourceId = knowledge.source_registry.find(source => source.name === 'Blue Key Source.txt').id;
    const stageData = JSON.stringify(project.data.stage1_pitch, null, 2);
    const plan = recordSourcePlanUsage(project, 1, stageData, 'generation');
    recordStageSourceAudit(project, 1, 'Pitch', stageData, {
        checkedAt: '2026-05-10T12:30:00.000Z',
        aligned_items: ['The pitch preserves the blue key source fact.'],
        possible_source_mismatches: [],
        missing_source_elements: [],
        recommended_fixes: []
    }, plan.sourceReferences, { sourceCount: 2 });

    assert.equal(buildSourceReadiness(project, 1, stageData).status, 'ready');
    assert.ok(knowledge.stage_source_plans.stage1.sourceIds.includes(removedSourceId));
    assert.ok(knowledge.stage_source_audits.stage1.sourceReferences.some(ref => ref.sourceId === removedSourceId));

    const removed = removeKnowledgeSource(project, removedSourceId, { now });
    const updated = ensureProjectKnowledge(project);
    const readiness = buildSourceReadiness(project, 1, stageData);
    const diagnostics = buildKnowledgeDiagnostics(project);
    const issueKinds = diagnostics.issues.map(issue => issue.kind);

    assert.equal(removed.name, 'Blue Key Source.txt');
    assert.equal(updated.source_registry.length, 1);
    assert.deepEqual(updated.source_bible.sourceIds, [updated.source_registry[0].id]);
    assert.equal(updated.stage_source_plans.stage1.invalidatedAt, now);
    assert.equal(updated.stage_source_audits.stage1.invalidatedAt, now);
    assert.ok(!updated.stage_source_plans.stage1.sourceIds.includes(removedSourceId));
    assert.ok(!updated.stage_source_audits.stage1.sourceReferences.some(ref => ref.sourceId === removedSourceId));
    assert.equal(readiness.status, 'needs_audit');
    assert.equal(readiness.isAuditInvalidated, true);
    assert.ok(issueKinds.includes('source_plan_invalidated'));
    assert.ok(issueKinds.includes('source_audit_invalidated'));
    assert.ok(updated.decision_log.some(item => item.type === 'source_removed' && item.sourceId === removedSourceId));
});
