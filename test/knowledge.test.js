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
    isScopedPolishRequest,
    buildScopedPolishPromptBlock,
    extractNumberedSourceItems,
    buildSourceItemInventoryBlock,
    updateKnowledgeSourceMetadata,
    ApiError,
    BadRequestError,
    NotFoundError,
    RateLimitError,
    statusCodeForError,
    sendApiError
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

test('typed API errors expose intended 4xx messages and hide generic 5xx details', () => {
    const badRequest = new BadRequestError('Invalid payload');
    const notFound = new NotFoundError('Missing thing');
    const limited = new RateLimitError('Slow down');
    const generic = new Error('database path /private/project.json exploded');
    const enoent = Object.assign(new Error('ENOENT: /private/project.json'), { code: 'ENOENT' });

    assert.ok(badRequest instanceof ApiError);
    assert.equal(statusCodeForError(badRequest), 400);
    assert.equal(statusCodeForError(notFound), 404);
    assert.equal(statusCodeForError(limited), 429);
    assert.equal(statusCodeForError(generic), 500);
    assert.equal(statusCodeForError(enoent), 404);

    const capture = (error, fallback) => {
        const seen = {};
        const res = {
            status(code) {
                seen.status = code;
                return {
                    json(body) {
                        seen.body = body;
                        return body;
                    }
                };
            }
        };
        sendApiError(res, error, fallback);
        return seen;
    };

    assert.deepEqual(capture(badRequest, 'Fallback'), {
        status: 400,
        body: { error: 'Invalid payload', code: 'BAD_REQUEST' }
    });
    assert.deepEqual(capture(generic, 'Safe fallback'), {
        status: 500,
        body: { error: 'Safe fallback' }
    });
    assert.deepEqual(capture(enoent, 'Missing resource'), {
        status: 404,
        body: { error: 'Missing resource' }
    });
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

test('assistant route returns JSON 404 when the active project file is missing', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const assistantRoute = serverSource.match(/app\.post\('\/api\/assistant'[\s\S]*?res\.status\(500\)\.json\(\{ error: detail \? `Assistant request failed:/)?.[0] || '';

    assert.match(assistantRoute, /catch\s*\{\s*return res\.status\(404\)\.json\(\{ error: 'Project not found' \}\);/);
});

test('unknown API routes return JSON 404 diagnostics', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    assert.match(serverSource, /app\.use\('\/api', \(req, res\) => \{/);
    assert.match(serverSource, /res\.status\(404\)\.json\(\{ error: `API route not found: \$\{req\.method\} \$\{req\.originalUrl\}` \}\);/);
    assert.match(serverSource, /BUILD_COMMIT,[\s\S]*BUILD_TIMESTAMP,[\s\S]*getBuildInfo[\s\S]*= require\('\.\/utils\/build_info'\)/);
    assert.match(serverSource, /commit: BUILD_COMMIT/);
    assert.match(serverSource, /buildTimestamp: BUILD_TIMESTAMP/);
});

test('build fingerprint is exposed, cached, and stamped into exports', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
    const indexSource = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
    const exportSource = fs.readFileSync(path.join(__dirname, '..', 'agents/export.js'), 'utf8');
    const agentCoverageSource = fs.readFileSync(path.join(__dirname, '..', 'agents/agent_9_coverage.js'), 'utf8');
    const { buildDocxMetadata } = require('../agents/export');
    const { clearSkillCache, loadSkill, normalizeSkillFilename } = require('../utils/skills_cache');

    assert.match(serverSource, /build: getBuildInfo\(\)/);
    assert.match(appSource, /nativeFetch\('\/health'\)/);
    assert.match(indexSource, /id="buildFingerprintFooter"/);
    assert.match(indexSource, /id="settings-build-fingerprint"/);
    assert.match(exportSource, /description: `Generated by PageOne\. \$\{fingerprint\}`/);
    assert.match(buildDocxMetadata().description, /buildTimestamp=/);
    assert.match(agentCoverageSource, /parseJsonWithRepair\(response\.text, \{ schema: coverageSchema/);
    assert.doesNotMatch(agentCoverageSource, /JSON\.parse\(response\.text\)/);

    clearSkillCache();
    assert.equal(normalizeSkillFilename('skill_assistant_core'), 'skill_assistant_core.md');
    assert.strictEqual(loadSkill('skill_assistant_core'), loadSkill('skill_assistant_core.md'));
    assert.throws(() => loadSkill('../skill_assistant_core'), /Invalid skill name/);
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

test('frontend persists edited Stage 10 pending rewrites before scene changes or approval', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const indexHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');

    assert.match(indexHtml, /id="stage10-pending-save-banner"/);
    assert.match(indexHtml, /id="btnStage10RetryPendingSave"/);
    assert.match(appJs, /fetch\('\/api\/save-stage10-pending'/);
    assert.match(appJs, /stage10PendingSavedText\s*=\s*\{\s*\.\.\.stage10Pending\s*\}/);
    assert.match(appJs, /async function stage10FlushEditPanel\(\{ requireSaved = false \} = \{\}\)/);
    assert.match(appJs, /window\.stage10SelectSceneBtn = async function\(n\)/);
    assert.match(appJs, /await stage10SelectScene\(pendingKeys\[0\], \{ skipFlush: true \}\)/);
    assert.match(appJs, /await stage10FlushEditPanel\(\{ requireSaved: true \}\)/);
    assert.match(appJs, /stage10SetPending\(stage10CurrentScene, data\.proposed_text, \{ serverSaved: true \}\)/);
    assert.match(appJs, /stage10QueuePendingSave\(stage10CurrentScene\)/);
    assert.doesNotMatch(appJs, /function stage10FlushEditPanel\(\) \{/);
});

test('server persists Stage 10 pending rewrites through atomic project updates', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const singleSceneRoute = serverJs.match(/app\.post\('\/api\/rewrite-single-scene'[\s\S]*?app\.post\('\/api\/save-stage10-pending'/)?.[0] || '';
    const feedbackRoute = serverJs.match(/app\.post\('\/api\/rewrite-scene-feedback'[\s\S]*?\/\/ Mark Stage 10 as approved\/finalized/)?.[0] || '';
    const approveRoute = serverJs.match(/app\.post\('\/api\/approve-rewrite-priority'[\s\S]*?\/\/ Rewrite a single scene using/)?.[0] || '';
    const finalizeRoute = serverJs.match(/app\.post\('\/api\/finalize-stage10'[\s\S]*?\/\/ --- Stage 7/)?.[0] || '';

    assert.match(serverJs, /function persistStage10PendingRewrite/);
    assert.match(serverJs, /app\.post\('\/api\/save-stage10-pending'/);
    assert.match(singleSceneRoute, /await updateProjectJSON\(projectId, \(freshProject\) =>/);
    assert.match(singleSceneRoute, /persistStage10PendingRewrite\(freshProject/);
    assert.match(feedbackRoute, /persistStage10PendingRewrite\(freshProject/);
    assert.match(approveRoute, /await updateProjectJSON\(projectId, \(projectData\) =>/);
    assert.match(finalizeRoute, /await updateProjectJSON\(projectId, \(projectData\) =>/);
    assert.doesNotMatch(approveRoute, /await writeJSONQueued/);
    assert.doesNotMatch(finalizeRoute, /await writeJSONQueued/);
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
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const assistantJs = fs.readFileSync(require.resolve('../agents/assistant.js'), 'utf8');

    assert.match(appJs, /normalizeStage3CharacterForEditor/);
    assert.match(appJs, /currentCharacterTierOverrides/);
    assert.match(appJs, /tier_overrides: stage3TierOverridesFromCharacters\(characters\)/);
    assert.match(appJs, /core\.false_belief/);
    assert.match(appJs, /core\.wound/);
    assert.match(assistantJs, /STAGE 3 CHARACTER BOUNDARY/);
    assert.doesNotMatch(appJs, /isStage3DirectRevisionRequest/);
    assert.doesNotMatch(appJs, /Applying those character changes now/);

    assert.match(agent3Js, /normalizeLegacyCharacter/);
    assert.match(agent3Js, /function normalizeTierOverrides/);
    assert.match(serverJs, /tierOverrides: activeTierOverrides/);
    assert.doesNotMatch(agent3Js, /TIER_1_PROJECT_NAMES/);
    assert.doesNotMatch(agent3Js, /Rebecca, Dapple, Dave, Terry, Elliot/);
    assert.match(agent3Js, /isFullCharacterRegenerationRequest/);
    assert.match(agent3Js, /LEGACY MODERNIZATION/);
    assert.match(agent3Js, /fresh character regeneration/);
});

test('Claude client streams long Opus requests used by Stage 3 characters', () => {
    const aiClient = fs.readFileSync(require.resolve('../agents/ai-client.js'), 'utf8');
    assert.match(aiClient, /client\.messages\.stream\(request, requestOptions\)/);
    assert.match(aiClient, /stream\.finalMessage\(\)/);
    assert.match(aiClient, /maxTokens >= 32000/);
    assert.match(aiClient, /model === 'claude-opus-4-7'/);
    assert.match(aiClient, /abortSignal/);
    assert.match(aiClient, /CLIENT_DISCONNECTED/);
    assert.match(aiClient, /client\.messages\.create\(request, requestOptions\)/);
});

test('Stage 3 assistant chat stays inside character-profile boundaries', () => {
    const assistantJs = fs.readFileSync(require.resolve('../agents/assistant.js'), 'utf8');
    assert.match(assistantJs, /STAGE 3 CHARACTER BOUNDARY/);
    assert.match(assistantJs, /character-profile mechanics/);
    assert.match(assistantJs, /Do NOT prescribe sequence- or scene-level plot placement/);
    assert.match(assistantJs, /Stage 3 execution means updating character profiles only/);
});

test('Stage 2 outline generation supports streamed assistant revisions', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const stageRevisionKernel = fs.readFileSync(require.resolve('../utils/stage_revision_kernel.js'), 'utf8');
    assert.match(serverJs, /app\.post\('\/api\/generate-outline'/);
    assert.match(serverJs, /require\('\.\/utils\/stage_revision_kernel'\)/);
    assert.match(serverJs, /applyStageRevisionPlan\(\{[\s\S]*stageId: 'stage2_outline'/);
    assert.match(serverJs, /stage2ProtectedBeatEntriesForRequest/);
    assert.match(serverJs, /protectedBeats: activeProtectedBeatEntries/);
    assert.match(serverJs, /protected_beats: activeProtectedBeats/);
    assert.match(serverJs, /Stage 2 deterministic outline revision failed verification/);
    assert.match(serverJs, /text\/event-stream/);
    assert.match(serverJs, /: keep-alive\\n\\n/);
    assert.match(serverJs, /type: 'complete'/);
    assert.match(appJs, /function consumeOutlineGenerationResponse/);
    assert.match(appJs, /function recoverOutlineFromInterruptedStream/);
    assert.match(appJs, /function isLikelyStreamTransportError/);
    assert.match(appJs, /function setApproveButtonState/);
    assert.match(appJs, /function currentStage2ProtectedBeats/);
    assert.match(appJs, /function stage2PayloadFromOutline/);
    assert.match(appJs, /stage2-protected-toggle/);
    assert.match(appJs, /formData\.append\('protectedBeats', JSON\.stringify\(currentStage2ProtectedBeats\(\)\)\)/);
    assert.match(appJs, /protected_beats: currentStage2ProtectedBeats\(\)/);
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
    assert.ok(serverJs.indexOf('applyStageRevisionPlan({') < serverJs.indexOf('agent2Outline('));
    assert.match(serverJs, /createRevisionTransaction\({[\s\S]*stageId: 'stage2_outline'/);
    assert.match(serverJs, /assertRevisionTransactionVerified\(revisionTransaction, 'Stage 2 outline'\)/);
    assert.match(serverJs, /recordArtifactMutation\(projectData, \{[\s\S]*stage: 2/);
    assert.match(serverJs, /snapshotIds: snapshotEntries\.map\(entry => entry\.id\)/);
    assert.match(serverJs, /const changed = !notesWithUpload \|\| revisionTransaction\.changed/);
    assert.match(serverJs, /Stage 2 outline save verification failed/);
    assert.match(serverJs, /saveVerified: true/);
    assert.match(appJs, /changed: !revisionReceiptFailed\(data\)[\s\S]*revisionReceiptChanged\(data\)[\s\S]*JSON\.stringify\(currentBeats\) !== JSON\.stringify\(data\.result\?\.outline \|\| \{\}\)/);
    assert.match(stageRevisionKernel, /function normalizeProtectedBeats/);
    assert.doesNotMatch(stageRevisionKernel, /OUTLINE_DEFAULT_BEATS/);
    assert.doesNotMatch(stageRevisionKernel, /Dapple Rising - The Anchor/);
    assert.doesNotMatch(stageRevisionKernel, /Aftermath - A New Order/);
    assert.doesNotMatch(stageRevisionKernel, /Closing Image - The Photo on the Wall/);
});

test('streaming generation routes abort model work and skip saves after disconnect', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');

    assert.match(serverJs, /function createClientAbortTracker/);
    assert.match(serverJs, /res\.on\('close', abort\)/);
    assert.match(serverJs, /controller\.abort\(error\)/);
    assert.match(serverJs, /function withAbortSignal/);
    assert.match(serverJs, /abortSignal: signal/);

    for (const label of [
        'Stage 2 outline stream',
        'Stage 4 beats stream',
        'Stage 5 treatment stream',
        'Stage 6 scene generation stream',
        'Stage 6 revision stream'
    ]) {
        assert.match(serverJs, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    assert.match(serverJs, /withAbortSignal\(getModelConfigWithSourcePacket\(2, sourcePacket\), abortTracker\?\.signal\)/);
    assert.match(serverJs, /withAbortSignal\(getModelConfigWithSourcePacket\(4, sourcePacket\), abortTracker\.signal\)/);
    assert.match(serverJs, /withAbortSignal\(getModelConfigWithSourcePacket\(5, sourcePacket\), abortTracker\.signal\)/);
    assert.match(serverJs, /withAbortSignal\(getModelConfig\(6\), abortTracker\.signal\)/);
    assert.match(serverJs, /withAbortSignal\(getModelConfigWithSourcePacket\(6, sourcePacket\), abortTracker\?\.signal\)/);
    assert.match(serverJs, /abortTracker\?\.throwIfAborted\(\)/);
    assert.match(serverJs, /abortTracker\.throwIfAborted\(\)/);
    assert.match(serverJs, /isClientAbortError\(error\)/);
});

test('project and source routes use typed API error responder for 400 404 and 429 cases', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const projectRoutes = serverJs.match(/\/\/ --- Project Management Routes --- \/\/[\s\S]*?\/\/ ─── Export Endpoints/)?.[0] || '';
    const sourceHelpers = serverJs.match(/async function readKnowledgeSourceAssetForClient[\s\S]*?function contentDispositionFilename/)?.[0] || '';

    assert.match(serverJs, /class ApiError extends Error/);
    assert.match(serverJs, /class BadRequestError extends ApiError/);
    assert.match(serverJs, /class NotFoundError extends ApiError/);
    assert.match(serverJs, /class RateLimitError extends ApiError/);
    assert.match(serverJs, /handler: \(_req, res\) => sendApiError\(res, new RateLimitError/);
    assert.match(projectRoutes, /readProjectJSONById\(id\)/);
    assert.match(projectRoutes, /assertProjectExists\(id\)/);
    assert.match(projectRoutes, /throw new BadRequestError\('No file uploaded'\)/);
    assert.match(projectRoutes, /throw new BadRequestError\(`Unsupported file type:/);
    assert.match(projectRoutes, /sendApiError\(res, error, 'Failed to load project details'\)/);
    assert.match(projectRoutes, /sendApiError\(res, error, 'Failed to upload source'\)/);
    assert.match(projectRoutes, /sendApiError\(res, error, 'Failed to load source asset'\)/);
    assert.match(projectRoutes, /sendApiError\(res, error, 'Failed to delete project'\)/);
    assert.doesNotMatch(projectRoutes, /error\.statusCode/);
    assert.doesNotMatch(projectRoutes, /err\.statusCode/);
    assert.match(sourceHelpers, /throw new NotFoundError\('Source not found'\)/);
    assert.match(sourceHelpers, /throw new BadRequestError\('Unknown source asset type\.'\)/);
    assert.doesNotMatch(sourceHelpers, /statusCode\s*=/);
});

test('stage 1 pitch routes use typed API errors and shared project loading', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const stage1Routes = serverJs.match(/\/\/ API route[\s\S]*?app\.post\('\/api\/generate-outline'/)?.[0] || '';

    assert.match(stage1Routes, /readProjectJSONById\(projectId, \{ invalidMessage: 'Invalid projectId' \}\)/);
    assert.match(stage1Routes, /throw new BadRequestError\("Missing currentPitch or userNote"\)/);
    assert.match(stage1Routes, /throw new BadRequestError\("Invalid currentPitch JSON"\)/);
    assert.match(stage1Routes, /sendApiError\(res, error, "Failed to generate pitch"\)/);
    assert.match(stage1Routes, /sendApiError\(res, error, "Failed to refine pitch"\)/);
    assert.doesNotMatch(stage1Routes, /fs\.readFile\(getProjectFilePath\(projectId\)/);
    assert.doesNotMatch(stage1Routes, /res\.status\((400|500)\)/);
});

test('Stage 3 character route uses typed API errors through generation context', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const generationHelper = serverJs.match(/async function prepareGenerationProjectContext[\s\S]*?async function finalizeGeneratedStageArtifact/)?.[0] || '';
    const stage3Route = serverJs.match(/app\.post\('\/api\/generate-characters'[\s\S]*?app\.post\('\/api\/generate-stage4-beats'/)?.[0] || '';

    assert.match(generationHelper, /throwTypedErrors = false/);
    assert.match(generationHelper, /if \(throwTypedErrors\) throw new BadRequestError\(invalidProjectMessage\)/);
    assert.match(generationHelper, /readProjectJSONById\(projectId, \{ invalidMessage: invalidProjectMessage, notFoundMessage \}\)/);
    assert.match(generationHelper, /if \(throwTypedErrors\) throw err/);
    assert.match(generationHelper, /if \(throwTypedErrors\) throw new BadRequestError\(validationError\)/);
    assert.match(stage3Route, /throwTypedErrors: true/);
    assert.match(stage3Route, /Project requires Stage 1 Pitch and Stage 2 Outline to generate Characters/);
    assert.match(stage3Route, /sendApiError\(res, error, "Failed to generate characters"\)/);
    assert.doesNotMatch(stage3Route, /publicErrorDetail\(error\)/);
    assert.doesNotMatch(stage3Route, /res\.status\((400|500)\)/);
});

test('project memory routes use typed API errors for validation and shared failures', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const memoryRoutes = serverJs.match(/app\.post\('\/api\/projects\/:id\/knowledge\/decision'[\s\S]*?\/\/ DELETE project/)?.[0] || '';

    assert.match(memoryRoutes, /assertValidProjectId\(id\)/);
    assert.match(memoryRoutes, /await assertProjectExists\(id\)/);
    assert.match(memoryRoutes, /readProjectJSONById\(id\)/);
    assert.match(memoryRoutes, /throw new BadRequestError\('Invalid stage ID'\)/);
    assert.match(memoryRoutes, /throw new BadRequestError\('Decision summary is required'\)/);
    assert.match(memoryRoutes, /throw new BadRequestError\('No source documents saved yet'\)/);
    assert.match(memoryRoutes, /sendApiError\(res, error, 'Failed to log project knowledge decision'\)/);
    assert.match(memoryRoutes, /sendApiError\(res, error, 'Failed to propose project memory updates'\)/);
    assert.match(memoryRoutes, /sendApiError\(res, error, 'Failed to rebuild source bible'\)/);
    assert.doesNotMatch(memoryRoutes, /fs\.readFile\(getProjectFilePath\(id\)/);
    assert.doesNotMatch(memoryRoutes, /res\.status\((400|500)\)/);
});

test('style and export routes use typed API error responder for expected failures', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const styleRoutes = serverJs.match(/\/\/ --- Stage 7: Style Routes --- \/\/[\s\S]*?\/\/ --- Settings Routes --- \/\//)?.[0] || '';
    const exportRoutes = serverJs.match(/\/\/ ─── Export Endpoints[\s\S]*?app\.use\('\/api'/)?.[0] || '';

    assert.match(styleRoutes, /throw new BadRequestError\('Missing or invalid projectId or styleSlug'\)/);
    assert.match(styleRoutes, /throw new BadRequestError\('At least one screenplay file is required for trained style generation'\)/);
    assert.match(styleRoutes, /throw new NotFoundError\(`Style "\$\{styleSlug\}" not found`\)/);
    assert.match(styleRoutes, /throw new NotFoundError\(`Style "\$\{slug\}" not found`\)/);
    assert.match(styleRoutes, /throw new NotFoundError\('Style not found'\)/);
    assert.match(styleRoutes, /sendApiError\(res, error, 'Failed to generate style'\)/);
    assert.match(styleRoutes, /sendApiError\(res, error, 'Failed to preview style scene'\)/);
    assert.match(styleRoutes, /sendApiError\(res, error, 'Failed to select style'\)/);
    assert.match(styleRoutes, /sendApiError\(res, error, 'Failed to delete style'\)/);
    assert.doesNotMatch(styleRoutes, /res\.status\((400|404|500)\)/);

    assert.match(exportRoutes, /async function loadProjectData\(projectId\) \{[\s\S]*readProjectJSONById\(projectId, \{/);
    assert.match(exportRoutes, /throw new BadRequestError\('No rewrite data found'\)/);
    assert.match(exportRoutes, /throw new BadRequestError\(`Unknown stage: \$\{stage\}`\)/);
    assert.match(exportRoutes, /sendApiError\(res, err, 'Export failed'\)/);
    assert.doesNotMatch(exportRoutes, /Object\.assign\(new Error\('Invalid project ID'\)/);
    assert.doesNotMatch(exportRoutes, /res\.status\((400|500)\)/);
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
    assert.match(serverJs, /persistStageConversation\(filePath, projectData, conversationKey, historyForTurn, result\.message\)/);
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

    assert.match(response.message, /Stage 4 revision/);
    assert.match(retryResponse.message, /Stage 4 revision/);
    assert.doesNotMatch(appJs, /function isRevisionConfirmation/);
    assert.doesNotMatch(appJs, /function isRevisionStatusQuestion/);
    assert.doesNotMatch(appJs, /function findRecentRevisionProposal/);
    assert.doesNotMatch(appJs, /executeRevision && !attachment && isRevisionConfirmation/);
    assert.match(serverJs, /function buildStage4ConfirmationBypassResponse/);
    assert.match(serverJs, /function findRecentStage4RevisionProposal/);
    assert.match(serverJs, /buildStage4ConfirmationBypassResponse\(messages\)/);
    assert.match(serverJs, /name: 'apply_revision'/);
    assert.match(serverJs, /req\.path === '\/app\.js'/);
    assert.match(serverJs, /Cache-Control', 'no-store, max-age=0'/);
    assert.match(serverJs, /X-Accel-Buffering', 'no'/);
    assert.match(serverJs, /type: 'heartbeat'/);
    assert.match(serverJs, /res\.flush\?\.\(\)/);
    assert.match(serverJs, /Failed to generate beats: \$\{detail\}/);
});

test('tool assistant migration covers stages 1 through 8 and 10 with carried guardrails', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const assistantJs = fs.readFileSync(require.resolve('../agents/assistant.js'), 'utf8');
    const agent2Js = fs.readFileSync(require.resolve('../agents/agent_2_outline.js'), 'utf8');

    assert.match(serverJs, /app\.post\('\/api\/assistant'/);
    assert.doesNotMatch(serverJs, /app\.post\('\/api\/brainstorm'/);
    assert.doesNotMatch(serverJs, /app\.post\('\/api\/brainstorm-rewrite'/);
    assert.doesNotMatch(agent2Js, /LATEST USER REQUEST/);
    assert.doesNotMatch(agent2Js, /RECENT CONVERSATION CONTEXT/);
    assert.doesNotMatch(agent2Js, /latestConcreteUserFromRecentContext/);
    assert.match(agent2Js, /function normalizeRevisionBrief/);
    assert.match(serverJs, /buildToolAssistantContextAdditions/);
    assert.match(serverJs, /buildStage4ConfirmationRevisionBrief/);
    assert.match(serverJs, /buildMemoryRecallResponse\(projectData/);
    assert.match(assistantJs, /STAGE 8 DRAFT BOUNDARY/);
    assert.match(assistantJs, /name: 'generate_style'/);
    assert.match(assistantJs, /name: 'generate_rewrite_plan'/);
    assert.match(appJs, /toolInputBrief\(call\)/);
    assert.match(appJs, /stageId:\s*8,[\s\S]*sceneNumber: currentDraftSceneNumber/);
    assert.match(appJs, /stageId: 10, messages: msgs/);
});

test('global style creator uses the tool assistant instead of legacy style-chat flags', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const assistantJs = fs.readFileSync(require.resolve('../agents/assistant.js'), 'utf8');
    const createStyleBlock = appJs.slice(
        appJs.indexOf('// Conversational path'),
        appJs.indexOf('// Trained path')
    );

    assert.match(assistantJs, /style_global/);
    assert.match(serverJs, /isGlobalStyleAssistantStage\(stageId\)/);
    assert.match(serverJs, /buildGlobalStyleAssistantContext/);
    assert.match(appJs, /stageId: 'style_global'/);
    assert.match(appJs, /triggerStyleGeneration\(thread, brief, \{ quiet: true, deferOpen: true \}\)/);
    assert.doesNotMatch(createStyleBlock, /fetch\('\/api\/style-chat'/);
    assert.doesNotMatch(createStyleBlock, /execute_immediately/);
});

test('frontend Stage 2 chat delegates outline revision decisions to the tool assistant', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const assistantJs = fs.readFileSync(require.resolve('../agents/assistant.js'), 'utf8');

    assert.match(appJs, /toolAssistantTurn\(\{[\s\S]*stageId,[\s\S]*messages: history/);
    assert.match(assistantJs, /revision_brief/);
    assert.doesNotMatch(appJs, /function isStage2DirectRevisionRequest/);
    assert.doesNotMatch(appJs, /DIRECT USER REVISION REQUEST:/);
    assert.doesNotMatch(appJs, /Applying those outline changes now/);
    assert.doesNotMatch(appJs, /outline revision failed/);
    assert.doesNotMatch(appJs, /saved outline came back unchanged/);
    assert.doesNotMatch(appJs, /function isRevisionStatusQuestion/);
    assert.match(appJs, /function revisionReceiptChanged/);
    assert.match(appJs, /function revisionReceiptFailed/);
    assert.match(appJs, /revisionReceiptChanged\(data\)/);
});

test('Stage 2 scoped polish notes do not revive stale revision checklist items', () => {
    const note = `One small polish note, not a structural issue:

In [Rebecca's Memory - The Storm Drain], PILLERMOSS is emotionally strong, but the beat currently asks it to function as several things at once: a rusted tin can, a private treasury, and the bonded phrase/password. That is understandable, but it may read a little fuzzy on first pass because the audience needs the memory-object and the memory-word to land cleanly.

Suggestion: clarify that PILLERMOSS is the private name Becky and Dapple gave to the rusted tin can / tiny childhood kingdom, and that saying the word now works because it carries the whole memory.

Then in the climax, when Rebecca says "PILLERMOSS," it is clear why the word breaks through: she is not just saying a magic code. She is naming the private world they shared, the proof that she remembers him specifically and lovingly.

This is only a clarity polish. The current structure works.`;
    const promptBlock = buildScopedPolishPromptBlock(2, note);
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

    assert.equal(isScopedPolishRequest(note), true);
    assert.equal(isScopedPolishRequest('Please restore the missing ending beats and remove the duplicate aftermath.'), false);
    assert.match(promptBlock, /LATEST MESSAGE SCOPE LOCK/);
    assert.match(promptBlock, /Rebecca's Memory - The Storm Drain/);
    assert.match(promptBlock, /Do not revive older checklist items/);
    assert.match(promptBlock, /do not propose midpoint, ending, surrender\/accountability/);
    assert.match(promptBlock, /Call apply_revision only for that narrow local edit/);
    assert.match(serverJs, /const scopedPolishRequest = !isInit && isScopedPolishRequest\(lastUserMessage\)/);
    assert.match(serverJs, /stage6ExternalFeedbackReview \|\| scopedPolishRequest/);
    assert.match(serverJs, /buildToolScopedPolishPromptBlock\(numericStageId, lastUserMessage\)/);
    assert.doesNotMatch(appJs, /function isScopedPolishMessage/);
    assert.doesNotMatch(appJs, /CONFIRMATION HANDOFF/);
});

test('stage chat source-audit questions are handled by analysis-only tool context', () => {
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
    assert.doesNotMatch(appJs, /pendingRevision/);
    assert.doesNotMatch(appJs, /isRevisionConfirmation/);
    assert.match(serverJs, /function isStage6SourceComparisonRequest/);
    assert.match(serverJs, /function extractNumberedSourceItems/);
    assert.match(serverJs, /buildSourceItemInventoryBlock\(attachmentText\)/);
    assert.match(serverJs, /STAGE 6 SOURCE COMPARISON MODE/);
    assert.match(serverJs, /Do not treat this as revision confirmation/);
    assert.match(serverJs, /Do not call apply_revision for this turn/);
    assert.match(serverJs, /Source Coverage Matrix/);
    assert.match(serverJs, /EVERY numbered source item/);
    assert.match(serverJs, /Before finalizing, scan the SOURCE ITEM INVENTORY again/);
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

test('frontend Stage 6 chat uses the tool assistant and guards no-op revisions', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const assistantSkill = fs.readFileSync(require.resolve('../skills/skill_assistant_core.md'), 'utf8');
    const stage6RevisionAgent = fs.readFileSync(require.resolve('../agents/agent_6_revise.js'), 'utf8');
    assert.doesNotMatch(appJs, /function isStage6DirectRevisionRequest/);
    assert.doesNotMatch(appJs, /DIRECT USER REVISION REQUEST:/);
    assert.doesNotMatch(appJs, /stage6AnalysisOnlyFeedback && data\.suggest_plan/);
    assert.match(appJs, /toolAssistantTurn\(\{[\s\S]*stageId,[\s\S]*messages: history/);
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
    assert.match(appJs, /changed: data\.changed !== false && JSON\.stringify\(currentPitch\) !== JSON\.stringify/);
    assert.match(appJs, /revisionReceiptChanged\(data\)[\s\S]*JSON\.stringify\(currentCharacters\) !== JSON\.stringify/);
    assert.match(appJs, /revisionReceiptChanged\(completeEvent\)[\s\S]*JSON\.stringify\(currentBeats\) !== JSON\.stringify/);
    assert.match(appJs, /revisionReceiptChanged\(completeEvent\)[\s\S]*JSON\.stringify\(comparableCurrentData\) !== JSON\.stringify/);
    assert.match(appJs, /return \{ \.\.\.data, changed: true \}/);
    assert.match(appJs, /stage8LoadEditor\(data\.result\)[\s\S]*return data;/);
    assert.match(appJs, /toolResultFromExecution\(call, rev\)/);
    assert.doesNotMatch(appJs, /chat\.history\.push\(\{ role: 'user', content: '\[Revision applied successfully/);
    assert.match(appJs, /dataset\.sceneNumber/);
    assert.match(fs.readFileSync(require.resolve('../public/style.css'), 'utf8'), /scene-card-revision-highlight/);
    assert.match(assistantSkill, /Project-Agnostic Thinking Protocol/);
    assert.match(assistantSkill, /constraint map/);
    assert.match(assistantSkill, /stay inside that active scope/);
    assert.match(assistantSkill, /Do not infer page numbers from scene numbers or plot order/);
    assert.match(serverJs, /Project Constraint Map/);
    assert.match(serverJs, /SOURCE LOCATION GROUNDING MODE/);
    assert.match(serverJs, /Do not infer a page number from a scene number/);
    assert.match(serverJs, /Do not call apply_revision for this turn/);
    assert.match(serverJs, /const changed = sourcePlanDataHash\(JSON\.stringify\(parsedPitch\)\) !== sourcePlanDataHash\(JSON\.stringify\(result \|\| \{\}\)\)/);
    assert.match(serverJs, /createRevisionTransaction\({[\s\S]*stageId: 'stage3_characters'/);
    assert.match(serverJs, /createRevisionTransaction\({[\s\S]*stageId: 'stage4_beats'/);
    assert.match(serverJs, /createRevisionTransaction\({[\s\S]*stageId: 'stage5_treatment'/);
    assert.match(serverJs, /assertRevisionTransactionVerified\(revisionTransaction, 'Stage 6 scene blueprint'\)/);
    assert.match(serverJs, /revisionReceipt: revisionTransaction\?\.receipt/);
    assert.match(serverJs, /const beforeDraftHash = sourcePlanDataHash/);
    assert.match(serverJs, /function isStage6ExternalFeedbackReviewRequest/);
    assert.match(serverJs, /STAGE 6 EXTERNAL FEEDBACK REVIEW MODE/);
    assert.match(serverJs, /Do not call apply_revision for this turn/);
    assert.match(serverJs, /same recommended batch/);
    assert.match(serverJs, /Do not ask the revision engine to apply the whole note dump/);
    assert.match(serverJs, /stageKey: 'stage6_scenes'/);
    assert.match(stage6RevisionAgent, /function buildRevisionChecklist/);
    assert.match(stage6RevisionAgent, /Treat these as explicit obligations from the feedback/);
    assert.match(stage6RevisionAgent, /Do not silently skip checklist items/);
});

test('frontend Stage 8 auto-save failures are visible and block navigation', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const indexHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');

    assert.match(indexHtml, /id="stage8-autosave-banner"/);
    assert.match(indexHtml, /id="btnStage8RetrySave"/);
    assert.match(appJs, /async function stage8FlushEditor\(\{ requireSaved = false \} = \{\}\)/);
    assert.match(appJs, /function showStage8AutosaveError/);
    assert.match(appJs, /btnStage8RetrySave\.addEventListener\('click', async \(\) =>/);
    assert.match(appJs, /await stage8FlushEditor\(\{ requireSaved: true \}\);[\s\S]*Mark the current scene as locked/);
    assert.match(appJs, /beforeGuard: \(\) => stage8FlushEditor\(\{ requireSaved: true \}\)/);
    assert.match(appJs, /window\.selectDraftScene = async function/);
    assert.doesNotMatch(appJs, /Stage 8 auto-save failed:', err\)\)/);
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
