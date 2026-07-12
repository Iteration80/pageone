const { execFile } = require('child_process');
const modulePath = require('path');

function registerProjectRoutes(app, deps) {
    const {
        requireAuth,
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
        recordArtifactMutation,
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

    app.get('/api/maintenance/legacy-projects/audit', requireAuth, async (_req, res) => {
        try {
            res.json(await auditOrUpgradeAllProjectKnowledge({ write: false }));
        } catch (error) {
            console.error('legacy project audit error:', error.message);
            sendApiError(res, error, 'Failed to audit legacy projects');
        }
    });

    app.post('/api/maintenance/legacy-projects/upgrade', requireAuth, async (_req, res) => {
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

    app.get('/api/maintenance/stage3-tiers/audit', requireAuth, async (req, res) => {
        try {
            res.json(await runTierMigration(false, { overwrite: shouldOverwriteStage3Tiers(req) }));
        } catch (error) {
            console.error('stage3 tier audit error:', error.message);
            sendApiError(res, error, 'Failed to audit Stage 3 tier overrides');
        }
    });

    app.post('/api/maintenance/stage3-tiers/seed', requireAuth, async (req, res) => {
        try {
            res.json(await runTierMigration(true, { overwrite: shouldOverwriteStage3Tiers(req) }));
        } catch (error) {
            console.error('stage3 tier seed error:', error.message);
            sendApiError(res, error, 'Failed to seed Stage 3 tier overrides');
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

    app.get('/api/maintenance/provider-health', requireAuth, async (_req, res) => {
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

            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(DATA_DIR, file);
                    const content = await fs.readFile(filePath, 'utf-8');
                    const projectData = JSON.parse(content);
                    projects.push({ id: projectData.id, title: projectData.title });
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

                const nextProject = { ...projectData, ...updates, data: mergedData };
                delete nextProject.restoreVersionId;
                delete nextProject.skipSnapshots;

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

                return nextProject;
            });

            res.json(updatedProject);
        } catch (error) {
            console.error("Error updating project:", error);
            sendApiError(res, error, 'Failed to update project');
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
