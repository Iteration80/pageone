const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    readKnowledgeSourceAssetForClient,
    upgradeLegacyProjectKnowledge,
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
    buildStage4CurrentEventListResponse,
    stage4CurrentEventListTerm,
    buildStage4ConfirmationBypassResponse,
    extractNumberedSourceItems,
    buildSourceItemInventoryBlock,
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

test('brainstorm route returns JSON 404 when the active project file is missing', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const brainstormRoute = serverSource.match(/app\.post\('\/api\/brainstorm'[\s\S]*?app\.post\('\/api\/brainstorm-rewrite'/)?.[0] || '';

    assert.match(brainstormRoute, /catch\s*\{\s*return res\.status\(404\)\.json\(\{ error: 'Project not found' \}\);/);
});

test('unknown API routes return JSON 404 diagnostics', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    assert.match(serverSource, /app\.use\('\/api', \(req, res\) => \{/);
    assert.match(serverSource, /res\.status\(404\)\.json\(\{ error: `API route not found: \$\{req\.method\} \$\{req\.originalUrl\}` \}\);/);
    assert.match(serverSource, /const BUILD_COMMIT = process\.env\.RAILWAY_GIT_COMMIT_SHA/);
    assert.match(serverSource, /commit: BUILD_COMMIT/);
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
    const indexHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
    assert.match(indexHtml, /id="btnSourceLibrary" class="sidebar-home-btn" title="Project Knowledge" aria-label="Project Knowledge"/);
    assert.doesNotMatch(indexHtml, /id="btnSourceLibrary"[^>]*hidden/);
    assert.match(indexHtml, /id="sourceReaderPanel"/);
    assert.match(indexHtml, /Memory &amp; Diagnostics|Memory & Diagnostics/);
    assert.match(appJs, /data-action="run-source-check"/);
    assert.match(appJs, /source-library-read/);
    assert.match(appJs, /source-library-open-original/);
    assert.match(appJs, /\/knowledge\/sources\/\$\{encodeURIComponent\(sourceId\)\}\/assets\/\$\{encodeURIComponent\(assetKind\)\}/);
    assert.match(appJs, /Audit needs refresh because source material changed/);
    assert.match(appJs, /knowledge-handoff-status/);
    assert.match(appJs, /Missing handoff/);
    assert.match(appJs, /Stale handoff/);
    assert.match(appJs, /source-plan-ledger-invalidated/);
    assert.match(appJs, /Source check note/);
    assert.doesNotMatch(appJs, /Source Readiness Note/);
});

test('frontend keeps sidebar project controls in one footer row', () => {
    const styleCss = fs.readFileSync(require.resolve('../public/style.css'), 'utf8');
    assert.match(styleCss, /\.sidebar-footer\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s);
    assert.match(styleCss, /\.sidebar-footer \.sidebar-home-btn\s*\{[^}]*aspect-ratio:\s*1/s);
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

test('Claude client streams long Opus requests used by Stage 3 characters', () => {
    const aiClient = fs.readFileSync(require.resolve('../agents/ai-client.js'), 'utf8');
    assert.match(aiClient, /client\.messages\.stream\(request\)/);
    assert.match(aiClient, /stream\.finalMessage\(\)/);
    assert.match(aiClient, /maxTokens >= 32000/);
    assert.match(aiClient, /model === 'claude-opus-4-7'/);
});

test('Stage 3 assistant chat stays inside character-profile boundaries', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    assert.match(serverJs, /STAGE 3 CHARACTER BOUNDARY/);
    assert.match(serverJs, /ghost\/wound, lie, desire/);
    assert.match(serverJs, /Do NOT prescribe sequence-level or scene-level plot placement/);
    assert.match(serverJs, /mid-story regression/);
    assert.match(serverJs, /Stage 3 execution means updating character profiles only/);
});

test('Stage 2 outline generation supports streamed assistant revisions', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    assert.match(serverJs, /app\.post\('\/api\/generate-outline'/);
    assert.match(serverJs, /text\/event-stream/);
    assert.match(serverJs, /: keep-alive\\n\\n/);
    assert.match(serverJs, /type: 'complete'/);
    assert.match(appJs, /function consumeOutlineGenerationResponse/);
    assert.match(appJs, /function recoverOutlineFromInterruptedStream/);
    assert.match(appJs, /function isLikelyStreamTransportError/);
    assert.match(appJs, /readSSEStream\(response/);
    assert.match(appJs, /serverStreamError/);
    assert.match(appJs, /recoveredFromInterruptedStream/);
    assert.match(appJs, /previousOutline/);
    assert.match(appJs, /Outline stream was interrupted before the server responded/);
    assert.match(appJs, /Outline stream was interrupted before the server sent a completion event/);
    assert.match(appJs, /Outline stream ended before the server sent a completion event/);
    assert.match(appJs, /'Accept': 'text\/event-stream'/);
    assert.match(appJs, /formData\.append\('stream', 'true'\)/);
    assert.match(serverJs, /buildOutlineRevisionChecklist\(notesWithUpload\)/);
    assert.match(serverJs, /extractExplicitOutlineSequenceReplacement\(notesWithUpload\)/);
    assert.match(serverJs, /applyExplicitOutlineSequenceReplacement\(outlineData, explicitSequenceReplacement\)/);
    assert.match(serverJs, /appendMissingOutlineChecklistBeats\(outlineData, missingChecklistItems\)/);
    assert.match(serverJs, /createRevisionTransaction\({[\s\S]*stageId: 'stage2_outline'/);
    assert.match(serverJs, /assertRevisionTransactionVerified\(revisionTransaction, 'Stage 2 outline'\)/);
    assert.match(serverJs, /recordArtifactMutation\(projectData, \{[\s\S]*stage: 2/);
    assert.match(serverJs, /snapshotIds: snapshotEntries\.map\(entry => entry\.id\)/);
    assert.match(serverJs, /const changed = !notesWithUpload \|\| revisionTransaction\.changed/);
    assert.match(serverJs, /Stage 2 outline save verification failed/);
    assert.match(serverJs, /saveVerified: true/);
    assert.match(appJs, /changed: !revisionReceiptFailed\(data\)[\s\S]*revisionReceiptChanged\(data\)[\s\S]*JSON\.stringify\(currentBeats\) !== JSON\.stringify\(data\.result\?\.outline \|\| \{\}\)/);
});

test('server and frontend preserve working artifact snapshots beyond approvals', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    assert.match(serverJs, /require\('\.\/utils\/artifact_snapshots'\)/);
    assert.match(serverJs, /recordStageMutationSnapshots/);
    assert.match(serverJs, /recordExportSnapshot\(project, projectId, exportStage/);
    assert.match(serverJs, /mergeVersionHistory\(previousData\.versionHistory, updates\.data\.versionHistory\)/);
    assert.match(serverJs, /restoreVersionId/);
    assert.match(appJs, /snapshotType: 'approved'/);
    assert.match(appJs, /async function refreshCurrentProjectData/);
    assert.match(appJs, /await refreshCurrentProjectData\(\)/);
    assert.match(appJs, /restoreVersionId: version\.id/);
    assert.match(appJs, /versionPreviewCompare/);
    assert.match(appJs, /CURRENT SAVED ARTIFACT/);
});

test('frontend Stage 4 labels beats separately from Stage 5 treatment', () => {
    const indexHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const stage4Html = indexHtml.match(/<main id="stage-4-view"[\s\S]*?<main id="stage-5-view"/)?.[0] || '';
    const stage4App = appJs.match(/=== Stage 4: Beats Logic ===[\s\S]*?--- Stage 5: Treatment Functions ---/)?.[0] || '';

    assert.match(stage4Html, /Stage 4: Beats/);
    assert.match(stage4Html, />Generate Beats</);
    assert.doesNotMatch(stage4Html, />Generate Treatment</);
    assert.match(stage4App, /generating the beat sheet/);
    assert.match(stage4App, /Generate Beats button/);
    assert.doesNotMatch(stage4App, /generating the treatment/);
    assert.doesNotMatch(stage4App, /revising the treatment/);
});

test('Stage 4 chat treats current beat evidence as newer than stale analysis history', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');

    assert.match(serverJs, /function buildStage4CurrentBeatEvidenceBlock/);
    assert.match(serverJs, /CURRENT STAGE 4 BEAT EVIDENCE/);
    assert.match(serverJs, /overrides earlier Stage 4 chat messages/);
    assert.match(serverJs, /Do not repeat an earlier assistant claim unless the current evidence supports it/);
    assert.match(serverJs, /function isStage4CurrentArtifactAnalysisRequest/);
    assert.match(serverJs, /CURRENT ARTIFACT ANALYSIS MODE/);
    assert.match(serverJs, /messages\.filter\(m => m\.role === 'user'\)\.slice\(-1\)/);
    assert.match(serverJs, /persistStageConversation\(filePath, projectData, `stage\$\{stageId\}`, messagesForPrompt, result\.message\)/);
    assert.match(serverJs, /delete projectData\.data\.conversations\.stage4/);

    assert.match(appJs, /function resetStageChatForNewArtifact/);
    assert.match(appJs, /Beat sheet regenerated\. Previous Stage 4 chat was cleared/);
});

test('Stage 4 current event list questions are answered without model analysis', () => {
    const project = {
        data: {
            stage4_beats: {
                hybrid_beat_sheet: [{
                    sequence_number: 4,
                    sequence_title: 'Fairview Dinner',
                    beats: [{
                        beat_name: 'Midpoint',
                        detailed_action: 'Slatern realizes Scott is Dapple at the dinner table.'
                    }]
                }, {
                    sequence_number: 6,
                    sequence_title: 'Code Wendy',
                    beats: [{
                        beat_name: 'All Is Lost',
                        detailed_action: 'The Kaiju swallows Slatern after Code Wendy escalates beyond control.'
                    }]
                }]
            }
        }
    };

    assert.equal(
        stage4CurrentEventListTerm('List every Kaiju-related event by sequence and beat name from the current beat sheet only.'),
        'Kaiju'
    );

    const response = buildStage4CurrentEventListResponse(project, 'List every Kaiju-related event by sequence and beat name from the current beat sheet only.');
    assert.equal(response.suggest_plan, false);
    assert.match(response.message, /current Stage 4 beat sheet only/);
    assert.match(response.message, /Sequence 6: Code Wendy — All Is Lost/);
    assert.match(response.message, /Kaiju swallows Slatern/);
    assert.doesNotMatch(response.message, /Sequence 4/);
});

test('frontend stage chat re-enables controls after stuck assistant requests', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

    assert.match(appJs, /function withChatTimeout/);
    assert.match(appJs, /ms = 10 \* 60 \* 1000/);
    assert.match(appJs, /Assistant request timed out\. Try again in a moment\./);
    assert.match(appJs, /await withChatTimeout\(onSend\(text, this\.history, attachment\)\)/);
    assert.match(appJs, /this\.setDisabled\(false\);\s*this\.input\.focus\(\);/);
    assert.match(appJs, /chat\.clear\(\);\s*chat\.setDisabled\(false\);/);
});

test('Stage 4 revision confirmations bypass brainstorm model and SSE stays alive', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const response = buildStage4ConfirmationBypassResponse([
        {
            role: 'assistant',
            content: "Want me to work that Sequence 5 change into the beat sheet?"
        },
        {
            role: 'user',
            content: "I'm ok with you revising it as long as the change improves the movie's flow and stays faithful to the source spiritually."
        }
    ]);
    const retryResponse = buildStage4ConfirmationBypassResponse([
        {
            role: 'assistant',
            content: "Want me to work that Sequence 5 change into the beat sheet?"
        },
        {
            role: 'user',
            content: "I'm ok with you revising it as long as the change improves the movie's flow and stays faithful to the source spiritually."
        },
        {
            role: 'assistant',
            content: 'Error: Application failed to respond'
        },
        {
            role: 'user',
            content: "I'm ok with you revising it as long as the change improves the movie's flow and stays faithful to the source spiritually."
        }
    ]);

    assert.equal(response.execute_immediately, true);
    assert.equal(retryResponse.execute_immediately, true);
    assert.equal(response.suggest_plan, true);
    assert.match(response.message, /Stage 4 revision/);
    assert.match(appJs, /function isRevisionConfirmation/);
    assert.match(appJs, /function isRevisionStatusQuestion/);
    assert.match(appJs, /if \(isRevisionStatusQuestion\(clean\)\) return false;/);
    assert.match(appJs, /function findRecentRevisionProposal/);
    assert.match(appJs, /function isAssistantErrorMessage/);
    assert.match(appJs, /executeRevision && !attachment && isRevisionConfirmation\(_text, history\)/);
    assert.match(serverJs, /function buildStage4ConfirmationBypassResponse/);
    assert.match(serverJs, /function findRecentStage4RevisionProposal/);
    assert.match(serverJs, /buildStage4ConfirmationBypassResponse\(messages\)/);
    assert.match(serverJs, /req\.path === '\/app\.js'/);
    assert.match(serverJs, /Cache-Control', 'no-store, max-age=0'/);
    assert.match(serverJs, /X-Accel-Buffering', 'no'/);
    assert.match(serverJs, /type: 'heartbeat'/);
    assert.match(serverJs, /res\.flush\?\.\(\)/);
    assert.match(serverJs, /Failed to generate beats: \$\{detail\}/);
});

test('frontend Stage 2 chat directly applies outline revision memos and rejects status questions', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

    assert.match(appJs, /function isStage2DirectRevisionRequest/);
    assert.match(appJs, /Number\(stageId\) === 2 && isStage2DirectRevisionRequest\(_text\)/);
    assert.match(appJs, /DIRECT USER REVISION REQUEST:/);
    assert.match(appJs, /Applying those outline changes now/);
    assert.match(appJs, /outline revision failed/);
    assert.doesNotMatch(appJs, /saved outline came back unchanged/);
    assert.match(appJs, /function isRevisionStatusQuestion/);
    assert.match(appJs, /did you\|did it\|really\|actually/);
    assert.match(appJs, /if \(isRevisionStatusQuestion\(clean\)\) return false;/);
    assert.match(appJs, /function revisionReceiptChanged/);
    assert.match(appJs, /function revisionReceiptFailed/);
    assert.match(appJs, /revisionReceiptChanged\(data\)/);
});

test('stage chat source-audit questions do not execute stale pending revisions', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const sourceItems = extractNumberedSourceItems(`1.3 — Elliot at school playground. Elliot plays with Furdlegurr.
1.4 — Pono recruits Furdlegurr. Pono leaves a threat.
4.2 — Blounder shields Slatern.`);
    const inventory = buildSourceItemInventoryBlock(`1.3 — Elliot at school playground. Elliot plays with Furdlegurr.
1.4 — Pono recruits Furdlegurr. Pono leaves a threat.`);

    assert.deepEqual(sourceItems.map(item => item.id), ['1.3', '1.4', '4.2']);
    assert.match(inventory, /1\.3: Elliot at school playground/);
    assert.match(inventory, /1\.4: Pono recruits Furdlegurr/);
    assert.match(appJs, /const asksForAnalysis = \/\[\?\]\/\.test\(clean\)/);
    assert.match(appJs, /if \(asksForAnalysis\) return false;/);
    assert.match(appJs, /if \(pendingRevision && !attachment && isRevisionConfirmation\(_text, history\)\)/);
    assert.match(appJs, /if \(pendingRevision\) \{\s*pendingRevision = false;\s*pendingNotes = '';/);
    assert.match(appJs, /executeRevision && !attachment && isRevisionConfirmation\(_text, history\)/);
    assert.match(serverJs, /function isStage6SourceComparisonRequest/);
    assert.match(serverJs, /function extractNumberedSourceItems/);
    assert.match(serverJs, /buildSourceItemInventoryBlock\(attachmentText\)/);
    assert.match(serverJs, /STAGE 6 SOURCE COMPARISON MODE/);
    assert.match(serverJs, /Do not treat this as revision confirmation/);
    assert.match(serverJs, /Source Coverage Matrix/);
    assert.match(serverJs, /EVERY numbered source item/);
    assert.match(serverJs, /If the writer later calls out a source item ID you missed/);
    assert.match(serverJs, /stage4CurrentArtifactAnalysis \|\| stage6SourceComparisonAnalysis/);
});

test('frontend Stage 6 regenerate menu uses novice-facing labels and chat notes', () => {
    const indexHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    for (const id of ['btnStage2Regenerate', 'btnStage3Regenerate', 'btnStage4Regenerate', 'btnStage5Regenerate', 'btnStage6Regenerate', 'btnStage7RegenerateHeader', 'btnStage9Regenerate']) {
        assert.match(indexHtml, new RegExp(`id="${id}"`));
    }
    assert.match(indexHtml, /Fresh Blueprint/);
    assert.match(indexHtml, /Use Chat Notes/);
    assert.match(indexHtml, /Previous Version/);
    assert.doesNotMatch(indexHtml, /upstream/i);
    assert.match(appJs, /function updateStageRegenerateButtons/);
    assert.match(appJs, /function regenerateGeneratedStage/);
    assert.match(appJs, /function regenerateCoverage/);
    assert.match(appJs, /Regenerate the blueprint with these notes:/);
    assert.match(appJs, /shouldRegenerateStage6FromChat/);
    assert.match(appJs, /generateStage6\(\{ notes, isRegenerate: true/);
    assert.match(appJs, /alert\(error\.message \|\| 'An error occurred during scene generation\.'\)/);
    assert.match(serverJs, /Failed to generate scene blueprint: \$\{detail\}/);
    assert.match(serverJs, /type: 'heartbeat', label: 'Still generating scene blueprint\.\.\.'/);
    assert.match(serverJs, /X-Accel-Buffering', 'no'/);
    assert.match(serverJs, /res\.flush\?\.\(\)/);
});

test('frontend Stage 6 chat directly executes structured revision memos and guards no-op revisions', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const brainstormSkill = fs.readFileSync(require.resolve('../skills/skill_brainstorm.md'), 'utf8');
    const stage6RevisionAgent = fs.readFileSync(require.resolve('../agents/agent_6_revise.js'), 'utf8');
    assert.match(appJs, /function isStage6DirectRevisionRequest/);
    assert.match(appJs, /Number\(stageId\) === 6 && isStage6DirectRevisionRequest\(_text\)/);
    assert.match(appJs, /DIRECT USER REVISION REQUEST:/);
    assert.match(appJs, /function isStage6AnalysisOnlyFeedback/);
    assert.match(appJs, /function isStage6ExternalFeedbackDump/);
    assert.match(appJs, /function hasStage6ExplicitApplyIntent/);
    assert.match(appJs, /hard canon breaks/);
    assert.match(appJs, /stage6AnalysisOnlyFeedback && data\.suggest_plan/);
    assert.match(appJs, /function shouldRegenerateStage6FromChat/);
    assert.match(appJs, /do not\|don't\|dont\|not\|never/);
    assert.match(appJs, /function reviseStage6Blueprint/);
    assert.match(appJs, /'Accept': 'text\/event-stream'/);
    assert.match(appJs, /stream:\s*true/);
    assert.match(appJs, /readSSEStream\(response/);
    assert.match(appJs, /refreshCurrentProjectData\(\)/);
    assert.match(appJs, /cache:\s*'no-store'/);
    assert.match(appJs, /refreshedFromProject/);
    assert.match(appJs, /Revision completed, but the updated blueprint could not be refreshed/);
    assert.match(appJs, /highlightStage6ChangedScenes/);
    assert.match(appJs, /returned no blueprint changes/);
    assert.match(appJs, /const assertRevisionApplied =/);
    assert.match(appJs, /The revision engine did not report saved changes/);
    assert.match(appJs, /changed: data\.changed !== false && JSON\.stringify\(currentPitch\) !== JSON\.stringify/);
    assert.match(appJs, /revisionReceiptChanged\(data\)[\s\S]*JSON\.stringify\(currentCharacters\) !== JSON\.stringify/);
    assert.match(appJs, /revisionReceiptChanged\(completeEvent\)[\s\S]*JSON\.stringify\(currentBeats\) !== JSON\.stringify/);
    assert.match(appJs, /revisionReceiptChanged\(completeEvent\)[\s\S]*JSON\.stringify\(comparableCurrentData\) !== JSON\.stringify/);
    assert.match(appJs, /return \{ \.\.\.data, changed: true \}/);
    assert.match(appJs, /stage8LoadEditor\(data\.result\)[\s\S]*return data;/);
    assert.match(appJs, /latestIsConfirmation/);
    assert.match(appJs, /CONFIRMATION HANDOFF/);
    assert.match(appJs, /RECENT ASSISTANT CONTEXT/);
    assert.match(appJs, /RECENT CONVERSATION CONTEXT/);
    assert.match(appJs, /Review the updated output before treating any broader feedback list as complete/);
    assert.doesNotMatch(appJs, /chat\.history\.push\(\{ role: 'user', content: '\[Revision applied successfully/);
    assert.match(appJs, /dataset\.sceneNumber/);
    assert.match(fs.readFileSync(require.resolve('../public/style.css'), 'utf8'), /scene-card-revision-highlight/);
    assert.match(brainstormSkill, /Project-Agnostic Thinking Protocol/);
    assert.match(brainstormSkill, /constraint map/);
    assert.match(brainstormSkill, /stay inside that active scope/);
    assert.match(brainstormSkill, /dormant craft note/);
    assert.match(brainstormSkill, /Do not infer page numbers from scene numbers or plot order/);
    assert.match(brainstormSkill, /Do not surface the next unresolved item/);
    assert.match(serverJs, /Project Constraint Map/);
    assert.match(serverJs, /Required passes/);
    assert.match(serverJs, /SOURCE LOCATION GROUNDING MODE/);
    assert.match(serverJs, /Do not infer a page number from a scene number/);
    assert.match(serverJs, /Review the updated artifact before treating any broader feedback list as complete/);
    assert.match(serverJs, /const changed = sourcePlanDataHash\(JSON\.stringify\(parsedPitch\)\) !== sourcePlanDataHash\(JSON\.stringify\(result \|\| \{\}\)\)/);
    assert.match(serverJs, /createRevisionTransaction\({[\s\S]*stageId: 'stage3_characters'/);
    assert.match(serverJs, /createRevisionTransaction\({[\s\S]*stageId: 'stage4_beats'/);
    assert.match(serverJs, /createRevisionTransaction\({[\s\S]*stageId: 'stage5_treatment'/);
    assert.match(serverJs, /assertRevisionTransactionVerified\(revisionTransaction, 'Stage 6 scene blueprint'\)/);
    assert.match(serverJs, /revisionReceipt: revisionTransaction\?\.receipt/);
    assert.match(serverJs, /const beforeDraftHash = sourcePlanDataHash/);
    assert.match(serverJs, /function isStage6ExternalFeedbackReviewRequest/);
    assert.match(serverJs, /STAGE 6 EXTERNAL FEEDBACK REVIEW MODE/);
    assert.match(serverJs, /Do not set suggest_plan true or execute_immediately true/);
    assert.match(serverJs, /same recommended batch/);
    assert.match(serverJs, /same active batch or the next unresolved decision from that same triage/);
    assert.match(serverJs, /dormant notes from earlier feedback as competing next steps/);
    assert.match(serverJs, /stageKey: 'stage6_scenes'/);
    assert.match(stage6RevisionAgent, /function buildRevisionChecklist/);
    assert.match(stage6RevisionAgent, /Treat these as explicit obligations from the feedback/);
    assert.match(stage6RevisionAgent, /Do not silently skip checklist items/);
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

test('persistChatAttachmentToKnowledge stores original uploads and extracted markdown assets', async () => {
    const project = { id: '9999999999999', data: {} };
    const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', 'data'));
    const assetDir = path.join(dataRoot, 'source-files', project.id);
    fs.rmSync(assetDir, { recursive: true, force: true });

    try {
        const docx = new Document({
            sections: [{
                children: [new Paragraph('Docx source says Mara keeps the blue key.')]
            }]
        });
        const docxBuffer = await Packer.toBuffer(docx);

        await persistChatAttachmentToKnowledge(project, {
            name: 'Canon Draft.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            data: docxBuffer.toString('base64')
        }, {
            userMessage: 'Treat this as source material.',
            originTag: 'project_upload'
        });

        const source = project.data.knowledge.source_registry[0];
        assert.equal(source.originalFile.filename, 'Canon Draft.docx');
        assert.equal(source.extractedMarkdown.filename, 'Canon Draft.md');
        assert.match(source.originalFile.path, /source-files\/9999999999999\/src_/);
        assert.match(source.extractedMarkdown.path, /\.md$/);

        const originalPath = path.join(dataRoot, source.originalFile.path);
        const markdownPath = path.join(dataRoot, source.extractedMarkdown.path);
        assert.equal(fs.readFileSync(originalPath).length, docxBuffer.length);
        assert.match(fs.readFileSync(markdownPath, 'utf8'), /Docx source says Mara keeps the blue key/);

        const extracted = await readKnowledgeSourceAssetForClient(project, project.id, source.id, 'extracted');
        assert.equal(extracted.filename, 'Canon Draft.md');
        assert.match(extracted.content, /# Canon Draft\.docx/);
        assert.match(extracted.content, /Docx source says Mara keeps the blue key/);

        const original = await readKnowledgeSourceAssetForClient(project, project.id, source.id, 'original');
        assert.equal(original.filename, 'Canon Draft.docx');
        assert.equal(original.buffer.length, docxBuffer.length);
    } finally {
        fs.rmSync(assetDir, { recursive: true, force: true });
    }
});

test('upgradeLegacyProjectKnowledge normalizes memory and recovers extracted markdown from stored text', async () => {
    const project = {
        id: '9999999999998',
        title: 'Legacy Source Project',
        data: {
            knowledge: {
                source_registry: [{
                    name: 'Legacy Notes.txt',
                    text: 'Mara keeps the blue key in the flooded arcade.'
                }]
            }
        }
    };
    const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', 'data'));
    const assetDir = path.join(dataRoot, 'source-files', project.id);
    fs.rmSync(assetDir, { recursive: true, force: true });

    try {
        const report = await upgradeLegacyProjectKnowledge(project, project.id, {
            writeAssets: true,
            now: '2026-05-20T12:00:00.000Z'
        });
        const source = project.data.knowledge.source_registry[0];

        assert.equal(report.changed, true);
        assert.equal(report.recoveredMarkdown, 1);
        assert.equal(report.missingOriginal, 1);
        assert.match(source.id, /^src_legacy_/);
        assert.equal(source.charCount, 'Mara keeps the blue key in the flooded arcade.'.length);
        assert.ok(source.extractedMarkdown.path.endsWith('.md'));
        assert.ok(project.data.knowledge.memory_snapshot);

        const markdownPath = path.join(dataRoot, source.extractedMarkdown.path);
        assert.match(fs.readFileSync(markdownPath, 'utf8'), /Mara keeps the blue key/);
    } finally {
        fs.rmSync(assetDir, { recursive: true, force: true });
    }
});

test('upgradeLegacyProjectKnowledge does not promote summaries into recovered source files', async () => {
    const project = {
        id: '9999999999997',
        title: 'Summary Only Project',
        data: {
            knowledge: {
                source_registry: [{
                    id: 'src_summary_only',
                    name: 'Legacy Bible',
                    summary: 'Only a compact summary survived.'
                }]
            }
        }
    };
    const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', 'data'));
    const assetDir = path.join(dataRoot, 'source-files', project.id);
    fs.rmSync(assetDir, { recursive: true, force: true });

    try {
        const report = await upgradeLegacyProjectKnowledge(project, project.id, {
            writeAssets: true,
            now: '2026-05-20T12:00:00.000Z'
        });
        const source = project.data.knowledge.source_registry[0];

        assert.equal(report.recoveredMarkdown, 0);
        assert.equal(report.missingReadableText, 1);
        assert.equal(report.missingExtractedMarkdown, 1);
        assert.equal(source.extractedMarkdown, undefined);
        assert.equal(fs.existsSync(assetDir), false);
    } finally {
        fs.rmSync(assetDir, { recursive: true, force: true });
    }
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
