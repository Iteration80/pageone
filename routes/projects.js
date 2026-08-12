const { execFile } = require('child_process');
const modulePath = require('path');
const { readStage1Draft, applyStage1DraftPatch, clearStage1Draft } = require('../utils/stage1_draft');
const { artifactHash } = require('../utils/artifact_snapshots');

function registerProjectRoutes(app, deps) {
    const {
        requireAuth,
        requireAdmin,
        upload,
        fs,
        path,
        DATA_ROOT,
        DATA_DIR,
        SETTINGS_PATH,
        appSettings,
        RUNTIME_API_KEYS_ENABLED,
        BUILD_COMMIT,
        BUILD_DEPLOYMENT_ID,
        BUILD_TIMESTAMP,
        getBuildInfo,
        atomicWriteJSON,
        auditOrUpgradeAllProjectKnowledge,
        readProjectJSONById,
        writeJSONQueued,
        BadRequestError,
        getModelConfig,
        assertValidProjectId,
        assertProjectExists,
        updateProjectJSON,
        mergeVersionHistory,
        changedStageKeysFromUpdate,
        stageConfig,
        deriveStage4BeatsFromStage2Outline,
        recordArtifactMutation,
        stampGenerated,
        stampRevised,
        removeProjectSourceAssets,
        sendApiError
    } = deps;

    app.get('/health', (_req, res) => {
        res.json({
            ok: true,
            commit: BUILD_COMMIT,
            deploymentId: BUILD_DEPLOYMENT_ID,
            buildTimestamp: BUILD_TIMESTAMP
        });
    });

    // --- Settings Routes --- //

    app.get('/api/settings', requireAuth, (req, res) => {
            res.json({
                geminiApiKey: RUNTIME_API_KEYS_ENABLED && appSettings.geminiApiKey ? '***' : '',
                anthropicApiKey: RUNTIME_API_KEYS_ENABLED && appSettings.anthropicApiKey ? '***' : '',
                stageModels: appSettings.stageModels || {},
                runtimeApiKeysEnabled: RUNTIME_API_KEYS_ENABLED,
                apiKeysManagedByServer: !RUNTIME_API_KEYS_ENABLED,
                build: getBuildInfo()
            });
    });

    app.post('/api/settings', requireAuth, async (req, res) => {
        try {
            const { geminiApiKey, anthropicApiKey, stageModels } = req.body;
            // Only update keys that were actually changed (don't overwrite with masked placeholder)
            if (RUNTIME_API_KEYS_ENABLED && geminiApiKey && geminiApiKey !== '***') appSettings.geminiApiKey = geminiApiKey;
            if (RUNTIME_API_KEYS_ENABLED && anthropicApiKey && anthropicApiKey !== '***') appSettings.anthropicApiKey = anthropicApiKey;
            if (stageModels) appSettings.stageModels = stageModels;

            await fs.mkdir(DATA_ROOT, { recursive: true });
            await atomicWriteJSON(SETTINGS_PATH, appSettings);
            res.json({ ok: true });
        } catch (err) {
            console.error('Failed to save settings:', err);
            sendApiError(res, err, 'Failed to save settings');
        }
    });

    // --- Project Management Routes --- //

    app.get('/api/maintenance/legacy-projects/audit', requireAuth, requireAdmin, async (_req, res) => {
        try {
            res.json(await auditOrUpgradeAllProjectKnowledge({ write: false }));
        } catch (error) {
            console.error('legacy project audit error:', error.message);
            sendApiError(res, error, 'Failed to audit legacy projects');
        }
    });

    app.post('/api/maintenance/legacy-projects/upgrade', requireAuth, requireAdmin, async (_req, res) => {
        try {
            res.json(await auditOrUpgradeAllProjectKnowledge({ write: true }));
        } catch (error) {
            console.error('legacy project upgrade error:', error.message);
            sendApiError(res, error, 'Failed to upgrade legacy projects');
        }
    });

    // --- Stage 3 tier-override migration (roadmap R1) --- //
    // Runs scripts/seed-stage3-tier-overrides.js against the LIVE project store
    // (DATA_DIR), so the seed can be executed on deployments without shell access.
    // GET  /api/maintenance/stage3-tiers/audit  = dry run
    // POST /api/maintenance/stage3-tiers/seed   = persist
    // Add ?overwrite=1, or POST { "overwrite": true }, to replace bad saved tiers.
    function truthyFlag(value) {
        return value === true || value === 1 || /^(1|true|yes|overwrite)$/i.test(String(value || '').trim());
    }

    function shouldOverwriteStage3Tiers(req) {
        return truthyFlag(req.query?.overwrite) || truthyFlag(req.body?.overwrite);
    }

    function runTierMigration(write, { overwrite = false } = {}) {
        return new Promise((resolve, reject) => {
            const scriptPath = modulePath.join(__dirname, '../scripts/seed-stage3-tier-overrides.js');
            const args = [scriptPath, '--dir', DATA_DIR];
            if (write) args.push('--write');
            if (overwrite) args.push('--overwrite');
            execFile(process.execPath, args, { timeout: 30_000 }, (error, stdout, stderr) => {
                if (error) {
                    error.message = `${error.message}${stderr ? ` — ${String(stderr).trim()}` : ''}`;
                    return reject(error);
                }
                resolve({ ok: true, write, overwrite, output: String(stdout).trim().split('\n') });
            });
        });
    }

    app.get('/api/maintenance/stage3-tiers/audit', requireAuth, requireAdmin, async (req, res) => {
        try {
            res.json(await runTierMigration(false, { overwrite: shouldOverwriteStage3Tiers(req) }));
        } catch (error) {
            console.error('stage3 tier audit error:', error.message);
            sendApiError(res, error, 'Failed to audit Stage 3 tier overrides');
        }
    });

    app.post('/api/maintenance/stage3-tiers/seed', requireAuth, requireAdmin, async (req, res) => {
        try {
            res.json(await runTierMigration(true, { overwrite: shouldOverwriteStage3Tiers(req) }));
        } catch (error) {
            console.error('stage3 tier seed error:', error.message);
            sendApiError(res, error, 'Failed to seed Stage 3 tier overrides');
        }
    });

    // --- Project ownership migration (multi-user Phase 2) --- //
    // Same pattern, and for the same reason as the Stage 3 seed above: the live
    // project store is on a deployment volume, and a migration you cannot run
    // without shell access is a migration that does not happen.
    //
    // ⚠️ This is what makes Phase 2 deployable in one step. Unowned projects fail
    // closed, so between the deploy and the migration every project 404s — with
    // these routes that gap is one authenticated request wide, not however long it
    // takes to get a shell on the box.
    //
    // GET  /api/maintenance/project-owners/audit  = report coverage (never writes)
    // POST /api/maintenance/project-owners/stamp  = stamp unowned projects
    // Owner defaults to the signed-in admin; pass ?owner= or { owner } to override.
    function runOwnerMigration(write, { owner }) {
        return new Promise((resolve, reject) => {
            const scriptPath = modulePath.join(__dirname, '../scripts/stamp-project-owners.js');
            const args = write
                ? [scriptPath, '--dir', DATA_DIR, '--owner', owner, '--write']
                : [scriptPath, '--dir', DATA_DIR, '--verify'];
            execFile(process.execPath, args, { timeout: 60_000 }, (error, stdout, stderr) => {
                // --verify exits non-zero while any project is unowned. That is a
                // report, not a failure, so the exit code must not become a 500 —
                // the unowned case is exactly the one the caller is asking about.
                const output = String(stdout).trim().split('\n').filter(Boolean);
                if (error && !(!write && output.length)) {
                    error.message = `${error.message}${stderr ? ` — ${String(stderr).trim()}` : ''}`;
                    return reject(error);
                }
                resolve({ ok: true, write, owner: write ? owner : undefined, output });
            });
        });
    }

    app.get('/api/maintenance/project-owners/audit', requireAuth, requireAdmin, async (_req, res) => {
        try {
            res.json(await runOwnerMigration(false, {}));
        } catch (error) {
            console.error('project owner audit error:', error.message);
            sendApiError(res, error, 'Failed to audit project ownership');
        }
    });

    app.post('/api/maintenance/project-owners/stamp', requireAuth, requireAdmin, async (req, res) => {
        try {
            const owner = String(req.query?.owner || req.body?.owner || req.userEmail || '').trim().toLowerCase();
            if (!owner.includes('@')) {
                throw new BadRequestError('No owner email to stamp — sign in, or pass ?owner=you@example.com');
            }
            res.json(await runOwnerMigration(true, { owner }));
        } catch (error) {
            console.error('project owner stamp error:', error.message);
            sendApiError(res, error, 'Failed to stamp project owners');
        }
    });

    // --- Provider key health check --- //
    // Pings each provider's models endpoint with the server's CONFIGURED key and
    // reports validity WITHOUT exposing the key. Use after rotating a key on the
    // deployment to confirm the redeploy picked it up.
    // GET /api/maintenance/provider-health
    async function pingProvider(url, headers) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const resp = await fetch(url, { headers, signal: controller.signal });
            if (resp.ok) return { status: 'ok', httpStatus: resp.status };
            if (resp.status === 401 || resp.status === 403) return { status: 'invalid', httpStatus: resp.status };
            return { status: 'error', httpStatus: resp.status };
        } catch (err) {
            return { status: 'unreachable', detail: err.name === 'AbortError' ? 'timeout' : err.message };
        } finally {
            clearTimeout(timer);
        }
    }

    // Non-secret fingerprint so you can tell an old cached key from a freshly-set one.
    function keyHint(key) {
        if (!key) return null;
        const s = String(key);
        return `…${s.slice(-4)} (len ${s.length})`;
    }

    app.get('/api/maintenance/provider-health', requireAuth, requireAdmin, async (_req, res) => {
        try {
            const { anthropicApiKey, geminiApiKey } = getModelConfig(1);
            const [anthropic, gemini] = await Promise.all([
                anthropicApiKey
                    ? pingProvider('https://api.anthropic.com/v1/models', { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' })
                    : Promise.resolve({ status: 'missing' }),
                geminiApiKey
                    ? pingProvider(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiApiKey)}`, {})
                    : Promise.resolve({ status: 'missing' })
            ]);
            res.json({
                anthropic: { ...anthropic, keyHint: keyHint(anthropicApiKey) },
                gemini: { ...gemini, keyHint: keyHint(geminiApiKey) }
            });
        } catch (error) {
            console.error('provider health error:', error.message);
            sendApiError(res, error, 'Failed to check provider health');
        }
    });

    // GET all projects
    app.get('/api/projects', requireAuth, async (req, res) => {
        try {
            const files = await fs.readdir(DATA_DIR);
            const projects = [];

            // ⚠️ This route reads the directory directly rather than going through
            // readProjectJSONById, so the chokepoint guard does NOT cover it and the
            // owner filter has to be applied here. It is the one project route that
            // resolves files without the shared helper; keep it that way deliberately
            // or move it onto the helper, but do not leave it half-way.
            const viewerEmail = req.userEmail || null;
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(DATA_DIR, file);
                    const content = await fs.readFile(filePath, 'utf-8');
                    const projectData = JSON.parse(content);
                    if (viewerEmail && String(projectData.owner || '').trim().toLowerCase() !== viewerEmail) continue;
                    projects.push({ id: projectData.id, title: projectData.title, author: projectData.data?.author || '' });
                }
            }

            // Sort newest first based on ID (which is a timestamp)
            projects.sort((a, b) => b.id - a.id);
            res.json({ projects });
        } catch (error) {
            console.error("Error reading projects:", error);
            sendApiError(res, error, 'Failed to load projects');
        }
    });

    // GET single project
    app.get('/api/projects/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            res.json(await readProjectJSONById(id));
        } catch (error) {
            console.error("Error reading project:", error);
            sendApiError(res, error, 'Failed to load project details');
        }
    });

    // POST new project
    app.post('/api/projects', requireAuth, async (req, res) => {
        try {
            const id = Date.now().toString();
            const newProject = {
                id,
                title: "New Project",
                // Stamped at birth. `writeProjectJSON` refuses a creation whose owner
                // is not the caller, so this is not merely bookkeeping — omitting it
                // makes the write fail rather than produce an unowned project.
                owner: req.userEmail || undefined,
                data: {}
            };

            const filePath = path.join(DATA_DIR, `${id}.json`);
            await writeJSONQueued(filePath, newProject);

            res.status(201).json(newProject);
        } catch (error) {
            console.error("Error creating project:", error);
            sendApiError(res, error, 'Failed to create project');
        }
    });

    // POST import script -> create project with Stage 6/7 pre-populated
    app.post('/api/import-script', requireAuth, upload.single('scriptFile'), async (req, res) => {
        try {
            const { parseFountain, parseFdx, parsePdfScript, buildStage6FromScenes } = require('../utils/script-import');
            const file = req.file;
            if (!file) throw new BadRequestError('No file uploaded');

            const ext = (file.originalname || '').split('.').pop().toLowerCase();
            const userTitle = req.body.title?.trim() || '';

            let parsed;
            if (ext === 'fountain') {
                const text = file.buffer.toString('utf-8');
                parsed = parseFountain(text);
            } else if (ext === 'fdx') {
                const xml = file.buffer.toString('utf-8');
                parsed = parseFdx(xml);
            } else if (ext === 'pdf') {
                parsed = await parsePdfScript(file.buffer, getModelConfig(1));
            } else {
                throw new BadRequestError(`Unsupported file type: .${ext}. Use .fountain, .fdx, or .pdf`);
            }

            if (!parsed.scenes || parsed.scenes.length === 0) {
                throw new BadRequestError('No scenes found in the uploaded file');
            }

            const title = userTitle || parsed.title || 'Imported Script';
            const stage6Scenes = buildStage6FromScenes(parsed.scenes);

            const id = Date.now().toString();
            const newProject = {
                id,
                title,
                owner: req.userEmail || undefined, // second creation path — same rule
                data: {
                    stage6_scenes: stage6Scenes,
                    stage7_style_skipped: true,
                    stage7_approved: true,
                    imported: true,
                    importedFrom: file.originalname || 'unknown'
                }
            };

            const filePath = path.join(DATA_DIR, `${id}.json`);
            await writeJSONQueued(filePath, newProject);

            console.log(`Imported script "${title}": ${parsed.scenes.length} scenes, ${stage6Scenes.length} sequences`);
            res.status(201).json({ projectId: id, title, sceneCount: parsed.scenes.length, sequenceCount: stage6Scenes.length });
        } catch (error) {
            console.error('Import script error:', error);
            sendApiError(res, error, 'Failed to import script');
        }
    });

    // PUT update project
    app.put('/api/projects/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            const updates = req.body;
            await assertProjectExists(id);

            const updatedProject = await updateProjectJSON(id, (projectData) => {
                // Ensure nested .data is merged properly rather than completely overwritten
                const previousData = projectData.data || {};
                let mergedData = previousData;
                if (updates.data) {
                    mergedData = { ...mergedData, ...updates.data };
                    if (Array.isArray(updates.data.versionHistory)) {
                        mergedData.versionHistory = mergeVersionHistory(previousData.versionHistory, updates.data.versionHistory);
                    }
                }

                // A stage PUT replaces the whole stage object, and `_meta` is
                // server-owned provenance the client does not always echo back — so
                // re-saving a stage silently dropped its `generated_at` and staleness
                // with it. This was invisible while every such PUT also called
                // stampRevised (which rebuilt a `_meta` from scratch); the moment that
                // stamp became conditional, the loss showed up as no metadata at all.
                // Carry the previous stamp forward unless the client sent a new one.
                if (updates.data) {
                    for (const key of Object.keys(updates.data)) {
                        const nextValue = mergedData[key];
                        const previousMeta = previousData[key]?._meta;
                        if (
                            previousMeta
                            && nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue)
                            && !nextValue._meta
                        ) {
                            mergedData[key] = { ...nextValue, _meta: previousMeta };
                        }
                    }
                }

                const nextProject = { ...projectData, ...updates, data: mergedData };
                delete nextProject.restoreVersionId;
                delete nextProject.skipSnapshots;
                const shouldDeriveStage4Beats = Boolean(
                    updates.data
                    && Object.prototype.hasOwnProperty.call(updates.data, 'stage2_outline')
                    && updates.data.stage2_outline?.outline
                );

                // Approving Stage 2 PUTs the outline back unchanged, and that used to be
                // stamped `manually_revised_at` just for showing up — so a project that was
                // only ever generated and approved told every downstream stage it had been
                // hand-revised, and each one got a SOURCE_AUTHORITY block asserting a
                // revision that never happened. The signal could never distinguish
                // "revised" from "approved". Compare the content instead.
                const outlineActuallyChanged = shouldDeriveStage4Beats
                    && artifactHash(updates.data.stage2_outline.outline)
                        !== artifactHash(previousData.stage2_outline?.outline);

                if (updates.data && !Array.isArray(updates.data.versionHistory) && !updates.skipSnapshots) {
                    const operation = updates.restoreVersionId ? 'restore' : 'manual_update';
                    for (const key of changedStageKeysFromUpdate(updates.data)) {
                        const config = stageConfig(key);
                        if (!config) continue;
                        recordArtifactMutation(nextProject, {
                            projectId: id,
                            stage: config.stage,
                            before: previousData[key],
                            after: updates.data[key],
                            operation,
                            note: updates.restoreVersionId ? `Restore ${updates.restoreVersionId}` : `Project update: ${key}`
                        });
                    }
                }

                // If the client signals a stage was revised, stamp staleness on downstream stages
                if (updates.stampRevisedStage) {
                    stampRevised(nextProject, updates.stampRevisedStage);
                    delete nextProject.stampRevisedStage; // Don't persist the flag itself
                }
                if (outlineActuallyChanged && updates.stampRevisedStage !== 'stage2_outline') {
                    stampRevised(nextProject, 'stage2_outline');
                }
                if (shouldDeriveStage4Beats) {
                    deriveStage4BeatsFromStage2Outline(nextProject, {
                        projectId: id,
                        stage2Outline: nextProject.data.stage2_outline,
                        operation: updates.restoreVersionId ? 'restore_derivation' : 'manual_derivation',
                        note: updates.restoreVersionId
                            ? `Derived from restored Stage 2 outline (${updates.restoreVersionId})`
                            : 'Derived from Stage 2 outline project update'
                    });
                }

                return nextProject;
            });

            res.json(updatedProject);
        } catch (error) {
            console.error("Error updating project:", error);
            sendApiError(res, error, 'Failed to update project');
        }
    });

    // PUT the Stage 1 draft — the typed story idea and the generated pitch options,
    // held before the writer selects one. Merged server-side per key so the debounced
    // idea save and the post-generation options save never overwrite each other;
    // `{ clear: true }` drops it once a pitch has been promoted to stage1_pitch.
    app.put('/api/projects/:id/stage1-draft', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            await assertProjectExists(id);

            const patch = req.body || {};
            const updated = await updateProjectJSON(id, (project) => (
                patch.clear ? clearStage1Draft(project) : applyStage1DraftPatch(project, patch)
            ));

            res.json({ success: true, stage1_draft: readStage1Draft(updated.data) });
        } catch (error) {
            console.error("Error saving Stage 1 draft:", error);
            sendApiError(res, error, 'Failed to save Stage 1 draft');
        }
    });

    // DELETE project
    app.delete('/api/projects/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            assertValidProjectId(id);
            const filePath = path.join(DATA_DIR, `${id}.json`);

            await assertProjectExists(id);

            await fs.unlink(filePath);
            await removeProjectSourceAssets(id).catch(error => {
                console.error('source asset cleanup error:', error.message);
            });
            res.json({ success: true });
        } catch (error) {
            console.error("Error deleting project:", error);
            sendApiError(res, error, 'Failed to delete project');
        }
    });
}

module.exports = {
    registerProjectRoutes
};
