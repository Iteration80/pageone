const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
    buildKnowledgeSnapshot,
    ensureProjectKnowledge,
    buildKnowledgeContextBlock,
    buildKnowledgeDiagnostics,
    buildSourceGenerationPacket,
    buildSourceReadiness,
    buildSourceReadinessGate,
    buildSourceReadinessList,
    buildSourceAuditFixNotes,
    buildSourceUsePlan,
    compactAuditForKnowledge,
    compactProjectKnowledge,
    formatSourceUsePlan,
    persistChatAttachmentToKnowledge,
    recordStageSourceAudit,
    recordSourcePlanUsage,
    refreshStageHandoff,
    sanitizeStageCurationProposal,
    sourceBibleSummary,
    sourceAuditHasActionableItems,
    stageSourceProfile,
    updateKnowledgeSourceMetadata
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
    assert.deepEqual(knowledge.stage_source_plans, {});
    assert.deepEqual(knowledge.stage_source_audits, {});
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
    assert.match(context, /Compact Memory Snapshot/);
    assert.ok(context.indexOf('Compact Memory Snapshot') < context.indexOf('Relevant Source Documents'));
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

test('source audit fix notes include only actionable audit buckets', () => {
    const audit = {
        stageId: 6,
        stageName: 'Scene Blueprint',
        aligned_items: ['Arcade location is present.'],
        possible_source_mismatches: ['Scene 12 moves the key to the pier, but the source keeps it in the arcade.'],
        missing_source_elements: [],
        recommended_fixes: ['Keep the blue key discovery in the arcade.']
    };

    const notes = buildSourceAuditFixNotes(audit, { stageId: 6, stageName: 'Scene Blueprint' });

    assert.equal(sourceAuditHasActionableItems(audit), true);
    assert.match(notes, /Possible source mismatches/);
    assert.match(notes, /Recommended fixes/);
    assert.doesNotMatch(notes, /Arcade location is present/);
    assert.equal(sourceAuditHasActionableItems({ aligned_items: ['ok'] }), false);
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

test('buildSourceUsePlan applies stage-specific retrieval and accepted divergences', () => {
    const project = {
        data: {
            knowledge: {
                source_registry: [
                    {
                        id: 'src_plot',
                        name: 'Plot Source.pdf',
                        type: 'source_reference',
                        tags: ['source_reference'],
                        summary: 'The climax happens in the arcade.',
                        text: 'The climax happens in the arcade after Mara chooses to save Jules.'
                    },
                    {
                        id: 'src_style',
                        name: 'Style Sample.fountain',
                        type: 'style_reference',
                        tags: ['style'],
                        summary: 'Sparse dialogue and visual restraint.',
                        text: 'Sparse dialogue. Visual restraint. Long silent beats.'
                    }
                ],
                source_bible: { summary: 'Mara saves Jules.', curated_notes: [] },
                continuity_watchlist: ['Mara keeps the blue key.'],
                decision_log: [],
                accepted_divergences: [{ summary: 'Jules is renamed June.' }],
                stage_handoffs: {
                    stage8: { summary: 'Draft scenes should preserve the arcade climax.' }
                }
            }
        }
    };

    const plan = buildSourceUsePlan(project, 8, 'Mara enters the arcade with the blue key.');
    const text = formatSourceUsePlan(plan);

    assert.equal(stageSourceProfile(8).label, 'Draft scene execution');
    assert.equal(plan.profile, 'Draft scene execution');
    assert.equal(plan.usesMemorySnapshot, true);
    assert.ok(plan.sourceReferences.some(ref => ref.sourceId === 'src_plot'));
    assert.match(text, /SOURCE-FIRST GENERATION PLAN/);
    assert.match(text, /Compact Memory Snapshot/);
    assert.match(text, /Jules is renamed June/);
    assert.match(text, /arcade climax/);
});

test('stage 7 memory context treats style references as tonal guidance, not source canon', () => {
    const project = {
        data: {
            knowledge: {
                source_registry: [
                    {
                        id: 'src_story',
                        name: 'Blue Key Source.pdf',
                        type: 'source_reference',
                        tags: ['source_reference'],
                        summary: 'Mara finds the blue key in the flooded arcade.',
                        text: 'Mara finds the blue key in the flooded arcade before escaping with June.'
                    },
                    {
                        id: 'src_style',
                        name: 'Sparse Style Sample.fountain',
                        type: 'style_reference',
                        tags: ['style'],
                        summary: 'Sparse dialogue, long silences, and tactile dread.',
                        text: 'Sparse dialogue. Long silences. Tactile dread around machines and water.'
                    }
                ],
                source_bible: { summary: 'The blue key belongs to Mara.', curated_notes: [] },
                continuity_watchlist: [],
                decision_log: [],
                accepted_divergences: [],
                stage_handoffs: {}
            }
        }
    };

    const context = buildKnowledgeContextBlock(project, {
        stageId: 7,
        userMessage: 'What style should this use?',
        stageName: 'Style',
        stageData: 'Use a sparse voice for the flooded arcade.'
    });
    const planText = formatSourceUsePlan(buildSourceUsePlan(project, 7, 'Style voice for the flooded arcade.'));

    assert.match(context, /Source Type Boundary/);
    assert.match(context, /Style references are tonal guidance only/);
    assert.match(context, /Sparse Style Sample\.fountain/);
    assert.match(context, /Blue Key Source\.pdf/);
    assert.match(planText, /Style Reference Boundary/);
    assert.match(planText, /do not treat them as source canon/);
});

test('cross-stage source packet prefers compact handoffs over raw chat transcript', () => {
    const handoffs = {};
    for (let stageId = 1; stageId <= 6; stageId += 1) {
        handoffs[`stage${stageId}`] = {
            at: `2026-05-0${stageId}T00:00:00.000Z`,
            summary: `Stage ${stageId} handoff keeps Mara, June, and the flooded arcade aligned.`
        };
    }
    handoffs.stage6.summary = 'Scene Blueprint locks Scene 12 in the flooded arcade with Mara keeping the blue key.';

    const project = {
        data: {
            conversations: {
                stage1: [{ role: 'user', content: 'RAW CHAT SHOULD NOT BECOME MEMORY' }]
            },
            knowledge: {
                source_registry: [{
                    id: 'src_key',
                    name: 'Graphic Novel.pdf',
                    type: 'source_reference',
                    tags: ['source_reference'],
                    summary: 'Mara finds the blue key in the flooded arcade.',
                    text: 'Mara finds the blue key in the flooded arcade and refuses to abandon June.'
                }],
                source_bible: { summary: 'Mara keeps the blue key.', curated_notes: [] },
                continuity_watchlist: ['Mara keeps the blue key through the arcade escape.'],
                decision_log: [],
                accepted_divergences: [{ summary: 'Jules is renamed June.' }],
                stage_handoffs: handoffs
            }
        }
    };

    const packet = buildSourceGenerationPacket(project, 8, 'Draft Scene 12 in the flooded arcade.', {
        userMessage: 'Draft the next scene from memory.'
    });

    assert.match(packet.contextBlock, /Compact Memory Snapshot/);
    assert.match(packet.contextBlock, /Stage Handoffs/);
    assert.match(packet.contextBlock, /Stage 1 handoff keeps Mara/);
    assert.match(packet.contextBlock, /Scene Blueprint locks Scene 12/);
    assert.match(packet.contextBlock, /Jules is renamed June/);
    assert.doesNotMatch(packet.contextBlock, /RAW CHAT SHOULD NOT BECOME MEMORY/);
    assert.ok(packet.contextBlock.length < 16_000);
});

test('frontend restores Stage 10 rewrite chat from persisted stage9 conversation key', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    assert.match(appJs, /CONVO_TO_CHAT\s*=\s*\{[^}]*stage9:\s*10[^}]*\}/s);
    assert.match(appJs, /savedStage10Convo\s*=\s*window\.currentProjectData\?\.conversations\?\.stage9/);
    assert.match(appJs, /stage10Chat\.restoreHistory\(savedStage10Convo\)/);
});

