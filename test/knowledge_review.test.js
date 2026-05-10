const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ensureProjectKnowledge,
    persistChatAttachmentToKnowledge,
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
