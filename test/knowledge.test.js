const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Document, Packer, Paragraph } = require('docx');

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
    prepareGenerationUpload,
    persistChatAttachmentToKnowledge,
    recordAcceptedSourceDivergence,
    recordStageSourceAudit,
    recordSourcePlanUsage,
    refreshStageHandoff,
    applyStageCurationToKnowledge,
    sanitizeStageCurationProposal,
    sourceResponseExtras,
    sourceMemoryForResponse,
    isMemoryRecallRequest,
    buildMemoryRecallResponse,
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

test('source response extras expose short project memory provenance', () => {
    const project = {
        data: {
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
                continuity_watchlist: ['Mara keeps the blue key.'],
                decision_log: [],
                accepted_divergences: [{ summary: 'Jules is renamed June.' }],
                stage_handoffs: {
                    stage6: { summary: 'Scene blueprint keeps the key in the arcade.' }
                }
            }
        }
    };

    const packet = buildSourceGenerationPacket(project, 8, 'Draft the flooded arcade with the blue key.');
    const extras = sourceResponseExtras(packet);

    assert.ok(extras.sourceMemory);
    assert.equal(extras.sourceWarnings, undefined);
    assert.equal(extras.sourceMemory.stageId, 8);
    assert.equal(extras.sourceMemory.sources[0].name, 'Graphic Novel.pdf');
    assert.ok(extras.sourceMemory.handoffs.some(handoff => /Scene Blueprint/.test(handoff.stageName)));
    assert.ok(extras.sourceMemory.acceptedDivergences.some(item => /Jules is renamed June/.test(item)));
    assert.equal(sourceMemoryForResponse({}), undefined);
});

test('memory recall requests answer from compact project memory without transcript dependence', () => {
    const project = {
        data: {
            conversations: {
                stage2: [{ role: 'user', content: 'RAW CHAT SHOULD NOT BE THE ANSWER' }]
            },
            knowledge: {
                source_registry: [{
                    id: 'src_key',
                    name: 'Graphic Novel.pdf',
                    type: 'source_reference',
                    tags: ['source_reference'],
                    summary: 'Mara finds the blue key in the flooded arcade.',
                    text: 'Mara finds the blue key in the flooded arcade.'
                }],
                source_bible: { summary: 'Mara finds the blue key in the arcade.', curated_notes: [] },
                continuity_watchlist: ['Mara keeps the blue key.'],
                decision_log: [],
                accepted_divergences: [{ summary: 'Jules is renamed June.' }],
                stage_handoffs: {
                    stage3: { summary: 'Characters establish June as renamed Jules.' },
                    stage6: { summary: 'Scenes keep Mara holding the blue key.' }
                }
            }
        }
    };

    assert.equal(isMemoryRecallRequest('What do we already know about the blue key?'), true);
    const recall = buildMemoryRecallResponse(project, {
        stageId: 10,
        stageName: 'Rewrite',
        userMessage: 'What do we already know about the blue key?',
        stageData: 'Mara reaches the arcade.'
    });

    assert.match(recall.message, /compact project memory/);
    assert.match(recall.message, /Graphic Novel\.pdf/);
    assert.match(recall.message, /Scenes keep Mara holding the blue key/);
    assert.match(recall.message, /Jules is renamed June/);
    assert.doesNotMatch(recall.message, /RAW CHAT SHOULD NOT BE THE ANSWER/);
    assert.ok(recall.sourceMemory);
});

test('frontend restores Stage 10 rewrite chat from persisted stage9 conversation key', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    assert.match(appJs, /CONVO_TO_CHAT\s*=\s*\{[^}]*stage9:\s*10[^}]*\}/s);
    assert.match(appJs, /savedStage10Convo\s*=\s*window\.currentProjectData\?\.conversations\?\.stage9/);
    assert.match(appJs, /stage10Chat\.restoreHistory\(savedStage10Convo\)/);
    assert.match(appJs, /Saved to project knowledge for reuse across stages/);
    assert.match(appJs, /noteSourceMemoryUsed\(chat, data\.sourceMemory\)/);
    assert.match(appJs, /stage10CurrentScene !== null && !isMemoryRecallPrompt\(text\)/);
});

test('frontend keeps project memory usage under the hood instead of posting chat cards', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const match = appJs.match(/function noteSourceMemoryUsed\(chat, memory\) \{([\s\S]*?)\n    \}/);
    assert.ok(match, 'noteSourceMemoryUsed function should exist');
    assert.doesNotMatch(match[1], /chat\.append/);
    assert.match(appJs, /Using project memory/);
});