test('recordSourcePlanUsage caches used plan and exposes stale state', () => {
    const project = {
        data: {
            knowledge: {
                source_registry: [{
                    id: 'src_plot',
                    name: 'Plot Source.pdf',
                    type: 'source_reference',
                    tags: ['source_reference'],
                    summary: 'The arcade climax matters.',
                    text: 'Mara saves Jules in the arcade climax.'
                }],
                source_bible: { summary: 'Mara saves Jules.', curated_notes: [] },
                continuity_watchlist: [],
                decision_log: [],
                accepted_divergences: [],
                stage_handoffs: {}
            }
        }
    };

    const usedPlan = buildSourceUsePlan(project, 6, 'Blueprint focuses on the arcade climax.');
    const entry = recordSourcePlanUsage(project, 6, 'Generated blueprint output.', 'generation', usedPlan);
    const freshPlan = buildSourceUsePlan(project, 6, 'Generated blueprint output.');
    const stalePlan = buildSourceUsePlan(project, 6, 'Edited blueprint output.');

    assert.equal(entry.stageId, 6);
    assert.equal(entry.memorySnapshotUsed, true);
    assert.equal(freshPlan.freshness, 'used');
    assert.equal(stalePlan.freshness, 'stale');
    assert.equal(project.data.knowledge.stage_source_plans.stage6.sourceIds[0], 'src_plot');
    assert.equal(project.data.knowledge.stage_source_plans.stage6.memorySnapshotUsed, true);
    assert.ok(project.data.knowledge.decision_log.some(item => item.type === 'source_plan_used'));
});

