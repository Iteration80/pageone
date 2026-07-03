function registerKnowledgeRoutes(app, deps) {
    const {
        requireAuth,
        aiLimiter,
        upload,
        STAGE_NAMES,
        SOURCE_TYPE_OPTIONS,
        assertValidProjectId,
        assertValidSourceId,
        assertProjectExists,
        readProjectJSONById,
        updateProjectJSON,
        BadRequestError,
        ensureProjectKnowledge,
        knowledgePayloadForClient,
        compactText,
        persistChatAttachmentToKnowledge,
        boundedKnowledgePush,
        compactProjectKnowledge,
        summarizeSourceForClient,
        readKnowledgeSourceAssetForClient,
        contentDispositionFilename,
        removeKnowledgeSource,
        removeKnowledgeSourceAssets,
        updateKnowledgeSourceMetadata,
        buildKnowledgeDiagnostics,
        summarizeAuditForDecision,
        compactAuditForKnowledge,
        recordAcceptedSourceDivergence,
        buildStageDataForAssistant,
        stageDataOverrideToText,
        buildFallbackStageCuration,
        buildKnowledgeContextBlock,
        getModelConfig,
        generateContent,
        safeParse,
        trackUsage,
        sanitizeStageCurationProposal,
        applyStageCurationToKnowledge,
        refreshStageHandoff,
        updateKnowledgeReview,
        buildSourceBiblePrompt,
        formatKnowledgeItem,
        sendApiError
    } = deps;

    app.get('/api/projects/:id/knowledge', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const projectData = await readProjectJSONById(id);
            const knowledge = ensureProjectKnowledge(projectData);
            res.json({ knowledge: knowledgePayloadForClient(knowledge, projectData) });
        } catch (error) {
            console.error('knowledge load error:', error.message);
            sendApiError(res, error, 'Failed to load project knowledge');
        }
    });

    app.post('/api/projects/:id/knowledge/sources', requireAuth, upload.single('sourceFile'), async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            if (!req.file) throw new BadRequestError('No source file uploaded');
            await assertProjectExists(id);

            const attachment = {
                name: req.file.originalname || 'Untitled source',
                mimeType: req.file.mimetype || 'application/octet-stream',
                data: req.file.buffer.toString('base64')
            };
            const sourceNote = compactText(req.body?.sourceNote || '', 800);
            let uploadResult = null;

            const updatedProject = await updateProjectJSON(id, async (projectData) => {
                const persisted = await persistChatAttachmentToKnowledge(projectData, attachment, {
                    stageId: null,
                    userMessage: sourceNote,
                    originTag: 'project_upload',
                    projectId: id
                });
                if (!persisted.savedSource) {
                    throw new BadRequestError('No readable text could be extracted from this source file');
                }
                uploadResult = persisted.savedSource;

                const knowledge = ensureProjectKnowledge(projectData);
                const now = new Date().toISOString();
                boundedKnowledgePush(knowledge.decision_log, {
                    at: now,
                    type: persisted.savedSource.duplicate ? 'source_referenced' : 'source_uploaded',
                    sourceId: persisted.savedSource.id,
                    summary: `${persisted.savedSource.duplicate ? 'Referenced existing' : 'Uploaded'} project source: ${persisted.savedSource.name}`
                }, 120);
                compactProjectKnowledge(projectData, { now });
                return projectData;
            });

            const knowledge = ensureProjectKnowledge(updatedProject);
            const savedSource = knowledge.source_registry.find(source => source.id === uploadResult?.id);
            res.json({
                ok: true,
                savedSource: savedSource ? { ...summarizeSourceForClient(savedSource), duplicate: !!uploadResult?.duplicate } : null,
                knowledge: knowledgePayloadForClient(knowledge, updatedProject)
            });
        } catch (error) {
            console.error('knowledge source upload error:', error.message);
            sendApiError(res, error, 'Failed to upload source');
        }
    });

    app.get('/api/projects/:id/knowledge/sources/:sourceId/assets/:assetKind', requireAuth, async (req, res) => {
        try {
            const { id, sourceId, assetKind } = req.params;
            assertValidProjectId(id, 'Invalid project ID or source ID');
            assertValidSourceId(sourceId, 'Invalid project ID or source ID');
            if (!['extracted', 'original', 'text'].includes(assetKind)) {
                throw new BadRequestError('Invalid source asset type');
            }

            const projectData = await readProjectJSONById(id);
            const asset = await readKnowledgeSourceAssetForClient(projectData, id, sourceId, assetKind);

            if (asset.buffer) {
                const disposition = req.query?.download === '1' ? 'attachment' : 'inline';
                res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
                res.setHeader('Content-Disposition', `${disposition}; filename="${contentDispositionFilename(asset.filename, 'source')}"`);
                res.send(asset.buffer);
                return;
            }

            if (req.query?.format === 'json') {
                res.json({
                    source: asset.source,
                    assetKind: asset.assetKind,
                    filename: asset.filename,
                    mimeType: asset.mimeType,
                    charCount: asset.charCount,
                    content: asset.content
                });
                return;
            }

            res.setHeader('Content-Type', asset.mimeType || 'text/plain; charset=utf-8');
            res.send(asset.content || '');
        } catch (error) {
            console.error('knowledge source asset error:', error.message);
            sendApiError(res, error, 'Failed to load source asset');
        }
    });

    app.delete('/api/projects/:id/knowledge/sources/:sourceId', requireAuth, async (req, res) => {
        try {
            const { id, sourceId } = req.params;
            assertValidProjectId(id, 'Invalid project ID or source ID');
            assertValidSourceId(sourceId, 'Invalid project ID or source ID');
            await assertProjectExists(id);

            const updatedProject = await updateProjectJSON(id, (projectData) => {
                removeKnowledgeSource(projectData, sourceId);
                return projectData;
            });
            await removeKnowledgeSourceAssets(id, sourceId).catch(error => {
                console.error('source asset cleanup error:', error.message);
            });
            const knowledge = ensureProjectKnowledge(updatedProject);
            res.json({
                ok: true,
                knowledge: knowledgePayloadForClient(knowledge, updatedProject)
            });
        } catch (error) {
            console.error('knowledge source delete error:', error.message);
            sendApiError(res, error, 'Failed to delete source');
        }
    });

    app.patch('/api/projects/:id/knowledge/sources/:sourceId', requireAuth, async (req, res) => {
        try {
            const { id, sourceId } = req.params;
            assertValidProjectId(id, 'Invalid project ID or source ID');
            assertValidSourceId(sourceId, 'Invalid project ID or source ID');
            await assertProjectExists(id);

            const { type, tags } = req.body || {};
            if (type !== undefined && !SOURCE_TYPE_OPTIONS.has(type)) {
                throw new BadRequestError('Invalid source type');
            }

            const updatedProject = await updateProjectJSON(id, (projectData) => {
                updateKnowledgeSourceMetadata(projectData, sourceId, { type, tags });
                return projectData;
            });
            const knowledge = ensureProjectKnowledge(updatedProject);
            const updatedSource = knowledge.source_registry.find(source => source.id === sourceId);
            res.json({
                ok: true,
                source: updatedSource ? summarizeSourceForClient(updatedSource) : null,
                knowledge: knowledgePayloadForClient(knowledge, updatedProject),
                diagnostics: buildKnowledgeDiagnostics(updatedProject)
            });
        } catch (error) {
            console.error('knowledge source update error:', error.message);
            sendApiError(res, error, 'Failed to update source');
        }
    });

    app.post('/api/projects/:id/knowledge/decision', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            await assertProjectExists(id);

            const { type, stageId, summary, details, audit } = req.body || {};
            const numericStageId = stageId === undefined || stageId === null || stageId === '' ? null : Number(stageId);
            if (numericStageId && !STAGE_NAMES[numericStageId]) {
                throw new BadRequestError('Invalid stage ID');
            }

            const cleanType = /^[a-z0-9_-]{1,60}$/i.test(type || '') ? type : 'project_knowledge_decision';
            const cleanSummary = compactText(summary || details || summarizeAuditForDecision(audit), 1_000);
            if (!cleanSummary) throw new BadRequestError('Decision summary is required');

            const updatedProject = await updateProjectJSON(id, (projectData) => {
                const knowledge = ensureProjectKnowledge(projectData);
                const now = new Date().toISOString();
                const entry = {
                    at: now,
                    type: cleanType,
                    stageId: numericStageId,
                    summary: cleanSummary
                };
                if (details) entry.details = compactText(details, 2_000);
                if (audit) entry.audit = compactAuditForKnowledge(audit);

                boundedKnowledgePush(knowledge.decision_log, entry, 120);
                if (numericStageId) {
                    knowledge.stage_handoffs[`stage${numericStageId}`] = {
                        at: now,
                        type: cleanType,
                        summary: cleanSummary
                    };
                }
                compactProjectKnowledge(projectData, { now });
                return projectData;
            });

            const knowledge = ensureProjectKnowledge(updatedProject);
            res.json({ ok: true, knowledge: knowledgePayloadForClient(knowledge, updatedProject) });
        } catch (error) {
            console.error('knowledge decision log error:', error.message);
            sendApiError(res, error, 'Failed to log project knowledge decision');
        }
    });

    app.post('/api/projects/:id/knowledge/accepted-divergence', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            await assertProjectExists(id);

            const { stageId, summary, audit } = req.body || {};
            const numericStageId = Number(stageId);
            if (!numericStageId || !STAGE_NAMES[numericStageId]) {
                throw new BadRequestError('Invalid stage ID');
            }

            const updatedProject = await updateProjectJSON(id, (projectData) => {
                recordAcceptedSourceDivergence(projectData, { stageId: numericStageId, summary, audit });
                return projectData;
            });

            const knowledge = ensureProjectKnowledge(updatedProject);
            res.json({ ok: true, knowledge: knowledgePayloadForClient(knowledge, updatedProject) });
        } catch (error) {
            console.error('accepted divergence log error:', error.message);
            sendApiError(res, error, 'Failed to save accepted source divergence');
        }
    });

    app.post('/api/projects/:id/knowledge/propose-stage-curation', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);

            const { stageId, stageDataOverride } = req.body || {};
            const numericStageId = Number(stageId);
            if (!numericStageId || !STAGE_NAMES[numericStageId]) {
                throw new BadRequestError('Invalid stage ID');
            }

            const projectData = await readProjectJSONById(id);
            const builtStage = await buildStageDataForAssistant(projectData, numericStageId);
            const stageName = builtStage.stageName;
            const overrideText = stageDataOverrideToText(stageDataOverride);
            const stageData = overrideText === null ? builtStage.stageData : overrideText;
            const fallback = buildFallbackStageCuration(numericStageId, stageName, stageData);

            const knowledgeContext = buildKnowledgeContextBlock(projectData, {
                stageId: numericStageId,
                userMessage: `Curate project memory after approving ${stageName}.`,
                stageName,
                stageData,
                maxChars: 14_000
            });
            const curationSchema = {
                type: 'object',
                properties: {
                    handoff_summary: { type: 'string' },
                    continuity_watchlist_additions: { type: 'array', items: { type: 'string' } },
                    source_bible_notes: { type: 'array', items: { type: 'string' } },
                    decision_summary: { type: 'string' }
                },
                required: ['handoff_summary', 'continuity_watchlist_additions', 'source_bible_notes', 'decision_summary']
            };
            const prompt = `${knowledgeContext || 'No persistent project source knowledge has been saved yet.'}

---

## APPROVED STAGE OUTPUT
Stage ${numericStageId}: ${stageName}
${compactText(stageData, 42_000)}

---

Propose compact project-memory updates for downstream screenplay stages.
Rules:
- The handoff_summary should tell later assistants what creative facts and decisions this approved stage establishes.
- continuity_watchlist_additions should include only concrete items worth tracking later.
- source_bible_notes are project adaptation notes derived from this stage; do not rewrite source canon or invent source facts.
- Keep every item concise and actionable.`;

            try {
                const modelCfg = getModelConfig(numericStageId);
                const response = await generateContent({
                    model: modelCfg.model,
                    geminiApiKey: modelCfg.geminiApiKey,
                    anthropicApiKey: modelCfg.anthropicApiKey,
                    contents: prompt,
                    config: {
                        systemInstruction: 'You are a screenplay project memory curator. Propose compact handoff and continuity memory updates from an approved stage. Never overwrite source canon; distinguish project adaptation choices from source facts.',
                        temperature: 0.2,
                        maxOutputTokens: 5000
                    },
                    schema: curationSchema
                });
                const proposal = safeParse(response.text, null);
                if (!proposal) throw new Error('Curation response was not valid JSON');
                trackUsage(id, response.usage);
                return res.json({
                    stageId: numericStageId,
                    stageName,
                    proposal: sanitizeStageCurationProposal(proposal, { stageId: numericStageId, stageName, stageData })
                });
            } catch (aiError) {
                console.warn('stage curation proposal fell back:', aiError.message);
                return res.json({
                    stageId: numericStageId,
                    stageName,
                    fallback: true,
                    proposal: fallback
                });
            }
        } catch (error) {
            console.error('stage curation proposal error:', error.message);
            sendApiError(res, error, 'Failed to propose project memory updates');
        }
    });

    app.post('/api/projects/:id/knowledge/apply-stage-curation', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            await assertProjectExists(id);

            const { stageId, proposal } = req.body || {};
            const numericStageId = Number(stageId);
            if (!numericStageId || !STAGE_NAMES[numericStageId]) {
                throw new BadRequestError('Invalid stage ID');
            }

            const updatedProject = await updateProjectJSON(id, (projectData) => {
                applyStageCurationToKnowledge(projectData, { stageId: numericStageId, proposal });
                return projectData;
            });

            const knowledge = ensureProjectKnowledge(updatedProject);
            res.json({ ok: true, knowledge: knowledgePayloadForClient(knowledge, updatedProject) });
        } catch (error) {
            console.error('stage curation apply error:', error.message);
            sendApiError(res, error, 'Failed to apply project memory updates');
        }
    });

    app.post('/api/projects/:id/knowledge/refresh-stage-handoff', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            await assertProjectExists(id);

            const { stageId, stageDataOverride } = req.body || {};
            const numericStageId = Number(stageId);
            if (!numericStageId || !STAGE_NAMES[numericStageId]) {
                throw new BadRequestError('Invalid stage ID');
            }

            const updatedProject = await updateProjectJSON(id, async (projectData) => {
                const builtStage = await buildStageDataForAssistant(projectData, numericStageId);
                const overrideText = stageDataOverrideToText(stageDataOverride);
                const stageData = overrideText === null ? builtStage.stageData : overrideText;
                refreshStageHandoff(projectData, numericStageId, stageData);
                return projectData;
            });

            const knowledge = ensureProjectKnowledge(updatedProject);
            res.json({
                ok: true,
                handoff: knowledge.stage_handoffs[`stage${numericStageId}`] || null,
                knowledge: knowledgePayloadForClient(knowledge, updatedProject)
            });
        } catch (error) {
            console.error('stage handoff refresh error:', error.message);
            sendApiError(res, error, 'Failed to refresh stage handoff');
        }
    });

    app.get('/api/projects/:id/knowledge/diagnostics', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;

            const projectData = await readProjectJSONById(id);
            res.json({ diagnostics: buildKnowledgeDiagnostics(projectData) });
        } catch (error) {
            console.error('knowledge diagnostics error:', error.message);
            sendApiError(res, error, 'Failed to inspect project knowledge');
        }
    });

    app.post('/api/projects/:id/knowledge/compact', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            await assertProjectExists(id);

            const updatedProject = await updateProjectJSON(id, (projectData) => {
                compactProjectKnowledge(projectData, {
                    recordDecision: true,
                    reason: 'project_memory_compacted'
                });
                return projectData;
            });
            const knowledge = ensureProjectKnowledge(updatedProject);
            res.json({
                ok: true,
                knowledge: knowledgePayloadForClient(knowledge, updatedProject),
                diagnostics: buildKnowledgeDiagnostics(updatedProject)
            });
        } catch (error) {
            console.error('knowledge compact error:', error.message);
            sendApiError(res, error, 'Failed to compact project memory');
        }
    });

    app.put('/api/projects/:id/knowledge/review', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            await assertProjectExists(id);

            const updatedProject = await updateProjectJSON(id, (projectData) => {
                updateKnowledgeReview(projectData, req.body || {});
                return projectData;
            });

            const knowledge = ensureProjectKnowledge(updatedProject);
            res.json({
                ok: true,
                knowledge: knowledgePayloadForClient(knowledge, updatedProject),
                diagnostics: buildKnowledgeDiagnostics(updatedProject)
            });
        } catch (error) {
            console.error('knowledge review update error:', error.message);
            sendApiError(res, error, 'Failed to update project memory review');
        }
    });

    app.post('/api/projects/:id/knowledge/rebuild-source-bible', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { id } = req.params;

            const projectData = await readProjectJSONById(id);
            const knowledge = ensureProjectKnowledge(projectData);
            if (!knowledge.source_registry.length) {
                throw new BadRequestError('No source documents saved yet');
            }

            const sourceMaterial = buildSourceBiblePrompt(knowledge);
            const sourceBibleSchema = {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                    canon_facts: { type: 'array', items: { type: 'string' } },
                    characters: { type: 'array', items: { type: 'string' } },
                    settings: { type: 'array', items: { type: 'string' } },
                    timeline: { type: 'array', items: { type: 'string' } },
                    rules: { type: 'array', items: { type: 'string' } },
                    must_keep_elements: { type: 'array', items: { type: 'string' } },
                    continuity_watchlist: { type: 'array', items: { type: 'string' } },
                    open_questions: { type: 'array', items: { type: 'string' } }
                },
                required: ['summary', 'canon_facts', 'characters', 'settings', 'timeline', 'rules', 'must_keep_elements', 'continuity_watchlist', 'open_questions']
            };
            const modelCfg = getModelConfig(3);
            const response = await generateContent({
                model: modelCfg.model,
                geminiApiKey: modelCfg.geminiApiKey,
                anthropicApiKey: modelCfg.anthropicApiKey,
                contents: `Build a compact source bible for this project from the saved source documents below.

Rules:
- Extract only facts supported by the source text.
- Keep items concise and screenplay-development useful.
- If a fact is ambiguous, put it in open_questions rather than canon_facts.
- Do not invent missing plot, character, setting, or timeline information.

SAVED SOURCE DOCUMENTS:
${sourceMaterial}`,
                config: {
                    systemInstruction: 'You are a story canon archivist. Convert source documents into a compact, structured source bible for downstream screenplay generation.',
                    temperature: 0.2,
                    maxOutputTokens: 12000
                },
                schema: sourceBibleSchema
            });

            const extracted = safeParse(response.text, null);
            if (!extracted) throw new Error('Source bible response was not valid JSON');

            const updatedProject = await updateProjectJSON(id, (freshProject) => {
                const freshKnowledge = ensureProjectKnowledge(freshProject);
                const now = new Date().toISOString();
                const sourceIds = freshKnowledge.source_registry.map(source => source.id);
                const curatedNotes = Array.isArray(freshKnowledge.source_bible?.curated_notes)
                    ? freshKnowledge.source_bible.curated_notes
                    : [];
                freshKnowledge.source_bible = {
                    ...extracted,
                    curated_notes: curatedNotes,
                    sources_summary: (freshKnowledge.source_registry || []).slice(-20).map(source => {
                        const descriptor = source.summary || compactText(source.text || source.chunks?.[0]?.text || '', 700);
                        return `- ${source.name} (${source.type || 'source'}, ${source.uploadedAt || 'unknown date'}): ${descriptor}`;
                    }).join('\n'),
                    updatedAt: now,
                    sourceIds,
                    sourceCount: sourceIds.length
                };
                const watchItems = [
                    ...(freshKnowledge.continuity_watchlist || []).map(formatKnowledgeItem),
                    ...(extracted.continuity_watchlist || [])
                ].filter(Boolean);
                freshKnowledge.continuity_watchlist = Array.from(new Set(watchItems)).slice(-40);
                boundedKnowledgePush(freshKnowledge.decision_log, {
                    at: now,
                    type: 'source_bible_rebuilt',
                    summary: `Rebuilt source bible from ${sourceIds.length} source document${sourceIds.length === 1 ? '' : 's'}.`
                }, 120);
                compactProjectKnowledge(freshProject, { now });
                return freshProject;
            });

            trackUsage(id, response.usage);
            const updatedKnowledge = ensureProjectKnowledge(updatedProject);
            res.json({
                knowledge: knowledgePayloadForClient(updatedKnowledge, updatedProject)
            });
        } catch (error) {
            console.error('source bible rebuild error:', error.message);
            sendApiError(res, error, 'Failed to rebuild source bible');
        }
    });
}

module.exports = {
    registerKnowledgeRoutes
};