test('frontend project knowledge inspector exposes memory trust controls', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    assert.match(appJs, /data-action="run-source-check"/);
    assert.match(appJs, /Audit needs refresh because source material changed/);
    assert.match(appJs, /knowledge-handoff-status/);
    assert.match(appJs, /Missing handoff/);
    assert.match(appJs, /Stale handoff/);
    assert.match(appJs, /source-plan-ledger-invalidated/);
    assert.match(appJs, /Source check note/);
    assert.doesNotMatch(appJs, /Source Readiness Note/);
});

test('frontend chat attachment inputs advertise all supported source formats', () => {
    const indexHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
    const attachmentInputs = [...indexHtml.matchAll(/id="stage(?:[1-8]|10)-chat-attach" accept="([^"]+)"/g)];
    assert.equal(attachmentInputs.length, 8);
    for (const [, accept] of attachmentInputs) {
        for (const ext of ['.pdf', '.txt', '.md', '.fountain', '.docx', '.fdx']) {
            assert.ok(accept.includes(ext), `${accept} should include ${ext}`);
        }
    }

    assert.doesNotMatch(indexHtml, /id="stage7-chat-attach"/);

    for (const inputId of ['pdfUpload', 'sourceKnowledgeUpload', 'createStyleFiles', 'stage7-trained-files']) {
        const match = indexHtml.match(new RegExp(`id="${inputId}"[^>]*accept="([^"]+)"`));
        assert.ok(match, `${inputId} should have an accept attribute`);
        for (const ext of ['.pdf', '.txt', '.md', '.fountain', '.docx', '.fdx']) {
            assert.ok(match[1].includes(ext), `${inputId} should include ${ext}`);
        }
    }
    assert.match(indexHtml, /Attach Source/);
    assert.doesNotMatch(indexHtml, /Attach PDF/);
});

test('frontend Stage 7 offers four style paths and trained upload', () => {
    const indexHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const styleCss = fs.readFileSync(require.resolve('../public/style.css'), 'utf8');
    const styleSkill = fs.readFileSync(require.resolve('../skills/skill_stage7_style.md'), 'utf8');
    const humanizerJs = fs.readFileSync(require.resolve('../agents/agent_humanizer.js'), 'utf8');

    for (const label of ['Describe Style', 'Analyze Writing Sample', 'Use Saved Style', 'No Style']) {
        assert.match(indexHtml, new RegExp(label));
    }
    assert.match(indexHtml, /id="stage7-trained-panel"/);
    assert.match(appJs, /stage7GenerateTrainedFromUpload/);
    assert.match(appJs, /attachInputId: false/);
    assert.match(appJs, /styleTierLabel/);
    assert.match(appJs, /humanized_draft_text \|\| currentSceneData\.draft_text/);
    assert.match(humanizerJs, /PROJECT STYLE DIRECTIVES TO PRESERVE/);
    assert.match(styleCss, /style-tier-badge\.preset/);
    assert.match(styleSkill, /Tier 1 — Preset/);
    assert.match(styleSkill, /Style Builder Contract/);
});

test('Stage 3 character regeneration handles legacy cards and direct rebuild requests', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const agent3Js = fs.readFileSync(require.resolve('../agents/agent_3_characters.js'), 'utf8');

    assert.match(appJs, /normalizeStage3CharacterForEditor/);
    assert.match(appJs, /core\.false_belief/);
    assert.match(appJs, /core\.wound/);
    assert.match(appJs, /isStage3DirectRevisionRequest/);
    assert.match(appJs, /Applying those character changes now/);

    assert.match(agent3Js, /normalizeLegacyCharacter/);
    assert.match(agent3Js, /isFullCharacterRegenerationRequest/);
    assert.match(agent3Js, /LEGACY MODERNIZATION/);
    assert.match(agent3Js, /fresh character regeneration/);
});