test('buildSourceReadiness reports stale, unresolved, and resolved audit state', () => {
    const project = {
        data: {
            stage6_scenes: [{
                sequence_title: 'Arcade',
                scenes: [{ scene_number: 1, scene_heading: 'INT. ARCADE', narrative_action: 'Mara finds the key.', dramaturgical_function: 'Discovery' }]
            }],
            knowledge: {
                source_registry: [{
                    id: 'src_plot',
                    name: 'Plot Source.pdf',
                    type: 'source_reference',
                    tags: ['source_reference'],
                    summary: 'The key is in the arcade.',
                    text: 'Mara finds the blue key in the arcade.'
                }],
                source_bible: { summary: 'The key is in the arcade.', curated_notes: [] },
                continuity_watchlist: [],
                decision_log: [],
                accepted_divergences: [],
                stage_handoffs: {}
            }
        }
    };

    const stageData = JSON.stringify(project.data.stage6_scenes, null, 2);
    const audit = {
        checkedAt: '2026-01-01T00:00:00.000Z',
        possible_source_mismatches: ['The key moved to the pier.'],
        missing_source_elements: [],
        recommended_fixes: ['Keep the key in the arcade.']
    };

    recordStageSourceAudit(project, 6, 'Scene Blueprint', stageData, audit, [], { sourceCount: 1 });

    assert.equal(buildSourceReadiness(project, 6).status, 'issues');
    project.data.stage6_scenes[0].scenes[0].narrative_action = 'Mara finds the key at the pier.';
    assert.equal(buildSourceReadiness(project, 6).status, 'stale');
    project.data.knowledge.decision_log.push({
        at: '2026-01-02T00:00:00.000Z',
        type: 'source_audit_fixes_applied',
        stageId: 6,
        summary: 'Fixed source issue.'
    });
    assert.equal(buildSourceReadiness(project, 6).status, 'fixed_since_audit');
    assert.ok(buildSourceReadinessList(project).some(item => item.stageId === 6));
});

test('buildSourceReadinessGate avoids AI audits when saved readiness is fresh', () => {
    assert.deepEqual(buildSourceReadinessGate({ status: 'ready', stageName: 'Outline' }), {
        action: 'proceed',
        severity: 'ok',
        canProceed: true,
        shouldRunAudit: false,
        message: 'Outline has a fresh source audit with no open findings.'
    });
    assert.equal(buildSourceReadinessGate({ status: 'issues', stageName: 'Scenes' }).action, 'resolve_audit');
    assert.equal(buildSourceReadinessGate({ status: 'stale', stageName: 'Treatment' }).shouldRunAudit, true);
    assert.equal(buildSourceReadinessGate({ status: 'needs_audit', stageName: 'Pitch' }).action, 'run_audit');
    assert.equal(buildSourceReadinessGate({ status: 'no_sources', stageName: 'Style' }).canProceed, true);
});

test('buildSourceGenerationPacket includes source contract without recording usage', () => {
    const project = {
        data: {
            stage1_pitch: { pitch: { title: 'Blue Key', synopsis: 'Mara finds a key.' } },
            knowledge: {
                source_registry: [{
                    id: 'src_key',
                    name: 'Graphic Novel.pdf',
                    type: 'source_reference',
                    tags: ['source_reference'],
                    summary: 'Mara finds the blue key in the arcade.',
                    text: 'The blue key is hidden in the flooded arcade before Mara escapes.'
                }],
                source_bible: { summary: 'The key is in the arcade.', curated_notes: [], sourceIds: ['src_key'] },
                continuity_watchlist: [],
                decision_log: [],
                accepted_divergences: [],
                stage_handoffs: {},
                stage_source_plans: {},
                stage_source_audits: {}
            }
        }
    };

    const packet = buildSourceGenerationPacket(project, 2, 'Mara moves through the arcade.');

    assert.equal(packet.stageId, 2);
    assert.equal(packet.readiness.status, 'needs_audit');
    assert.ok(packet.warnings.some(item => item.includes('no recorded source audit')));
    assert.match(packet.contextBlock, /SOURCE READINESS/);
    assert.match(packet.contextBlock, /Graphic Novel\.pdf/);
    assert.deepEqual(project.data.knowledge.stage_source_plans, {});
    assert.deepEqual(project.data.knowledge.decision_log, []);
});

