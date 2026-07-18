function registerGenerationRoutes(app, deps) {
    const {
        requireAuth,
        aiLimiter,
        upload,
        fs,
        isValidProjectId,
        BadRequestError,
        NotFoundError,
        ApiError,
        sendApiError,
        safeParse,
        readProjectJSONById,
        writeJSONQueued,
        getProjectFilePath,
        updateProjectJSON,
        prepareGenerationUpload,
        appendUploadedSourceBlock,
        buildSourceGenerationPacket,
        getModelConfig,
        getModelConfigWithSourcePacket,
        withAbortSignal,
        sourceResponseExtras,
        sourcePlanDataHash,
        recordSourceGenerationUsage,
        trackUsage,
        prepareGenerationProjectContext,
        deriveStage4BeatsFromStage2Outline,
        finalizeGenerationEndpointArtifact,
        completeGenerationEndpoint,
        createClientAbortTracker,
        isClientAbortError,
        publicErrorDetail,
        stage2ProtectedBeatEntriesForRequest,
        applyStageRevisionPlan,
        createVerifiedGenerationRevision,
        createRevisionTransaction,
        outlineRevisionAdapter,
        characterRevisionAdapter,
        treatmentRevisionAdapter,
        sceneBlueprintRevisionAdapter,
        buildOutlineRevisionChecklist,
        findUndercoveredOutlineChecklistItems,
        appendMissingOutlineChecklistBeats,
        extractExplicitOutlineSequenceReplacement,
        applyExplicitOutlineSequenceReplacement,
        applyStructuralOutlinePatches,
        sanitizeOutlineMetaBeats,
        compactText,
        agent1Pitch,
        agent1Refine,
        agent2Outline,
        agent3Characters,
        agent5Treatment,
        generateStage6Scenes,
        reviseStage6Scenes,
        runStage6SceneAudit,
        generateSceneDraft,
        humanizeDraft,
        findProjectScene,
        clearSceneFacts,
        buildContinuityContext,
        buildStage8SceneLockPacket,
        loadProjectStyle,
        runContinuityCheck,
        applyCheckResult,
        resolveError,
        buildSourceAuthorityBlock,
        recordArtifactMutation,
        normalizeStage3CharactersForPipeline,
        hashBlueprintScenes,
        mergeDismissedFlags
    } = deps;

    function savedStage6Audit(projectData = {}) {
        return projectData.data?.stage6_scenes_audit || projectData.data?.stage6_scenes?.audit || {};
    }

    function buildStage6AuditPayload(sequences, auditResult, previousAudit = {}, blueprintHash = null) {
        return {
            generated_at: new Date().toISOString(),
            blueprint_hash: blueprintHash || hashBlueprintScenes(sequences || []),
            flags: mergeDismissedFlags(previousAudit, auditResult.flags || []),
            candidate_count: auditResult.candidateCount || 0,
            dropped_candidates: auditResult.dropped || 0,
            skipped_candidates: auditResult.skipped || []
        };
    }

    async function runAndPersistStage6Audit(projectId) {
        const projectData = await readProjectJSONById(projectId, { invalidMessage: 'Invalid projectId' });
        const sequences = projectData.data?.stage6_scenes;
        if (!Array.isArray(sequences) && !Array.isArray(sequences?.sequences) && !Array.isArray(sequences?.scenes)) {
            throw new BadRequestError('No Stage 6 scene blueprint found to audit');
        }
        const auditedHash = hashBlueprintScenes(sequences);
        const auditResult = await runStage6SceneAudit(sequences, getModelConfig(6));
        let savedAudit = null;
        await updateProjectJSON(projectId, (freshProject) => {
            freshProject.data = freshProject.data || {};
            const freshSequences = freshProject.data.stage6_scenes || sequences;
            savedAudit = buildStage6AuditPayload(sequences, auditResult, savedStage6Audit(freshProject), auditedHash);
            if (hashBlueprintScenes(freshSequences) !== auditedHash) {
                savedAudit.stale_on_arrival = true;
            }
            freshProject.data.stage6_scenes_audit = savedAudit;
            return freshProject;
        });
        trackUsage(projectId, auditResult.usageList || []);
        return savedAudit;
    }

    function kickStage6Audit(projectId, label) {
        if (!projectId) return;
        runAndPersistStage6Audit(projectId).catch(error => {
            console.warn(`${label || 'Stage 6 audit'} failed non-fatally:`, error.message);
        });
    }

    // Insert/replace one sequence into a blueprint array, keeping it ordered by
    // sequence_number. Used to persist Stage 6 sequences incrementally as each
    // one finishes, so a broken/paused generation leaves a resumable partial.
    function upsertSequence(list, seq) {
        const out = (Array.isArray(list) ? list : []).filter(
            (s) => Number(s?.sequence_number) !== Number(seq?.sequence_number)
        );
        out.push(seq);
        out.sort((a, b) => (Number(a?.sequence_number) || 0) - (Number(b?.sequence_number) || 0));
        return out;
    }

    // API route
    app.post('/api/execute', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
        try {
            const { prompt, projectId } = req.body;
            const uploadedFile = req.file;
            let projectData = null;
            let sourcePacket = null;
            let uploadContext = null;

            if (projectId) {
                projectData = await readProjectJSONById(projectId, { invalidMessage: 'Invalid projectId' });
                uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 1, userMessage: prompt || 'Generate pitch options.' });
                const stage1Prompt = appendUploadedSourceBlock(prompt, uploadContext);
                const stage1Seed = `${stage1Prompt || 'Generate pitch options.'}\n${uploadContext?.attachment?.name || ''}`;
                sourcePacket = buildSourceGenerationPacket(projectData, 1, stage1Seed, { userMessage: stage1Prompt || prompt || '' });
            } else {
                uploadContext = await prepareGenerationUpload(null, uploadedFile);
            }

            // Validation intentionally omitted — allows random pitch generation with no input

            console.log("Generating pitch options...");
            const promptWithUpload = appendUploadedSourceBlock(prompt, uploadContext);
            const { result, usage } = await agent1Pitch(
                promptWithUpload,
                uploadContext?.agentFile || null,
                sourcePacket ? getModelConfigWithSourcePacket(1, sourcePacket) : getModelConfig(1)
            );
            if (projectData && sourcePacket) {
                recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(result, null, 2), 'pitch_generation');
                await writeJSONQueued(getProjectFilePath(projectId), projectData);
                trackUsage(projectId, usage);
            }
            res.json({ result, ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error("Error executing agent:", error);
            sendApiError(res, error, "Failed to generate pitch");
        }
    });

    app.post('/api/refine-pitch', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
        try {
            const { currentPitch, userNote, projectId } = req.body || {};
            const uploadedFile = req.file;

            if (!currentPitch || !userNote) {
                throw new BadRequestError("Missing currentPitch or userNote");
            }

            // currentPitch might be a string if sent via FormData
            const parsedPitch = safeParse(currentPitch);
            if (!parsedPitch) throw new BadRequestError("Invalid currentPitch JSON");
            let projectData = null;
            let sourcePacket = null;
            let uploadContext = null;
            if (projectId) {
                projectData = await readProjectJSONById(projectId, { invalidMessage: 'Invalid projectId' });
                uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 1, userMessage: userNote, forceTextBlock: true });
                const userNoteWithUpload = appendUploadedSourceBlock(userNote, uploadContext);
                const stage1Seed = `${JSON.stringify(parsedPitch, null, 2)}\n${userNoteWithUpload}\n${uploadContext?.attachment?.name || ''}`;
                sourcePacket = buildSourceGenerationPacket(projectData, 1, stage1Seed, { userMessage: userNoteWithUpload });
            } else {
                uploadContext = await prepareGenerationUpload(null, uploadedFile, { forceTextBlock: true });
            }
            const userNoteWithUpload = appendUploadedSourceBlock(userNote, uploadContext);

            console.log("Revising pitch...");
            const { result, usage } = await agent1Refine(
                JSON.stringify(parsedPitch),
                userNoteWithUpload,
                uploadContext?.agentFile || null,
                sourcePacket ? getModelConfigWithSourcePacket(1, sourcePacket) : getModelConfig(1)
            );
            const changed = sourcePlanDataHash(JSON.stringify(parsedPitch)) !== sourcePlanDataHash(JSON.stringify(result || {}));
            if (projectData && sourcePacket) {
                recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(result, null, 2), 'pitch_revision');
                await writeJSONQueued(getProjectFilePath(projectId), projectData);
                trackUsage(projectId, usage);
            }
            res.json({ result, changed, ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error("Error executing refine agent:", error);
            sendApiError(res, error, "Failed to refine pitch");
        }
    });

    app.post('/api/generate-outline', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
        const wantsStream = req.body?.stream === true ||
            req.body?.stream === 'true' ||
            /\btext\/event-stream\b/i.test(req.headers.accept || '');
        let streaming = false;
        let heartbeat = null;
        const abortTracker = wantsStream ? createClientAbortTracker(res, 'Stage 2 outline stream') : null;

        const send = (data) => {
            if (streaming && !abortTracker?.signal.aborted && !res.destroyed && !res.writableEnded) {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            }
        };

        const startStream = () => {
            if (!wantsStream || streaming) return;
            streaming = true;
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();
            heartbeat = setInterval(() => {
                if (!abortTracker?.signal.aborted && !res.destroyed && !res.writableEnded) {
                    res.write(': keep-alive\n\n');
                }
            }, 15000);
            heartbeat.unref?.();
        };

        try {
            const { projectId, currentBeats, notes } = req.body;
            const uploadedFile = req.file;

            const context = await prepareGenerationProjectContext(req, res, {
                projectId,
                validate: (project) => project.data?.stage1_pitch?.pitch
                    ? null
                    : 'Project has no finalized Stage 1 Pitch'
            });
            if (!context) return;
            const { projectData } = context;
            const stage1 = projectData.data?.stage1_pitch?.pitch;

            const parsedBeats = currentBeats ? (safeParse(currentBeats, null)) : null;
            const activeProtectedBeatEntries = stage2ProtectedBeatEntriesForRequest(projectData, req.body?.protectedBeats);
            const activeProtectedBeats = activeProtectedBeatEntries.map(beat => beat.label);
            const beforeOutlineForChangeCheck = parsedBeats || projectData.data?.stage2_outline?.outline || {};
            const beforeOutlineHash = sourcePlanDataHash(JSON.stringify(beforeOutlineForChangeCheck));
            startStream();
            send({ type: 'progress', label: notes ? 'Revising outline...' : 'Generating outline...' });

            const uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 2, userMessage: notes || '', forceTextBlock: true });
            const notesWithUpload = appendUploadedSourceBlock(notes, uploadContext);

            if (notesWithUpload && !uploadedFile) {
                const deterministicRevision = applyStageRevisionPlan({
                    stageId: 'stage2_outline',
                    artifact: beforeOutlineForChangeCheck,
                    notes: notesWithUpload,
                    protectedBeats: activeProtectedBeatEntries
                });
                if (deterministicRevision?.plan?.canApplyDirectly && !deterministicRevision?.receipt?.verified) {
                    const failures = deterministicRevision.receipt?.failures || [];
                    const failureList = failures
                        .map(failure => failure.newLabel || failure.oldLabel || failure.reason || failure.type || 'requested edit')
                        .filter(Boolean)
                        .slice(0, 5)
                        .join('; ');
                    throw new Error(`Stage 2 deterministic outline revision failed verification${failureList ? `: ${failureList}` : ''}`);
                }
                // Only early-return when the deterministic plan produced a REAL
                // change. A verified plan whose ops are all no-ops (e.g.
                // ensure-present for beats that already exist, triggered by a
                // brief that merely MENTIONS a protected label + a word like
                // "missing"/"keep") used to return success with `changed:true`
                // while the outline stayed identical and the model was never
                // consulted — the writer's actual request was silently swallowed
                // (reproduced 2026-07-18 with the Dearly Beloved cold-open brief
                // against a project with protected beats). No-op plans fall
                // through to the full agent revision instead.
                if (deterministicRevision?.receipt?.verified && deterministicRevision.plan?.canApplyDirectly && deterministicRevision.changed === true) {
                    abortTracker?.throwIfAborted();
                    const existingStage2 = projectData.data?.stage2_outline || {};
                    const outlineData = {
                        title: existingStage2.title || stage1.title || projectData.title || 'Untitled',
                        genre: existingStage2.genre || stage1.genre || '',
                        logline: existingStage2.logline || stage1.logline || '',
                        ...existingStage2,
                        outline: deterministicRevision.after,
                        protected_beats: activeProtectedBeats
                    };
                    sanitizeOutlineMetaBeats(outlineData);
                    deterministicRevision.receipt.changed = deterministicRevision.changed;
                    const afterOutlineHash = sourcePlanDataHash(JSON.stringify(outlineData.outline || {}));
                    let derivedStage4Beats = null;
                    const { snapshotIds } = await finalizeGenerationEndpointArtifact({
                        context,
                        stage: 2,
                        stageKey: 'stage2_outline',
                        result: outlineData,
                        before: { outline: beforeOutlineForChangeCheck },
                        operation: 'revision',
                        note: notesWithUpload,
                        revisionReceipt: deterministicRevision.receipt,
                        changed: true,
                        afterStageStamp: (projectData) => {
                            derivedStage4Beats = deriveStage4BeatsFromStage2Outline(projectData, {
                                projectId,
                                stage2Outline: outlineData,
                                operation: 'derivation',
                                note: 'Derived from Stage 2 outline deterministic revision'
                            });
                        },
                        afterSave: async ({ filePath }) => {
                            const savedContent = await fs.readFile(filePath, 'utf-8');
                            const savedProjectData = JSON.parse(savedContent);
                            const savedOutlineHash = sourcePlanDataHash(JSON.stringify(savedProjectData.data?.stage2_outline?.outline || {}));
                            if (savedOutlineHash !== afterOutlineHash) {
                                throw new Error('Stage 2 deterministic outline save verification failed: saved project JSON does not match revised outline.');
                            }
                        }
                    });

                    const payload = {
                        result: outlineData,
                        changed: true, // branch is only reachable when deterministicRevision.changed === true
                        saveVerified: true,
                        revisionReceipt: deterministicRevision.receipt,
                        snapshotIds,
                        derivedStage4Beats,
                        deterministicRevision: true
                    };
                    completeGenerationEndpoint({ res, streaming, send, payload });
                    return;
                }
            }

            console.log("Generating Stage 2 Outline...");
            const stage2KnowledgeSeed = `${JSON.stringify(stage1, null, 2)}\n${parsedBeats ? JSON.stringify(parsedBeats, null, 2) : ''}\n${notesWithUpload}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 2, stage2KnowledgeSeed, { userMessage: notesWithUpload });
            const { result: outlineData, usage } = await agent2Outline(
                stage1,
                parsedBeats,
                notesWithUpload,
                uploadContext.agentFile,
                withAbortSignal(getModelConfigWithSourcePacket(2, sourcePacket), abortTracker?.signal)
            );
            abortTracker?.throwIfAborted();
            outlineData.protected_beats = activeProtectedBeats;
            // Checklist enforcement (semantic verification + repair + honest
            // STAGE2_CHECKLIST_UNMET) lives inside agent2Outline — it is the
            // single authority. The route-level lexical re-check that used to
            // sit here produced false failures on paraphrased-but-applied
            // revisions (removed 2026-07-18).
            const explicitSequenceReplacement = notesWithUpload ? extractExplicitOutlineSequenceReplacement(notesWithUpload) : null;
            if (explicitSequenceReplacement) {
                applyExplicitOutlineSequenceReplacement(outlineData, explicitSequenceReplacement);
            }
            let structuralOutlinePatch = null;
            if (notesWithUpload && outlineData?.outline) {
                structuralOutlinePatch = applyStructuralOutlinePatches(outlineData.outline, notesWithUpload);
            }
            sanitizeOutlineMetaBeats(outlineData);
            const afterOutlineHash = sourcePlanDataHash(JSON.stringify(outlineData?.outline || {}));
            const revisionTransaction = createVerifiedGenerationRevision({
                enabled: !!notesWithUpload,
                label: 'Stage 2 outline',
                build: () => createRevisionTransaction({
                    stageId: 'stage2_outline',
                    before: beforeOutlineForChangeCheck,
                    after: outlineData?.outline || {},
                    notes: notesWithUpload,
                    structuralPatch: structuralOutlinePatch,
                    adapter: outlineRevisionAdapter
                })
            });
            const changed = !notesWithUpload || revisionTransaction.changed;
            const operation = notesWithUpload ? 'revision' : 'generation';
            let derivedStage4Beats = null;
            const { snapshotIds } = await finalizeGenerationEndpointArtifact({
                context,
                stage: 2,
                stageKey: 'stage2_outline',
                result: outlineData,
                before: { outline: beforeOutlineForChangeCheck },
                operation,
                note: notesWithUpload || '',
                revisionReceipt: revisionTransaction?.receipt || null,
                changed,
                sourcePacket,
                usage,
                sourceReason: operation,
                afterStageStamp: (projectData) => {
                    derivedStage4Beats = deriveStage4BeatsFromStage2Outline(projectData, {
                        projectId,
                        stage2Outline: outlineData,
                        operation: 'derivation',
                        note: `Derived from Stage 2 outline ${operation}`
                    });
                },
                afterSave: async ({ filePath }) => {
                    const savedContent = await fs.readFile(filePath, 'utf-8');
                    const savedProjectData = JSON.parse(savedContent);
                    const savedOutlineHash = sourcePlanDataHash(JSON.stringify(savedProjectData.data?.stage2_outline?.outline || {}));
                    if (savedOutlineHash !== afterOutlineHash) {
                        throw new Error('Stage 2 outline save verification failed: saved project JSON does not match generated outline.');
                    }
                }
            });

            const payload = {
                result: outlineData,
                changed,
                saveVerified: true,
                revisionReceipt: revisionTransaction?.receipt,
                snapshotIds,
                derivedStage4Beats,
                checklistVerified: revisionChecklist.length > 0,
                ...sourceResponseExtras(sourcePacket)
            };
            completeGenerationEndpoint({ res, streaming, send, payload });
        } catch (error) {
            if (isClientAbortError(error)) {
                console.warn('Stage 2 outline stream stopped after client disconnect.');
                return;
            }
            console.error('Outline Gen Error:', error);
            if (streaming) {
                const detail = publicErrorDetail(error);
                const message = detail ? `Failed to generate outline: ${detail}` : 'Failed to generate outline';
                send({ type: 'error', message });
            } else {
                sendApiError(res, error, 'Failed to generate outline');
            }
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            abortTracker?.markComplete();
            if (streaming && !res.destroyed && !res.writableEnded) res.end();
        }
    });

    app.post('/api/generate-characters', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
        try {
            const { projectId, currentCharacters, notes, tierOverrides } = req.body;
            const uploadedFile = req.file;

            const context = await prepareGenerationProjectContext(req, res, {
                projectId,
                notFoundLog: 'generate-characters: failed to load project',
                validate: (project) => {
                    const pitchData = project.data?.stage1_pitch?.pitch;
                    const beatsData = project.data?.stage2_outline?.outline;
                    return (!pitchData || !beatsData)
                        ? 'Project requires Stage 1 Pitch and Stage 2 Outline to generate Characters'
                        : null;
                }
            });
            if (!context) return;
            const { projectData } = context;
            const pitchData = projectData.data?.stage1_pitch?.pitch;
            const beatsData = projectData.data?.stage2_outline?.outline;

            const parsedChars = currentCharacters ? safeParse(currentCharacters, null) : null;
            const parsedTierOverrides = tierOverrides ? safeParse(tierOverrides, null) : null;
            const activeTierOverrides = parsedTierOverrides && typeof parsedTierOverrides === 'object' && !Array.isArray(parsedTierOverrides)
                ? parsedTierOverrides
                : (projectData.data?.stage3_characters?.tier_overrides || {});
            const beforeCharactersForRevision = parsedChars || projectData.data?.stage3_characters?.characters || [];

            console.log("Generating Stage 3 Characters...");
            const stage3KnowledgeSeed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${parsedChars ? JSON.stringify(parsedChars, null, 2) : ''}\n${notesWithUpload}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 3, stage3KnowledgeSeed, { userMessage: notesWithUpload });
            const { result: characterData, usage } = await agent3Characters(
                pitchData,
                beatsData,
                parsedChars,
                notesWithUpload,
                uploadContext.agentFile,
                {
                    ...getModelConfigWithSourcePacket(3, sourcePacket),
                    tierOverrides: activeTierOverrides
                }
            );
            characterData.tier_overrides = activeTierOverrides;
            const revisionTransaction = createVerifiedGenerationRevision({
                enabled: !!notesWithUpload,
                label: 'Stage 3 characters',
                build: () => createRevisionTransaction({
                    stageId: 'stage3_characters',
                    before: beforeCharactersForRevision,
                    after: characterData?.characters || [],
                    notes: notesWithUpload,
                    adapter: characterRevisionAdapter
                })
            });
            const changed = !notesWithUpload || revisionTransaction.changed;
            const operation = notesWithUpload ? 'revision' : 'generation';
            const { snapshotIds } = await finalizeGenerationEndpointArtifact({
                context,
                stage: 3,
                stageKey: 'stage3_characters',
                result: characterData,
                before: { characters: beforeCharactersForRevision },
                operation,
                note: notesWithUpload || '',
                revisionReceipt: revisionTransaction?.receipt || null,
                changed,
                sourcePacket,
                usage,
                sourceReason: operation
            });

            res.json({ result: characterData, changed, revisionReceipt: revisionTransaction?.receipt, snapshotIds, ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error('Character Gen Error:', error);
            sendApiError(res, error, "Failed to generate characters");
        }
    });

    app.post('/api/generate-stage5-treatment', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
        const { projectId } = req.body || {};
        const uploadedFile = req.file;
        let context;
        try {
            context = await prepareGenerationProjectContext(req, res, {
                projectId,
                validate: (project) => {
                    const pitchData = project.data?.stage1_pitch?.pitch;
                    const charactersData = project.data?.stage3_characters?.characters;
                    const beatsData = project.data?.stage4_beats?.hybrid_beat_sheet;
                    return (!pitchData || !charactersData || !beatsData)
                        ? 'Project requires Pitch, Outline-derived beat sheet, and Characters to generate Treatment'
                        : null;
                }
            });
        } catch (error) {
            console.error('Stage 5 Treatment Context Error:', error.message);
            sendApiError(res, error, 'Failed to generate treatment');
            return;
        }
        if (!context) return;
        const { projectData } = context;

        const pitchData = projectData.data?.stage1_pitch?.pitch;
        const charactersData = normalizeStage3CharactersForPipeline(projectData.data?.stage3_characters || {});
        const beatsData = projectData.data?.stage4_beats?.hybrid_beat_sheet;

        const { notes, currentTreatment } = req.body;
        const parsedTreatment = currentTreatment ? safeParse(currentTreatment, null) : null;
        const comparableCurrentTreatment = parsedTreatment && typeof parsedTreatment === 'object'
            ? Object.fromEntries(Object.entries(parsedTreatment).filter(([key]) => key !== 'notes'))
            : parsedTreatment;
        const beforeStage5ForRevision = comparableCurrentTreatment || projectData.data?.stage5_treatment || {};

        // SSE setup
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const abortTracker = createClientAbortTracker(res, 'Stage 5 treatment stream');

        const send = (data) => {
            if (!abortTracker.signal.aborted && !res.destroyed && !res.writableEnded) {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
                res.flush?.();
            }
        };
        const heartbeat = setInterval(() => {
            send({ type: 'heartbeat', label: 'Still generating treatment...' });
        }, 10000);
        heartbeat.unref?.();

        try {
            console.log("Generating Stage 5 Chained Treatment...");
            const uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 5, userMessage: notes || '', forceTextBlock: true });
            const notesWithUpload = appendUploadedSourceBlock(notes, uploadContext);
            const stage5KnowledgeSeed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(charactersData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${parsedTreatment ? JSON.stringify(parsedTreatment, null, 2) : ''}\n${notesWithUpload}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 5, stage5KnowledgeSeed, { userMessage: notesWithUpload });
            const { result: treatmentResult, usageList } = await agent5Treatment(
                pitchData, charactersData, beatsData, parsedTreatment, notesWithUpload,
                (step, total, label) => send({ type: 'progress', step, total, label }),
                withAbortSignal(getModelConfigWithSourcePacket(5, sourcePacket), abortTracker.signal)
            );
            abortTracker.throwIfAborted();
            const revisionTransaction = createVerifiedGenerationRevision({
                enabled: !!notesWithUpload,
                label: 'Stage 5 treatment',
                build: () => createRevisionTransaction({
                    stageId: 'stage5_treatment',
                    before: beforeStage5ForRevision,
                    after: treatmentResult || {},
                    notes: notesWithUpload,
                    adapter: treatmentRevisionAdapter
                })
            });
            const changed = !notesWithUpload || revisionTransaction.changed;
            const operation = notesWithUpload ? 'revision' : 'generation';
            const { snapshotIds } = await finalizeGenerationEndpointArtifact({
                context,
                stage: 5,
                stageKey: 'stage5_treatment',
                result: treatmentResult,
                before: beforeStage5ForRevision,
                operation,
                note: notesWithUpload || '',
                revisionReceipt: revisionTransaction?.receipt || null,
                changed,
                sourcePacket,
                usage: usageList,
                sourceReason: operation
            });

            send({ type: 'complete', result: treatmentResult, changed, revisionReceipt: revisionTransaction?.receipt, snapshotIds, ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            if (isClientAbortError(error)) {
                console.warn('Stage 5 treatment stream stopped after client disconnect.');
                return;
            }
            console.error('Stage 5 Treatment Gen Error:', error.message, error.stack);
            const detail = error?.message ? `: ${String(error.message).slice(0, 240)}` : '';
            send({ type: 'error', message: `Failed to generate treatment${detail}` });
        } finally {
            clearInterval(heartbeat);
            abortTracker.markComplete();
            if (!res.destroyed && !res.writableEnded) res.end();
        }
    });

    app.post('/api/generate-stage6-scenes', requireAuth, aiLimiter, async (req, res) => {
        const { projectId, notes, mode: rawMode, resume: rawResume } = req.body;
        const generationNotes = typeof notes === 'string' ? notes.trim() : '';
        // mode: 'auto' generates the whole remaining range in one stream;
        //       'manual' generates exactly one sequence then stops for review.
        // resume: continue an existing partial blueprint instead of starting fresh.
        const mode = rawMode === 'manual' ? 'manual' : 'auto';
        const resume = rawResume === true || rawResume === 'true';

        let context;
        try {
            context = await prepareGenerationProjectContext(req, res, {
                projectId,
                validate: (project) => {
                    const pitch = project.data?.stage1_pitch?.pitch;
                    const characters = project.data?.stage3_characters?.characters;
                    const beats = project.data?.stage4_beats?.hybrid_beat_sheet;
                    const treatment = project.data?.stage5_treatment;
                    return (!pitch || !characters || !beats || !treatment)
                        ? 'Project requires Pitch, Characters, Outline-derived beat sheet, and Treatment to generate Scene Blueprint'
                        : null;
                }
            });
        } catch (error) {
            console.error('Stage 6 Scene Context Error:', error.message);
            sendApiError(res, error, 'Failed to generate scene blueprint');
            return;
        }
        if (!context) return;
        const { projectData } = context;
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const characters = normalizeStage3CharactersForPipeline(projectData.data?.stage3_characters || {});
        const beats = projectData.data?.stage4_beats?.hybrid_beat_sheet;
        const treatment = projectData.data?.stage5_treatment;

        // --- Incremental / resumable planning ---
        const TOTAL_SEQUENCES = 8;
        const savedBlueprint = Array.isArray(projectData.data?.stage6_scenes) ? projectData.data.stage6_scenes : [];
        const beforeBlueprint = JSON.parse(JSON.stringify(savedBlueprint));
        // Resume only makes sense with a partial (1..7 sequences) blueprint on disk.
        const canResume = resume && savedBlueprint.length > 0 && savedBlueprint.length < TOTAL_SEQUENCES;
        const fromSequence = canResume ? savedBlueprint.length + 1 : 1;
        const toSequence = mode === 'manual' ? fromSequence : TOTAL_SEQUENCES;
        const existingSequences = canResume ? savedBlueprint : [];
        const cachedMeta = canResume ? (projectData.data?.stage6_meta || null) : null;
        let assembled = canResume ? [...savedBlueprint] : [];
        let currentMeta = cachedMeta;

        // SSE setup. This is the longest-running route in the app (8 sequential
        // model calls), so it is the most exposed to an edge proxy buffering or
        // killing a stream that looks idle. Mirrors the Stage 5 treatment route's
        // hardening exactly — Stage 6 was missing all of it and broke mid-stream
        // with a client-side "network error" (observed live 2026-07-15).
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const abortTracker = createClientAbortTracker(res, 'Stage 6 scene generation stream');

        const send = (data) => {
            if (!abortTracker.signal.aborted && !res.destroyed && !res.writableEnded) {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
                res.flush?.();
            }
        };
        // A real data event, not a `:` comment — comments can sit in a proxy
        // buffer and never reach the client, which defeats the point.
        const heartbeat = setInterval(() => {
            send({ type: 'heartbeat', label: 'Still generating scene blueprint...' });
        }, 10000);
        heartbeat.unref?.();

        try {
            console.log(`Generating Stage 6 Scene Blueprint (${mode}, sequences ${fromSequence}-${toSequence}${canResume ? ', resuming' : ''})...`);
            send({
                type: 'status',
                message: canResume
                    ? `Resuming from Sequence ${fromSequence}...`
                    : (generationNotes ? 'Preparing fresh blueprint with your notes...' : 'Preparing fresh blueprint...'),
                fromSequence, toSequence, total: TOTAL_SEQUENCES, mode
            });

            // NOTE: a fresh run overwrites the blueprint incrementally, but the
            // prior blueprint is already snapshotted to Version History by the
            // client (saveStage6SnapshotBeforeRegenerate) before this request —
            // so a mid-run break stays restorable without a second snapshot here.
            // A resume only ever appends, so it needs no snapshot at all.

            const sourceAuthorityBlock = buildSourceAuthorityBlock(projectData, 'stage6_scenes');
            if (sourceAuthorityBlock) {
                console.log("Stage 6: upstream revisions detected, injecting source authority block.");
            }
            const stage6KnowledgeSeed = `${JSON.stringify(pitch, null, 2)}\n${JSON.stringify(characters, null, 2)}\n${JSON.stringify(beats, null, 2)}\n${JSON.stringify(treatment, null, 2)}\n${generationNotes}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 6, stage6KnowledgeSeed, { userMessage: generationNotes });
            const combinedSourceBlock = [sourceAuthorityBlock, sourcePacket.contextBlock].filter(Boolean).join('\n\n---\n\n');

            // Cache the expensive setup artifacts (location scan + continuity
            // ledger) so a later manual "next sequence" call skips recomputing them.
            const onMeta = async (meta) => {
                currentMeta = meta;
                await updateProjectJSON(projectId, (p) => {
                    p.data = p.data || {};
                    p.data.stage6_meta = meta;
                    return p;
                });
                if (context.projectData?.data) context.projectData.data.stage6_meta = meta;
            };

            // Persist + stream each sequence the moment it lands. Mirror onto
            // context.projectData so the final finalize save stays consistent.
            const onSequence = async (seq, index, total) => {
                assembled = upsertSequence(assembled, seq);
                const snapshot = JSON.parse(JSON.stringify(assembled));
                await updateProjectJSON(projectId, (p) => {
                    p.data = p.data || {};
                    p.data.stage6_scenes = snapshot;
                    if (currentMeta) p.data.stage6_meta = currentMeta;
                    return p;
                });
                if (context.projectData?.data) {
                    context.projectData.data.stage6_scenes = snapshot;
                    if (currentMeta) context.projectData.data.stage6_meta = currentMeta;
                }
                send({
                    type: 'sequence',
                    sequence_number: seq.sequence_number,
                    index, total,
                    sequence: seq,
                    completed: assembled.length
                });
            };

            const { usageList } = await generateStage6Scenes(
                pitch, characters, beats, treatment,
                (current, total) => send({ type: 'progress', current, total }),
                combinedSourceBlock,
                withAbortSignal(getModelConfig(6), abortTracker.signal),
                generationNotes,
                { fromSequence, toSequence, existingSequences, meta: cachedMeta, onMeta, onSequence }
            );
            abortTracker.throwIfAborted();

            const isComplete = assembled.length >= TOTAL_SEQUENCES;
            if (isComplete) {
                // The blueprint is whole — snapshot old->new, stamp staleness,
                // consume the source packet, and kick the advisory audit.
                const { snapshotIds } = await finalizeGenerationEndpointArtifact({
                    context,
                    stage: 6,
                    stageKey: 'stage6_scenes',
                    result: assembled,
                    before: beforeBlueprint,
                    operation: 'generation',
                    note: generationNotes,
                    sourcePacket,
                    usage: usageList,
                    sourceReason: 'generation'
                });
                kickStage6Audit(projectId, 'Stage 6 post-generation audit');
                send({ type: 'complete', result: assembled, snapshotIds, ...sourceResponseExtras(sourcePacket) });
            } else {
                // Manual mode: one sequence done, more remain. Already persisted;
                // the source packet is not consumed until the blueprint completes.
                trackUsage(projectId, usageList);
                send({
                    type: 'sequence-batch-complete',
                    completed: assembled.length,
                    next: assembled.length + 1,
                    total: TOTAL_SEQUENCES,
                    result: assembled
                });
            }
        } catch (error) {
            if (isClientAbortError(error)) {
                console.warn('Stage 6 scene generation stream stopped after client disconnect (partial sequences are already saved).');
                return;
            }
            console.error('Stage 6 Scene Gen Error:', error.message);
            const detail = publicErrorDetail(error);
            send({ type: 'error', message: detail ? `Failed to generate scene blueprint: ${detail}` : 'Failed to generate scene blueprint' });
        } finally {
            clearInterval(heartbeat);
            abortTracker.markComplete();
            if (!res.destroyed && !res.writableEnded) res.end();
        }
    });

    app.post('/api/generate-stage6-audit', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId } = req.body || {};
            if (!isValidProjectId(projectId)) {
                throw new BadRequestError('Missing or invalid projectId');
            }
            const audit = await runAndPersistStage6Audit(projectId);
            res.json({ audit });
        } catch (error) {
            console.error('Stage 6 Audit Error:', error.message);
            sendApiError(res, error, 'Failed to audit scene blueprint');
        }
    });

    app.patch('/api/projects/:id/stage6-audit/dismiss', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            if (!isValidProjectId(id)) throw new BadRequestError('Missing or invalid projectId');
            const sceneNumber = Number(req.body?.scene_number);
            const type = String(req.body?.type || '').trim();
            const dismissed = req.body?.dismissed !== false;
            const counterpartScene = req.body?.counterpart_scene === undefined ? null : Number(req.body.counterpart_scene);
            if (!Number.isFinite(sceneNumber) || sceneNumber < 1 || !type) {
                throw new BadRequestError('Missing scene_number or type');
            }

            let updatedAudit = null;
            let matched = false;
            await updateProjectJSON(id, (projectData) => {
                projectData.data = projectData.data || {};
                const audit = projectData.data.stage6_scenes_audit || projectData.data.stage6_scenes?.audit || {};
                const flags = Array.isArray(audit.flags) ? audit.flags : [];
                updatedAudit = {
                    ...audit,
                    flags: flags.map(flag => {
                        const sameCounterpart = counterpartScene === null
                            || Number(flag.counterpart_scene || 0) === Number(counterpartScene || 0);
                        if (Number(flag.scene_number) === sceneNumber && flag.type === type && sameCounterpart) {
                            matched = true;
                            return { ...flag, dismissed };
                        }
                        return flag;
                    })
                };
                projectData.data.stage6_scenes_audit = updatedAudit;
                return projectData;
            });

            if (!matched) throw new NotFoundError('Stage 6 audit flag not found');
            res.json({ audit: updatedAudit });
        } catch (error) {
            console.error('Stage 6 Audit Dismiss Error:', error.message);
            sendApiError(res, error, 'Failed to dismiss scene audit flag');
        }
    });

    app.post('/api/revise-stage6', requireAuth, aiLimiter, async (req, res) => {
        let heartbeat = null;
        let streaming = false;
        let abortTracker = null;
        const send = (data) => {
            if (streaming && !abortTracker?.signal.aborted && !res.destroyed && !res.writableEnded) {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            }
        };
        try {
            const { projectId, feedback, stream } = req.body;
            if (!feedback) {
                throw new BadRequestError("Missing or invalid projectId, or missing feedback");
            }
            streaming = stream === true || /\btext\/event-stream\b/i.test(req.headers.accept || '');

            const context = await prepareGenerationProjectContext(req, res, {
                projectId,
                invalidProjectMessage: "Missing or invalid projectId, or missing feedback"
            });
            const { projectData } = context;

            const currentBlueprint = projectData.data?.stage6_scenes;
            if (!currentBlueprint) {
                throw new BadRequestError("No current Stage 6 blueprint found to revise");
            }

            if (streaming) {
                abortTracker = createClientAbortTracker(res, 'Stage 6 revision stream');
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();
                heartbeat = setInterval(() => {
                    if (!abortTracker?.signal.aborted && !res.destroyed && !res.writableEnded) {
                        res.write(': keep-alive\n\n');
                    }
                }, 15000);
                heartbeat.unref?.();
                send({ type: 'status', message: 'Revising scene blueprint...' });
            }

            console.log("Revising Stage 6 Scene Blueprint...");
            const stage6RevisionSeed = `${JSON.stringify(currentBlueprint, null, 2)}\n${feedback}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 6, stage6RevisionSeed, { userMessage: feedback });
            const { result: updatedBlueprint, usage } = await reviseStage6Scenes(
                currentBlueprint,
                feedback,
                withAbortSignal(getModelConfigWithSourcePacket(6, sourcePacket), abortTracker?.signal)
            );
            abortTracker?.throwIfAborted();
            const revisionTransaction = createVerifiedGenerationRevision({
                enabled: true,
                label: 'Stage 6 scene blueprint',
                build: () => createRevisionTransaction({
                    stageId: 'stage6_scenes',
                    before: currentBlueprint || [],
                    after: updatedBlueprint || [],
                    notes: feedback,
                    adapter: sceneBlueprintRevisionAdapter
                })
            });
            const changed = revisionTransaction.changed;

            send({ type: 'status', message: changed ? 'Saving revised blueprint...' : 'Revision returned no blueprint changes...' });
            const { snapshotIds } = await finalizeGenerationEndpointArtifact({
                context,
                stage: 6,
                stageKey: 'stage6_scenes',
                result: updatedBlueprint,
                before: currentBlueprint || [],
                operation: 'revision',
                note: feedback,
                revisionTransaction,
                changed,
                sourcePacket,
                usage,
                sourceReason: 'revision'
            });

            kickStage6Audit(projectId, 'Stage 6 post-revision audit');
            const payload = { result: updatedBlueprint, changed, revisionReceipt: revisionTransaction.receipt, snapshotIds, ...sourceResponseExtras(sourcePacket) };
            if (streaming) {
                // Keep the final SSE packet small. The browser refreshes the saved
                // Stage 6 data after completion, which avoids large blueprint payloads
                // being dropped by buffering/proxy layers.
                send({ type: 'complete', changed, stageKey: 'stage6_scenes', ...sourceResponseExtras(sourcePacket) });
            } else {
                res.json(payload);
            }
        } catch (error) {
            if (isClientAbortError(error)) {
                console.warn('Stage 6 revision stream stopped after client disconnect.');
                return;
            }
            console.error('Stage 6 Revision Error:', error.message);
            const isNoChangeError = error.code === 'NO_BLUEPRINT_CHANGES';
            const errorMessage = isNoChangeError ? error.message : "Failed to revise scene blueprint";
            if (streaming) {
                send({ type: 'error', message: errorMessage });
            } else {
                const apiError = isNoChangeError
                    ? new ApiError(500, error.message, { code: 'NO_BLUEPRINT_CHANGES', expose: true })
                    : error;
                sendApiError(res, apiError, "Failed to revise scene blueprint");
            }
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            abortTracker?.markComplete();
            if (streaming && !res.destroyed && !res.writableEnded) res.end();
        }
    });

    app.post('/api/generate-draft', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId, sceneNumber } = req.body;
            const sceneNum = parseInt(sceneNumber, 10);
            if (!isValidProjectId(projectId) || isNaN(sceneNum) || sceneNum < 1 || sceneNum > 10000) {
                throw new BadRequestError("Missing or invalid projectId or sceneNumber");
            }

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);

            if (!projectData.data || !projectData.data.stage6_scenes) {
                throw new BadRequestError("Stage 6 Scene Blueprint not found");
            }
            const beforeDraftSnapshot = JSON.parse(JSON.stringify(projectData.data.stage6_scenes || []));

            const targetedScene = findProjectScene(projectData, sceneNum);

            if (!targetedScene) {
                throw new NotFoundError(`Scene ${sceneNum} not found in blueprint`);
            }
            const beforeDraftHash = sourcePlanDataHash(targetedScene.humanized_draft_text || targetedScene.draft_text || '');

            const missingFields = ['scene_heading', 'narrative_action', 'dramaturgical_function'].filter(f => !targetedScene[f]);
            if (missingFields.length > 0) {
                throw new BadRequestError(`Scene missing required fields: ${missingFields.join(', ')}`);
            }

            const projectContext = {
                synopsis: projectData.data.stage1_pitch?.pitch?.synopsis || "",
                characters: normalizeStage3CharactersForPipeline(projectData.data.stage3_characters || {})
            };

            clearSceneFacts(projectData, sceneNum);
            const continuityCtx = buildContinuityContext(projectData, sceneNum, targetedScene);
            const sceneLockPacket = buildStage8SceneLockPacket(projectData, sceneNum, targetedScene);

            const { styleContent, styleWarning } = await loadProjectStyle(projectData);
            console.log(`Generating draft for Scene ${sceneNum}...`);
            const draftKnowledgeSeed = `${JSON.stringify(projectContext, null, 2)}\n${JSON.stringify(targetedScene, null, 2)}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 8, draftKnowledgeSeed);
            const { result: draftText, usage: draftUsage } = await generateSceneDraft(targetedScene, projectContext, null, getModelConfigWithSourcePacket(8, sourcePacket), styleContent, continuityCtx, sceneLockPacket);

            console.log(`Humanizing draft for Scene ${sceneNum}...`);
            const { result: humanizedText, usage: humanizeUsage } = await humanizeDraft(draftText, styleContent);

            targetedScene.draft_text = draftText;
            targetedScene.humanized_draft_text = humanizedText;
            recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(targetedScene, null, 2), 'generation');

            console.log(`Running continuity check for Scene ${sceneNum}...`);
            const { result: checkResult, usage: checkUsage } = await runContinuityCheck(
                humanizedText || draftText, targetedScene, projectData,
                { geminiApiKey: getModelConfig(8).geminiApiKey, anthropicApiKey: getModelConfig(8).anthropicApiKey }
            );
            applyCheckResult(projectData, checkResult, checkUsage);
            const snapshotEntries = recordArtifactMutation(projectData, {
                projectId,
                stage: 8,
                before: beforeDraftSnapshot,
                after: projectData.data.stage6_scenes,
                operation: 'generation',
                note: `Scene ${sceneNum} draft`
            });

            await writeJSONQueued(filePath, projectData);
            trackUsage(projectId, [draftUsage, humanizeUsage, checkUsage].filter(Boolean));

            const changed = beforeDraftHash !== sourcePlanDataHash(humanizedText || draftText || '');
            const response = { result: humanizedText, changed, snapshotIds: snapshotEntries.map(entry => entry.id), ...(styleWarning && { styleWarning }), ...sourceResponseExtras(sourcePacket) };
            if (checkResult.errors?.length > 0) response.continuityErrors = checkResult.errors;
            if (checkResult.warnings?.length > 0) response.continuityWarnings = checkResult.warnings;
            res.json(response);
        } catch (error) {
            console.error('Stage 8 Draft Generation Error:', error.message);
            sendApiError(res, error, "Failed to generate scene draft");
        }
    });

    app.post('/api/revise-draft', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId, sceneNumber, feedback } = req.body;
            const sceneNum = parseInt(sceneNumber, 10);
            if (!isValidProjectId(projectId) || isNaN(sceneNum) || sceneNum < 1 || sceneNum > 10000 || !feedback) {
                throw new BadRequestError("Missing or invalid projectId, sceneNumber, or feedback");
            }

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);

            if (!projectData.data?.stage6_scenes) {
                throw new BadRequestError("Stage 6 Scene Blueprint not found");
            }
            const beforeDraftSnapshot = JSON.parse(JSON.stringify(projectData.data.stage6_scenes || []));

            const targetedScene = findProjectScene(projectData, sceneNum);

            if (!targetedScene) {
                throw new NotFoundError(`Scene ${sceneNum} not found in blueprint`);
            }

            const missingFields = ['scene_heading', 'narrative_action', 'dramaturgical_function'].filter(f => !targetedScene[f]);
            if (missingFields.length > 0) {
                throw new BadRequestError(`Scene missing required fields: ${missingFields.join(', ')}`);
            }

            const projectContext = {
                synopsis: projectData.data.stage1_pitch?.pitch?.synopsis || "",
                characters: normalizeStage3CharactersForPipeline(projectData.data.stage3_characters || {})
            };

            clearSceneFacts(projectData, sceneNum);
            const continuityCtx = buildContinuityContext(projectData, sceneNum, targetedScene);
            const sceneLockPacket = buildStage8SceneLockPacket(projectData, sceneNum, targetedScene);

            const { styleContent, styleWarning } = await loadProjectStyle(projectData);
            console.log(`Revising draft for Scene ${sceneNum}...`);
            const draftKnowledgeSeed = `${JSON.stringify(projectContext, null, 2)}\n${JSON.stringify(targetedScene, null, 2)}\n${feedback}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 8, draftKnowledgeSeed, { userMessage: feedback });
            const { result: draftText, usage: draftUsage } = await generateSceneDraft(targetedScene, projectContext, feedback, getModelConfigWithSourcePacket(8, sourcePacket), styleContent, continuityCtx, sceneLockPacket);

            console.log(`Humanizing revised draft for Scene ${sceneNum}...`);
            const { result: humanizedText, usage: humanizeUsage } = await humanizeDraft(draftText, styleContent);

            targetedScene.draft_text = draftText;
            targetedScene.humanized_draft_text = humanizedText;
            targetedScene.locked = false;
            recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(targetedScene, null, 2), 'revision');

            console.log(`Running continuity check for Scene ${sceneNum}...`);
            const { result: checkResult, usage: checkUsage } = await runContinuityCheck(
                humanizedText || draftText, targetedScene, projectData,
                { geminiApiKey: getModelConfig(8).geminiApiKey, anthropicApiKey: getModelConfig(8).anthropicApiKey }
            );
            applyCheckResult(projectData, checkResult, checkUsage);
            const snapshotEntries = recordArtifactMutation(projectData, {
                projectId,
                stage: 8,
                before: beforeDraftSnapshot,
                after: projectData.data.stage6_scenes,
                operation: 'revision',
                note: `Scene ${sceneNum} draft revision: ${feedback || ''}`
            });

            await writeJSONQueued(filePath, projectData);
            trackUsage(projectId, [draftUsage, humanizeUsage, checkUsage].filter(Boolean));

            const response = { result: humanizedText, snapshotIds: snapshotEntries.map(entry => entry.id), ...(styleWarning && { styleWarning }), ...sourceResponseExtras(sourcePacket) };
            if (checkResult.errors?.length > 0) response.continuityErrors = checkResult.errors;
            if (checkResult.warnings?.length > 0) response.continuityWarnings = checkResult.warnings;
            res.json(response);
        } catch (error) {
            console.error('Stage 8 Draft Revision Error:', error.message);
            sendApiError(res, error, "Failed to revise scene draft");
        }
    });

    // --- Continuity: Resolve flagged error --- //

    app.post('/api/continuity/resolve', requireAuth, async (req, res) => {
        try {
            const { projectId, factId, resolution, newValue } = req.body;
            if (!isValidProjectId(projectId) || !factId || !resolution) {
                throw new BadRequestError('Missing projectId, factId, or resolution');
            }
            if (!['intentional_change', 'dismiss', 'fix_prompt'].includes(resolution)) {
                throw new BadRequestError('Invalid resolution type');
            }
            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);
            resolveError(projectData, factId, resolution, newValue);
            await writeJSONQueued(filePath, projectData);
            res.json({ success: true });
        } catch (error) {
            console.error('Continuity resolve error:', error.message);
            sendApiError(res, error, 'Failed to resolve continuity issue');
        }
    });
}

module.exports = {
    registerGenerationRoutes
};