test('frontend Stage 6 regenerate menu uses novice-facing labels and chat notes', () => {
    const indexHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    assert.match(indexHtml, /Fresh Blueprint/);
    assert.match(indexHtml, /Use Chat Notes/);
    assert.match(indexHtml, /Previous Version/);
    assert.doesNotMatch(indexHtml, /upstream/i);
    assert.match(appJs, /Regenerate the blueprint with these notes:/);
    assert.match(appJs, /shouldRegenerateStage6FromChat/);
    assert.match(appJs, /generateStage6\(\{ notes, isRegenerate: true/);
});

test('frontend Stage 6 chat directly executes structured revision memos and guards no-op revisions', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    assert.match(appJs, /function isStage6DirectRevisionRequest/);
    assert.match(appJs, /Number\(stageId\) === 6 && isStage6DirectRevisionRequest\(_text\)/);
    assert.match(appJs, /DIRECT USER REVISION REQUEST:/);
    assert.match(appJs, /function reviseStage6Blueprint/);
    assert.match(appJs, /'Accept': 'text\/event-stream'/);
    assert.match(appJs, /stream:\s*true/);
    assert.match(appJs, /readSSEStream\(response/);
    assert.match(appJs, /refreshCurrentProjectData\(\)/);
    assert.match(appJs, /recoveredFromMissingCompletion/);
    assert.match(appJs, /returned no blueprint changes/);
    assert.match(appJs, /latestIsConfirmation/);
    assert.match(appJs, /CONFIRMATION HANDOFF/);
    assert.match(appJs, /RECENT ASSISTANT CONTEXT/);
    assert.match(appJs, /RECENT CONVERSATION CONTEXT/);
    assert.match(serverJs, /stageKey: 'stage6_scenes'/);
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
        message: 'Outline has a fresh source check with no open findings.'
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
    assert.equal(sourceResponseExtras(packet).sourceWarnings, undefined);
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

test('prepareGenerationUpload extracts non-pdf stage uploads for direct generation', async () => {
    const project = { data: {} };
    const upload = {
        originalname: 'Arcade Source.md',
        mimetype: 'text/markdown',
        buffer: Buffer.from('# Arcade Source\nMara finds the blue key in the flooded arcade.')
    };

    const prepared = await prepareGenerationUpload(project, upload, {
        stageId: 1,
        userMessage: 'Use this source for the pitch.',
        forceTextBlock: true
    });

    assert.equal(prepared.agentFile, null);
    assert.match(prepared.textBlock, /UPLOADED SOURCE FILE: Arcade Source\.md/);
    assert.match(prepared.textBlock, /Mara finds the blue key/);

    const source = project.data.knowledge.source_registry[0];
    assert.equal(source.name, 'Arcade Source.md');
    assert.match(source.text, /flooded arcade/);
    assert.ok(source.tags.includes('stage_upload'));
    assert.ok(source.tags.includes('stage1'));
    assert.ok(source.tags.includes('markdown'));
});

test('persistChatAttachmentToKnowledge extracts markdown, fountain, docx, and fdx chat uploads', async () => {
    const project = { data: {} };
    const docx = new Document({
        sections: [{
            children: [new Paragraph('Docx source says Mara keeps the blue key.')]
        }]
    });
    const docxBuffer = await Packer.toBuffer(docx);
    const fdxText = `<?xml version="1.0" encoding="UTF-8"?>
<FinalDraft>
  <TitlePage><Content><Paragraph><Text>Blue Key</Text></Paragraph></Content></TitlePage>
  <Content>
    <Paragraph Type="Scene Heading"><Text>INT. FLOODED ARCADE - NIGHT</Text></Paragraph>
    <Paragraph Type="Action"><Text>Mara finds the blue key in the flooded arcade.</Text></Paragraph>
  </Content>
</FinalDraft>`;
    const attachments = [
        ['Notes.md', 'text/markdown', '# Source Notes\nMara marks the arcade map.'],
        ['Sample.fountain', 'text/x-fountain', 'Title: Sample\n\nINT. ARCADE - NIGHT\nMara opens the cabinet.'],
        ['Draft.fdx', 'application/xml', fdxText],
        ['Source.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docxBuffer]
    ];

    for (const [name, mimeType, content] of attachments) {
        await persistChatAttachmentToKnowledge(project, {
            name,
            mimeType,
            data: Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content).toString('base64')
        }, { stageId: 2, userMessage: `Upload ${name}` });
    }

    const sources = project.data.knowledge.source_registry;
    assert.equal(sources.length, 4);
    assert.match(sources.find(source => source.name === 'Notes.md').text, /arcade map/);
    assert.match(sources.find(source => source.name === 'Sample.fountain').text, /Mara opens the cabinet/);
    assert.match(sources.find(source => source.name === 'Draft.fdx').text, /Mara finds the blue key/);
    assert.match(sources.find(source => source.name === 'Source.docx').text, /Mara keeps the blue key/);
    assert.ok(sources.find(source => source.name === 'Notes.md').tags.includes('markdown'));
    assert.ok(sources.find(source => source.name === 'Draft.fdx').tags.includes('screenplay'));
    assert.ok(sources.find(source => source.name === 'Source.docx').tags.includes('docx'));
});

test('source lifecycle memory contract runs without browser, live AI, or route binding', async () => {
    const project = {
        data: {
            stage1_pitch: {
                pitch: {
                    title: 'Blue Key',
                    logline: 'Mara searches a flooded arcade for a key.'
                }
            },
            stage2_outline: {
                outline: [{
                    sequence_number_and_title: 'Act I - Flooded Arcade',
                    beats: [{
                        beat_label: 'Key Discovery',
                        description: 'Mara pockets a red key in the flooded arcade.'
                    }]
                }]
            },
            knowledge: {}
        }
    };
    const sourceUpload = await persistChatAttachmentToKnowledge(project, {
        name: 'Smoke Source.txt',
        mimeType: 'text/plain',
        data: Buffer.from('Mara finds the blue key in the flooded arcade and keeps it through the escape.').toString('base64')
    }, {
        stageId: 2,
        userMessage: 'Source canon for the key.'
    });
    assert.equal(sourceUpload.savedSource.duplicate, false);

    const stageData = JSON.stringify(project.data.stage2_outline, null, 2);
    const usedPlan = buildSourceUsePlan(project, 2, stageData);
    const planEntry = recordSourcePlanUsage(project, 2, stageData, 'deterministic_lifecycle_test', usedPlan);
    assert.equal(planEntry.sourceIds.length, 1);
    assert.ok(project.data.knowledge.decision_log.some(item => item.type === 'source_plan_used'));

    const audit = {
        stageId: 2,
        stageName: 'Outline',
        checkedAt: '2026-05-10T16:00:00.000Z',
        aligned_items: ['The outline keeps the key discovery in the flooded arcade.'],
        possible_source_mismatches: ['Outline says red key, but source canon says blue key.'],
        missing_source_elements: [],
        recommended_fixes: ['Either make the key blue again or explicitly accept the red-key divergence.']
    };
    const auditRef = {
        sourceId: sourceUpload.savedSource.id,
        name: 'Smoke Source.txt',
        excerpt: 'Mara finds the blue key in the flooded arcade.'
    };
    recordStageSourceAudit(project, 2, 'Outline', stageData, audit, [auditRef], { sourceCount: 1 });
    assert.equal(buildSourceReadiness(project, 2, stageData).status, 'issues');

    const divergence = recordAcceptedSourceDivergence(project, {
        stageId: 2,
        summary: 'Accepted source divergence: the outline temporarily uses a red key, while source canon remains blue.',
        audit
    }, {
        now: '2026-05-10T16:05:00.000Z',
        divergenceId: 'div_lifecycle_smoke'
    });
    assert.equal(divergence.id, 'div_lifecycle_smoke');
    assert.equal(buildSourceReadiness(project, 2, stageData).status, 'resolved');

    applyStageCurationToKnowledge(project, {
        stageId: 2,
        proposal: {
            handoff_summary: 'Outline handoff: Mara finds the blue key in the flooded arcade; the accepted red-key divergence is approved only as a tracked departure.',
            continuity_watchlist_additions: ['Track the key color whenever the arcade sequence changes.'],
            source_bible_notes: ['Source canon says the key is blue and located in the flooded arcade.'],
            decision_summary: 'Curated Stage 2 memory after source lifecycle audit.'
        }
    }, {
        now: '2026-05-10T16:06:00.000Z',
        stageData
    });

    const snapshot = buildKnowledgeSnapshot(project, { now: '2026-05-10T16:07:00.000Z' });
    assert.match(snapshot.summary, /blue key/i);
    assert.ok(snapshot.stageHandoffs.some(item => /flooded arcade/i.test(item.summary)));
    assert.ok(snapshot.acceptedDivergences.some(item => /red key/i.test(String(item))));
    assert.ok(project.data.knowledge.decision_log.some(item => item.type === 'stage_memory_curated'));

    const recall = buildMemoryRecallResponse(project, {
        stageId: 3,
        stageName: 'Characters',
        userMessage: 'What do we already know about the blue key?',
        stageData: 'Mara is carrying the key.'
    });
    assert.match(recall.message, /compact project memory/);
    assert.match(recall.message, /Smoke Source\.txt/);
    assert.match(recall.message, /flooded arcade/i);
    assert.match(recall.message, /red-key divergence|red key/i);

    const packet = buildSourceGenerationPacket(project, 8, 'Draft scene: Mara studies the key.', {
        userMessage: 'Keep source canon straight even if the current draft says red key.'
    });
    assert.match(packet.contextBlock, /Accepted Source Divergences/);
    assert.match(packet.contextBlock, /Relevant Source Documents/);
    assert.match(packet.contextBlock, /Smoke Source\.txt/);
    assert.match(packet.contextBlock, /source canon says the key is blue/i);
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