test('persistChatAttachmentToKnowledge supports direct project upload tagging and dedupe', async () => {
    const project = { data: {} };
    const attachment = {
        name: 'Source Notes.txt',
        mimeType: 'text/plain',
        data: Buffer.from('Mara finds a blue key under the arcade cabinet.').toString('base64')
    };

    const first = await persistChatAttachmentToKnowledge(project, attachment, {
        userMessage: 'Core source upload',
        originTag: 'project_upload'
    });
    const second = await persistChatAttachmentToKnowledge(project, attachment, {
        stageId: 4,
        userMessage: 'Duplicate through stage chat'
    });

    const knowledge = project.data.knowledge;
    assert.equal(first.savedSource.duplicate, false);
    assert.equal(second.savedSource.duplicate, true);
    assert.equal(knowledge.source_registry.length, 1);
    assert.ok(knowledge.source_registry[0].tags.includes('project_upload'));
    assert.ok(knowledge.source_registry[0].tags.includes('chat_upload'));
    assert.deepEqual(knowledge.source_registry[0].stagesReferenced, [4]);
});

test('updateKnowledgeSourceMetadata retags a saved source and records the decision', () => {
    const project = {
        data: {
            knowledge: {
                source_registry: [{
                    id: 'src_notes',
                    name: 'Notes.txt',
                    type: 'source_reference',
                    tags: ['source_reference', 'project_upload', 'messy tag!'],
                    summary: 'Development notes.',
                    text: 'Mara keeps the blue key.'
                }],
                source_bible: { summary: '', curated_notes: [] },
                continuity_watchlist: [],
                decision_log: [],
                accepted_divergences: [],
                stage_handoffs: {}
            }
        }
    };

    const source = updateKnowledgeSourceMetadata(project, 'src_notes', {
        type: 'development_notes',
        tags: ['project_upload', 'Story Notes', 'source_reference']
    }, { now: '2026-01-03T00:00:00.000Z' });

    assert.equal(source.type, 'development_notes');
    assert.deepEqual(source.tags, ['project_upload', 'storynotes', 'notes']);
    assert.equal(source.updatedAt, '2026-01-03T00:00:00.000Z');
    assert.match(project.data.knowledge.source_bible.sources_summary, /development_notes/);
    assert.ok(project.data.knowledge.decision_log.some(item => item.type === 'source_metadata_updated'));
});

test('compactProjectKnowledge dedupes memory and builds assistant snapshot', () => {
    const project = {
        data: {
            stage1_pitch: { pitch: { title: 'Blue Key', synopsis: 'Mara finds a key.' } },
            knowledge: {
                source_registry: [{ id: 'src_key', name: 'Source', summary: 'Blue key canon.' }],
                source_bible: {
                    summary: 'Mara finds the blue key.',
                    canon_facts: ['The blue key is in the arcade.', 'The blue key is in the arcade.'],
                    curated_notes: ['Stage 2: Keep the key.', 'Stage 2: Keep the key.']
                },
                continuity_watchlist: ['Mara keeps the key.', 'Mara keeps the key.'],
                decision_log: [
                    { type: 'note', stageId: 1, summary: 'Keep key.' },
                    { type: 'note', stageId: 1, summary: 'Keep key.' }
                ],
                accepted_divergences: [
                    { summary: 'Jules becomes June.' },
                    { summary: 'Jules becomes June.' }
                ],
                stage_handoffs: {
                    stage1: { summary: 'Pitch approved. Mara finds a blue key.' },
                    junk: { summary: 'Remove me.' }
                }
            }
        }
    };

    const knowledge = compactProjectKnowledge(project, { now: '2026-05-09T12:00:00.000Z' });

    assert.deepEqual(knowledge.source_bible.canon_facts, ['The blue key is in the arcade.']);
    assert.deepEqual(knowledge.source_bible.curated_notes, ['Stage 2: Keep the key.']);
    assert.deepEqual(knowledge.continuity_watchlist, ['Mara keeps the key.']);
    assert.equal(knowledge.decision_log.length, 1);
    assert.equal(knowledge.accepted_divergences.length, 1);
    assert.ok(knowledge.stage_handoffs.stage1);
    assert.equal(knowledge.stage_handoffs.junk, undefined);
    assert.match(knowledge.memory_snapshot.summary, /Mara finds the blue key/);
    assert.equal(knowledge.memory_snapshot.stageHandoffs.length, 1);
});

test('refreshStageHandoff stores compact fallback handoff for approval', () => {
    const project = { data: { knowledge: {} } };
    const handoff = refreshStageHandoff(
        project,
        2,
        { outline: [{ sequence_number_and_title: 'Act I', beats: [{ beat_label: 'Opening', description: 'Mara finds the blue key.' }] }] },
        { now: '2026-05-09T12:00:00.000Z' }
    );
    const snapshot = buildKnowledgeSnapshot(project, { now: '2026-05-09T12:00:00.000Z' });

    assert.match(handoff.summary, /Outline approved/);
    assert.match(project.data.knowledge.stage_handoffs.stage2.summary, /Mara finds the blue key/);
    assert.ok(project.data.knowledge.decision_log.some(item => item.type === 'stage_auto_handoff'));
    assert.equal(snapshot.stageHandoffs[0].stageId, 2);
});
