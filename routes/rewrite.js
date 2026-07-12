const { formatCharacterBackstory } = require('../utils/character_backstory');

function registerRewriteRoutes(app, deps) {
    const {
        requireAuth,
        aiLimiter,
        isValidProjectId,
        assertValidProjectId,
        assertProjectExists,
        BadRequestError,
        sendApiError,
        getProjectFilePath,
        readProjectJSONById,
        writeJSONQueued,
        updateProjectJSON,
        agent8Coverage,
        rewriteScene,
        getModelConfig,
        getModelConfigWithSourcePacket,
        buildSourceGenerationPacket,
        recordArtifactMutation,
        stampGenerated,
        recordSourceGenerationUsage,
        trackUsage,
        sourceResponseExtras,
        compactText,
        buildStage10PlannerSceneList,
        loadSkill,
        loadProjectStyle,
        buildStage10RewritePlanPrompt,
        buildStage10RewritePlannerSystemInstruction,
        buildStage10RewriteLockPacket,
        findProjectScene,
        persistStage10PendingRewrite,
        ensureStage10RewriteState,
        persistChatAttachmentToKnowledge,
        safeParse,
        generateContent
    } = deps;

    // --- Stage 9: Coverage --- //

    app.post('/api/generate-coverage', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId, source } = req.body;
            if (!isValidProjectId(projectId)) throw new BadRequestError("Missing or invalid projectId");

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);

            if (!projectData.data?.stage7_approved) {
                throw new BadRequestError("Stage 8 Draft must be approved before generating coverage");
            }

            let fullScriptText;

            // When triggered from Stage 10 loopback, use the rewritten working copy
            if (source === 'stage10' && projectData.data?.stage9_rewrites?.working) {
                const working = projectData.data.stage9_rewrites.working;
                fullScriptText = Object.keys(working)
                    .map(n => parseInt(n))
                    .sort((a, b) => a - b)
                    .map(n => (working[n] || '').trim())
                    .filter(t => t && t !== '[SCENE DELETED]')
                    .join('\n\n');
            } else {
                const stage6Scenes = projectData.data?.stage6_scenes;
                if (!stage6Scenes) {
                    throw new BadRequestError("No scene blueprint found");
                }

                // Assemble full script from all scenes in order
                const allScenes = [];
                for (const seq of stage6Scenes) {
                    if (seq.scenes) allScenes.push(...seq.scenes);
                }
                allScenes.sort((a, b) => a.scene_number - b.scene_number);

                fullScriptText = allScenes
                    .map(s => (s.humanized_draft_text || s.draft_text || '').trim())
                    .filter(Boolean)
                    .join('\n\n');
            }

            if (!fullScriptText) {
                throw new BadRequestError("No draft text found in scenes. Generate scene drafts first.");
            }

            const pitch = projectData.data?.stage1_pitch?.pitch;
            const projectContext = {
                title:    pitch?.title || projectData.title || 'Untitled',
                genre:    pitch?.genre || '',
                logline:  pitch?.logline || '',
                synopsis: pitch?.synopsis || '',
                characters: projectData.data?.stage3_characters?.characters || []
            };

            console.log(`Generating Stage 9 Coverage for project ${projectId}...`);
            const coverageKnowledgeSeed = `${JSON.stringify(projectContext, null, 2)}\n${compactText(fullScriptText, 24_000)}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 9, coverageKnowledgeSeed, { userMessage: 'Generate screenplay coverage against approved project memory.' });
            const { result: coverageResult, usageList } = await agent8Coverage(fullScriptText, projectContext, getModelConfigWithSourcePacket(9, sourcePacket));
            const snapshotEntries = recordArtifactMutation(projectData, {
                projectId,
                stage: 9,
                before: projectData.data?.stage8_coverage || null,
                after: coverageResult,
                operation: 'generation',
                note: source === 'stage10' ? 'Coverage from Stage 10 rewrite' : 'Coverage generation'
            });

            projectData.data = projectData.data || {};
            projectData.data.stage8_coverage = coverageResult;
            stampGenerated(projectData, 'stage8_coverage');
            recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(coverageResult, null, 2), 'coverage_generation');

            await writeJSONQueued(filePath, projectData);
            trackUsage(projectId, usageList);

            res.json({ result: coverageResult, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error('Stage 8 Coverage Error:', error.message);
            sendApiError(res, error, "Failed to generate coverage");
        }
    });

    // Initialize stage9_rewrites from Stage 8 humanized text
    app.post('/api/init-stage9', requireAuth, async (req, res) => {
        try {
            const { projectId, reset } = req.body;
            assertValidProjectId(projectId, 'Missing or invalid projectId');

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);

            // Return existing state if already initialized (unless reset requested)
            if (projectData.data?.stage9_rewrites && !reset) {
                return res.json({
                    stage9_rewrites: projectData.data.stage9_rewrites,
                    macro_todo: projectData.data.stage8_coverage?.macro_todo || [],
                    micro_todo:  projectData.data.stage8_coverage?.micro_todo  || [],
                });
            }

            // If resetting an existing session, preserve the working copy but restart priority_idx
            if (projectData.data?.stage9_rewrites && reset) {
                const beforeRewrite = JSON.parse(JSON.stringify(projectData.data.stage9_rewrites));
                projectData.data.stage9_rewrites.priority_idx = 0;
                projectData.data.stage9_rewrites.approved = false;
                recordArtifactMutation(projectData, {
                    projectId,
                    stage: 10,
                    before: beforeRewrite,
                    after: projectData.data.stage9_rewrites,
                    operation: 'reset',
                    note: 'Restart rewrite priorities'
                });
                await writeJSONQueued(filePath, projectData);
                return res.json({
                    stage9_rewrites: projectData.data.stage9_rewrites,
                    macro_todo: projectData.data.stage8_coverage?.macro_todo || [],
                    micro_todo:  projectData.data.stage8_coverage?.micro_todo  || [],
                });
            }

            // Build working copy from all scene humanized/draft texts
            const stage6Scenes = projectData.data?.stage6_scenes || [];
            const allScenes = [];
            for (const seq of stage6Scenes) {
                if (seq.scenes) allScenes.push(...seq.scenes);
            }
            allScenes.sort((a, b) => a.scene_number - b.scene_number);

            const working = {};
            for (const s of allScenes) {
                working[s.scene_number] = (s.humanized_draft_text || s.draft_text || '').trim();
            }

            const stage9 = { working, priority_idx: 0, approved: false };
            projectData.data = projectData.data || {};
            const snapshotEntries = recordArtifactMutation(projectData, {
                projectId,
                stage: 10,
                before: projectData.data.stage9_rewrites || null,
                after: stage9,
                operation: 'generation',
                note: 'Initialize rewrite working copy'
            });
            projectData.data.stage9_rewrites = stage9;
            await writeJSONQueued(filePath, projectData);

            res.json({
                stage9_rewrites: stage9,
                snapshotIds: snapshotEntries.map(entry => entry.id),
                macro_todo: projectData.data.stage8_coverage?.macro_todo || [],
                micro_todo:  projectData.data.stage8_coverage?.micro_todo  || [],
            });
        } catch (error) {
            console.error('init-stage9 error:', error.message);
            sendApiError(res, error, 'Failed to initialize rewrite stage');
        }
    });

    app.post('/api/plan-rewrite', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId, priorityTask, userFeedback, conversationContext } = req.body;
            if (!isValidProjectId(projectId) || !priorityTask) {
                throw new BadRequestError('Missing or invalid projectId or priorityTask');
            }

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);

            const working = projectData.data?.stage9_rewrites?.working || {};
            const pitch = projectData.data?.stage1_pitch?.pitch;
            const title = pitch?.title || projectData.title || 'Untitled';

            const stage6Scenes = projectData.data?.stage6_scenes || [];
            const allScenes = [];
            for (const seq of stage6Scenes) { if (seq.scenes) allScenes.push(...seq.scenes); }
            allScenes.sort((a, b) => a.scene_number - b.scene_number);

            const sceneList = buildStage10PlannerSceneList(allScenes, working);

            const plannerSop = loadSkill('skill_stage10_planner');
            const feedbackSection = userFeedback ? `\n\n## WRITER NOTES ON SCOPE\n${userFeedback}` : '';
            // Trim conversation context to last ~4000 chars to keep prompt manageable
            const trimmedContext = conversationContext && conversationContext.length > 4000
                ? '...\n' + conversationContext.slice(-4000)
                : conversationContext;
            const contextSection = trimmedContext ? `\n\n## BRAINSTORM CONTEXT\n${trimmedContext}` : '';
            const characters = projectData.data?.stage3_characters?.characters || [];
            const charBlock = characters.length > 0
                ? `\n\n## CHARACTERS\n${characters.map(c => {
                    const tier = c.profile_tier || 'Tier 1';
                    const tierText = String(tier).toLowerCase();
                    const backstory = formatCharacterBackstory(c.backstory, tier, { maxPerField: 220 });
                    const backstorySuffix = backstory ? `, backstory relevance=${backstory}` : '';
                    if (/\b3\b|cameo|utility/.test(tierText)) {
                        return `${c.name} (${c.role}, ${tier}): scene purpose=${c.cameo_profile?.scene_purpose || c.brief_summary || 'unknown'}${backstorySuffix}`;
                    }
                    if (/\b2\b|functional/.test(tierText)) {
                        return `${c.name} (${c.role}, ${tier}): narrative function=${c.functional_profile?.narrative_function || c.brief_summary || 'unknown'}, emotional truth=${c.functional_profile?.emotional_truth || 'unknown'}, comic/tension=${c.functional_profile?.comic_or_tension_function || 'unknown'}, pressure behavior=${c.functional_profile?.pressure_behavior || 'unknown'}, voice flavor=${c.functional_profile?.voice_flavor || 'unknown'}${backstorySuffix}`;
                    }
                    return `${c.name} (${c.role}, ${tier}): arc=${c.arc?.direction || 'unknown'}, drive=${c.arc?.core_drive || 'unknown'}${backstorySuffix}`;
                }).join('\n')}`
                : '';
            const { styleContent: plannerStyleContent, referenceContent: plannerRefContent } = await loadProjectStyle(projectData);
            let styleNote = '';
            if (plannerStyleContent && plannerRefContent) {
                styleNote = `\n\n## STYLE CONTEXT\nThis project has a trained style (Tier 3) derived from screenplay analysis. The rewrite agent will automatically perform style-compliance checking using the full reference. Do not add style tasks to the plan unless the rewrite task explicitly raises style drift as an issue.`;
            } else if (plannerStyleContent) {
                styleNote = `\n\n## STYLE CONTEXT\nThis project has a writing style set. The rewrite agent will maintain this style during execution. Do not treat the style itself as a problem to fix — it is an intentional choice. Only flag style-related issues if the rewrite task explicitly raises them.`;
            }
            const sourcePlanSeed = `${priorityTask}\n${userFeedback || ''}\n${sceneList}\n${trimmedContext || ''}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 10, sourcePlanSeed, { userMessage: priorityTask });
            const prompt = buildStage10RewritePlanPrompt({
                sourceContext: sourcePacket.contextBlock,
                title,
                charBlock,
                styleNote,
                priorityTask,
                feedbackSection,
                contextSection,
                sceneList
            });

            const plannerSchema = {
                type: 'object',
                properties: {
                    rationale:       { type: 'string' },
                    affected_scenes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                scene_number:   { type: 'integer' },
                                slugline:       { type: 'string' },
                                reason:         { type: 'string' },
                                planned_change: { type: 'string' },
                            },
                            required: ['scene_number', 'slugline', 'reason', 'planned_change'],
                        },
                    },
                },
                required: ['rationale', 'affected_scenes'],
            };

            const modelCfg = getModelConfig(10);
            console.log(`plan-rewrite: model=${modelCfg.model}, prompt=${prompt.length} chars, context=${(trimmedContext||'').length} chars`);

            const t0 = Date.now();
            const response = await generateContent({
                model: modelCfg.model,
                geminiApiKey: modelCfg.geminiApiKey,
                anthropicApiKey: modelCfg.anthropicApiKey,
                contents: prompt,
                config: {
                    systemInstruction: buildStage10RewritePlannerSystemInstruction(plannerSop),
                    temperature: 0.2,
                    responseMimeType: 'application/json',
                    responseSchema: plannerSchema,
                },
            });
            console.log(`plan-rewrite succeeded in ${((Date.now()-t0)/1000).toFixed(1)}s`);

            const plan = safeParse(response.text, null);
            if (!plan) throw new Error('Stage 10 rewrite plan response was not valid JSON');
            console.log(`Stage 10 plan: ${plan.affected_scenes.length} scenes affected.`);
            recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(plan, null, 2), 'rewrite_plan');
            await writeJSONQueued(filePath, projectData);
            if (response.usage) trackUsage(projectId, response.usage);
            res.json({ ...plan, ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error('plan-rewrite error:', error.message);
            sendApiError(res, error, 'Failed to generate rewrite plan');
        }
    });

    // Run the rewrite agent only on planned (affected) scenes
    app.post('/api/rewrite-for-priority', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId, priorityTask, affectedSceneNumbers } = req.body;
            if (!isValidProjectId(projectId) || !priorityTask) {
                throw new BadRequestError('Missing or invalid projectId or priorityTask');
            }

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);

            const working = projectData.data?.stage9_rewrites?.working || {};
            const pitch = projectData.data?.stage1_pitch?.pitch;
            const title = pitch?.title || projectData.title || 'Untitled';

            const stage6Scenes = projectData.data?.stage6_scenes || [];
            const allScenes = [];
            for (const seq of stage6Scenes) {
                if (seq.scenes) allScenes.push(...seq.scenes);
            }
            allScenes.sort((a, b) => a.scene_number - b.scene_number);

            // Filter to only affected scenes if planner provided a list
            const scopedScenes = affectedSceneNumbers?.length
                ? allScenes.filter(s => affectedSceneNumbers.includes(s.scene_number))
                : allScenes;

            const { styleContent, referenceContent } = await loadProjectStyle(projectData);
            console.log(`Stage 10: rewriting ${scopedScenes.length} scene(s) for task: "${priorityTask.slice(0, 60)}..."${referenceContent ? ' [with style compliance]' : ''}`);
            const sourcePlanSeed = `${priorityTask}\n${scopedScenes.map(s => {
                const sceneText = working[s.scene_number] || s.humanized_draft_text || s.draft_text || '';
                return `Scene ${s.scene_number}: ${s.scene_heading || s.slugline || ''}\n${s.narrative_action || ''}\n${compactText(sceneText, 1_200)}`;
            }).join('\n\n')}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 10, sourcePlanSeed, { userMessage: priorityTask });

            const results = await Promise.allSettled(
                scopedScenes.map(s => {
                    const sceneText = working[s.scene_number] || s.humanized_draft_text || s.draft_text || '';
                    const scenePacket = buildSourceGenerationPacket(projectData, 10, `${priorityTask}\n${sceneText}\n${s.narrative_action || ''}`, { userMessage: priorityTask });
                    const rewriteModelConfig = getModelConfigWithSourcePacket(10, scenePacket);
                    const blueprint = buildStage10RewriteLockPacket(projectData, s.scene_number, s, sceneText, priorityTask);
                    return rewriteScene(sceneText, priorityTask, {
                        title,
                        sceneNumber: s.scene_number,
                        slugline: s.slugline || s.scene_heading || '',
                        blueprint
                    }, '', rewriteModelConfig, styleContent, referenceContent).then(({ result: proposed, usage }) => ({ scene_number: s.scene_number, original_text: sceneText, proposed_text: proposed, usage }));
                })
            );

            const scenes = results.map((r, i) => {
                if (r.status === 'fulfilled') {
                    const { scene_number, original_text, proposed_text } = r.value;
                    return { scene_number, original_text, proposed_text, modified: proposed_text.trim() !== original_text.trim() };
                }
                const s = scopedScenes[i];
                const fallback = working[s.scene_number] || '';
                return { scene_number: s.scene_number, original_text: fallback, proposed_text: fallback, modified: false };
            });

            const usages = results.filter(r => r.status === 'fulfilled' && r.value.usage).map(r => r.value.usage);
            recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(scenes, null, 2), 'rewrite_generation');
            await writeJSONQueued(filePath, projectData);
            trackUsage(projectId, usages);

            res.json({ scenes, ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error('rewrite-for-priority error:', error.message);
            sendApiError(res, error, 'Failed to rewrite scenes for priority');
        }
    });

    // Rewrite a single scene for a planned priority task
    app.post('/api/rewrite-single-scene', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId, sceneNumber, priorityTask, plannedChange } = req.body;
            const sceneNum = parseInt(sceneNumber, 10);
            if (!isValidProjectId(projectId) || isNaN(sceneNum) || sceneNum < 1 || !priorityTask) {
                throw new BadRequestError('Missing or invalid projectId, sceneNumber, or priorityTask');
            }

            const projectData = await readProjectJSONById(projectId);

            const working = projectData.data?.stage9_rewrites?.working || {};
            const pitch = projectData.data?.stage1_pitch?.pitch;
            const title = pitch?.title || projectData.title || 'Untitled';

            const sceneMeta = findProjectScene(projectData, sceneNum);

            const sceneText = working[sceneNum] || sceneMeta?.humanized_draft_text || sceneMeta?.draft_text || '';
            const slugline = sceneMeta?.slugline || sceneMeta?.scene_heading || '';

            // Short-circuit: if the plan says to delete/remove/omit this scene, skip the LLM
            const deletionPattern = /\b(delete|remove|omit|cut|eliminate)\b.*\b(scene|entirely|completely)\b/i;
            if (plannedChange && deletionPattern.test(plannedChange)) {
                console.log(`Stage 10: deleting scene ${sceneNum} (per plan)`);
                const deletionPacket = buildSourceGenerationPacket(projectData, 10, `${priorityTask}\n${plannedChange || ''}\n${sceneText}`, { userMessage: priorityTask });
                let snapshotEntries = [];
                await updateProjectJSON(projectId, (freshProject) => {
                    snapshotEntries = persistStage10PendingRewrite(freshProject, {
                        projectId,
                        sceneNum,
                        proposedText: '',
                        note: `Pending delete for scene ${sceneNum}`,
                        sourcePacket: deletionPacket,
                        sourceText: '',
                        sourceReason: 'single_scene_delete'
                    });
                    return freshProject;
                });
                return res.json({ scene_number: sceneNum, original_text: sceneText, proposed_text: '', modified: true, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(deletionPacket) });
            }

            const { styleContent, referenceContent } = await loadProjectStyle(projectData);
            console.log(`Stage 10: rewriting scene ${sceneNumber} for task: "${priorityTask.slice(0, 60)}..."${referenceContent ? ' [with style compliance]' : ''}`);

            // Build character context for this scene
            const characters = projectData.data?.stage3_characters?.characters || [];
            const charProfiles = characters.length > 0
                ? characters.map(c => {
                    const dp = c._deep_profile || {};
                    const tier = c.profile_tier || 'Tier 1';
                    const tierText = String(tier).toLowerCase();
                    const backstory = formatCharacterBackstory(c.backstory, tier, { maxPerField: 260 });
                    const backstoryLine = backstory ? `\nBackstory relevance: ${backstory}` : '';
                    if (/\b3\b|cameo|utility/.test(tierText)) {
                        return `${c.name} (${c.role}, ${tier}): scene purpose=${c.cameo_profile?.scene_purpose || c.brief_summary || 'unknown'}, playable behavior=${c.cameo_profile?.playable_behavior || 'unknown'}${backstoryLine}${c.cameo_profile?.line_style_example ? `\nLine style example: ${c.cameo_profile.line_style_example}` : ''}`;
                    }
                    if (/\b2\b|functional/.test(tierText)) {
                        return `${c.name} (${c.role}, ${tier}): narrative function=${c.functional_profile?.narrative_function || c.brief_summary || 'unknown'}, emotional truth=${c.functional_profile?.emotional_truth || 'unknown'}, comic/tension=${c.functional_profile?.comic_or_tension_function || 'unknown'}, pressure behavior=${c.functional_profile?.pressure_behavior || 'unknown'}, voice flavor=${c.functional_profile?.voice_flavor || 'unknown'}${backstoryLine}`;
                    }
                    return `${c.name} (${c.role}, ${tier}): voice=${c.voice_and_behavior?.voice_tag || 'unknown'}, pressure=${c.voice_and_behavior?.pressure_tag || 'unknown'}${backstoryLine}${dp.dialogue_fingerprint ? `\nDialogue rules: ${dp.dialogue_fingerprint}` : ''}`;
                }).join('\n\n')
                : '';

            const sourcePlanSeed = `${priorityTask}\n${plannedChange || ''}\n${sceneText}\n${sceneMeta?.narrative_action || ''}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 10, sourcePlanSeed, { userMessage: priorityTask });
            const blueprint = buildStage10RewriteLockPacket(projectData, sceneNum, sceneMeta, sceneText, plannedChange || priorityTask);
            const { result: proposed, usage } = await rewriteScene(
                sceneText, priorityTask,
                { title, sceneNumber: sceneNum, slugline, characters: charProfiles, blueprint },
                plannedChange || '',
                getModelConfigWithSourcePacket(10, sourcePacket),
                styleContent,
                referenceContent
            );

            const modified = proposed.trim() !== sceneText.trim();
            let snapshotEntries = [];

            if (modified) {
                await updateProjectJSON(projectId, (freshProject) => {
                    snapshotEntries = persistStage10PendingRewrite(freshProject, {
                        projectId,
                        sceneNum,
                        proposedText: proposed,
                        note: `Pending rewrite for scene ${sceneNum}`,
                        sourcePacket,
                        sourceText: proposed,
                        sourceReason: 'single_scene_rewrite'
                    });
                    return freshProject;
                });
            } else {
                await updateProjectJSON(projectId, (freshProject) => {
                    recordSourceGenerationUsage(freshProject, sourcePacket, proposed, 'single_scene_rewrite');
                    return freshProject;
                });
            }

            trackUsage(projectId, usage);
            res.json({ scene_number: sceneNum, original_text: sceneText, proposed_text: proposed, modified, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error('rewrite-single-scene error:', error.message);
            sendApiError(res, error, 'Failed to rewrite scene');
        }
    });

    app.post('/api/save-stage10-pending', requireAuth, async (req, res) => {
        try {
            const { projectId, sceneNumber, proposedText } = req.body;
            const sceneNum = parseInt(sceneNumber, 10);
            if (!isValidProjectId(projectId) || isNaN(sceneNum) || sceneNum < 1 || typeof proposedText !== 'string') {
                throw new BadRequestError('Missing or invalid projectId, sceneNumber, or proposedText');
            }
            await assertProjectExists(projectId);

            let snapshotEntries = [];
            const updatedProject = await updateProjectJSON(projectId, (freshProject) => {
                const stage9 = ensureStage10RewriteState(freshProject);
                if (stage9.pending?.[sceneNum] === proposedText) return freshProject;
                snapshotEntries = persistStage10PendingRewrite(freshProject, {
                    projectId,
                    sceneNum,
                    proposedText,
                    note: `Manual pending rewrite edit for scene ${sceneNum}`,
                    sourcePacket: null
                });
                return freshProject;
            });

            res.json({ success: true, stage9_rewrites: updatedProject.data.stage9_rewrites, snapshotIds: snapshotEntries.map(entry => entry.id) });
        } catch (error) {
            console.error('save-stage10-pending error:', error.message);
            sendApiError(res, error, 'Failed to save pending rewrite');
        }
    });

    // Save approved pending changes and advance priority index
    app.post('/api/approve-rewrite-priority', requireAuth, async (req, res) => {
        try {
            const { projectId, pendingScenes, newPriorityIdx } = req.body;
            assertValidProjectId(projectId, 'Missing or invalid projectId');
            await assertProjectExists(projectId);

            let snapshotEntries = [];
            const updatedProject = await updateProjectJSON(projectId, (projectData) => {
                const stage9 = ensureStage10RewriteState(projectData);
                const beforeRewrite = JSON.parse(JSON.stringify(stage9));
                if (pendingScenes && typeof pendingScenes === 'object') {
                    for (const [sceneNum, text] of Object.entries(pendingScenes)) {
                        if (typeof text === 'string') stage9.working[sceneNum] = text;
                    }
                }
                stage9.pending = {};  // Clear pending — now merged into working
                if (newPriorityIdx !== undefined) stage9.priority_idx = newPriorityIdx;
                snapshotEntries = recordArtifactMutation(projectData, {
                    projectId,
                    stage: 10,
                    before: beforeRewrite,
                    after: stage9,
                    operation: 'revision',
                    note: 'Approve rewrite priority'
                });
                projectData.data.stage9_rewrites = stage9;
                return projectData;
            });

            res.json({ stage9_rewrites: updatedProject.data.stage9_rewrites, snapshotIds: snapshotEntries.map(entry => entry.id) });
        } catch (error) {
            console.error('approve-rewrite-priority error:', error.message);
            sendApiError(res, error, 'Failed to approve rewrite priority');
        }
    });

    // Rewrite a single scene using the priority task + user feedback
    app.post('/api/rewrite-scene-feedback', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId, sceneNumber, priorityTask, userFeedback, currentText, attachment } = req.body;
            if (!isValidProjectId(projectId) || !priorityTask || !currentText) {
                throw new BadRequestError('Missing required fields');
            }

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);
            const pitch = projectData.data?.stage1_pitch?.pitch;
            const title = pitch?.title || projectData.title || 'Untitled';

            let savedSource = null;
            let attachmentText = '';
            if (attachment) {
                const persisted = await persistChatAttachmentToKnowledge(projectData, attachment, { stageId: 10, userMessage: userFeedback || priorityTask, projectId });
                attachmentText = persisted.fileText;
                savedSource = persisted.savedSource;
                if (savedSource) await writeJSONQueued(filePath, projectData);
            }

            const feedbackParts = [];
            if (attachmentText) feedbackParts.push(`## ATTACHED FILE: ${attachment.name}\n${compactText(attachmentText, 80_000)}`);
            if (userFeedback) feedbackParts.push(userFeedback);
            const enrichedFeedback = feedbackParts.join('\n\n---\n\n') || userFeedback;
            const sourcePlanSeed = `${priorityTask}\n${enrichedFeedback || ''}\n${currentText}`;
            const sourcePacket = buildSourceGenerationPacket(projectData, 10, sourcePlanSeed, { userMessage: enrichedFeedback || priorityTask });
            const sceneNum = Number(sceneNumber);
            const sceneMeta = Number.isFinite(sceneNum) ? findProjectScene(projectData, sceneNum) : null;
            const blueprint = sceneMeta ? buildStage10RewriteLockPacket(projectData, sceneNum, sceneMeta, currentText, enrichedFeedback || priorityTask) : '';

            const { result: proposed_text, usage } = await rewriteScene(
                currentText,
                priorityTask,
                { title, sceneNumber, blueprint },
                enrichedFeedback,
                getModelConfigWithSourcePacket(10, sourcePacket),
            );
            let snapshotEntries = [];
            await updateProjectJSON(projectId, (freshProject) => {
                if (Number.isFinite(sceneNum) && sceneNum > 0) {
                    snapshotEntries = persistStage10PendingRewrite(freshProject, {
                        projectId,
                        sceneNum,
                        proposedText: proposed_text,
                        note: `Pending feedback rewrite for scene ${sceneNum}`,
                        sourcePacket,
                        sourceText: proposed_text,
                        sourceReason: 'rewrite_feedback'
                    });
                } else {
                    recordSourceGenerationUsage(freshProject, sourcePacket, proposed_text, 'rewrite_feedback');
                }
                return freshProject;
            });
            trackUsage(projectId, usage);
            res.json({ proposed_text, snapshotIds: snapshotEntries.map(entry => entry.id), ...(savedSource && { savedSource }), ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error('rewrite-scene-feedback error:', error.message);
            sendApiError(res, error, 'Failed to rewrite scene with feedback');
        }
    });

    // Mark Stage 10 as approved/finalized
    app.post('/api/finalize-stage10', requireAuth, async (req, res) => {
        try {
            const { projectId } = req.body;
            assertValidProjectId(projectId, 'Missing or invalid projectId');
            await assertProjectExists(projectId);

            await updateProjectJSON(projectId, (projectData) => {
                if (projectData.data?.stage9_rewrites) {
                    const beforeRewrite = JSON.parse(JSON.stringify(projectData.data.stage9_rewrites));
                    projectData.data.stage9_rewrites.approved = true;
                    recordArtifactMutation(projectData, {
                        projectId,
                        stage: 10,
                        before: beforeRewrite,
                        after: projectData.data.stage9_rewrites,
                        operation: 'approval',
                        note: 'Finalize Stage 10'
                    });
                }
                return projectData;
            });
            res.json({ success: true });
        } catch (error) {
            console.error('finalize-stage10 error:', error.message);
            sendApiError(res, error, 'Failed to finalize stage 10');
        }
    });
}

module.exports = {
    registerRewriteRoutes
};
