const fs = require('fs/promises');
const path = require('path');

function registerStyleRoutes(app, deps) {
    const {
        requireAuth,
        aiLimiter,
        strictLimiter,
        upload,
        safeParse,
        isValidProjectId,
        isValidSlug,
        assertValidProjectId,
        BadRequestError,
        NotFoundError,
        sendApiError,
        getProjectFilePath,
        readProjectJSONById,
        buildSourceGenerationPacket,
        getModelConfigWithSourcePacket,
        getModelConfig,
        generateStyleFile,
        generateTrainedStyle,
        parseStyleFile,
        stampStyleFrontMatter,
        diffStyleSections,
        uniqueStyleSlug,
        atomicWriteFile,
        recordArtifactMutation,
        stampGenerated,
        recordSourceGenerationUsage,
        writeJSONQueued,
        trackUsage,
        sourceResponseExtras,
        uploadFileToAttachment,
        normalizeSourceText,
        extractAttachmentText,
        loadSkill,
        generateContent,
        STYLES_DIR,
        styleStore,
        normalizeStage3CharactersForPipeline
    } = deps;

    // ⚠️ Multi-user Phase 3: every READ of a style file in this module goes through
    // `styleStore` (utils/style_store.js), which decides shared-vs-private and
    // refuses with 404 what the caller may not see. `STYLES_DIR` is used here only
    // to place NEW files. If you find yourself writing `fs.readFile(path.join(
    // STYLES_DIR, ...))` in a route, you are about to serve someone's private style
    // to someone else.

    // Generate a style skill file from chat/form input
    app.post('/api/generate-stage7-style', requireAuth, aiLimiter, upload.array('sampleFiles', 5), async (req, res) => {
        try {
            const { projectId, description, conversationHistory: convRaw } = req.body;
            const conversationHistory = convRaw ? (safeParse(convRaw, []) || []) : [];

            // Load project context if projectId provided (optional for Landing Page creation)
            let projectData = null, filePath = null;
            if (projectId) {
                assertValidProjectId(projectId, 'Invalid projectId');
                filePath = getProjectFilePath(projectId);
                projectData = await readProjectJSONById(projectId, { invalidMessage: 'Invalid projectId' });
            }

            // Build scene summaries for context
            let sceneSummaries = '';
            if (projectData) {
                const s6 = projectData.data?.stage6_scenes || [];
                if (s6.length > 0) {
                    const lines = [];
                    for (const seq of s6) {
                        if (seq.scenes) for (const sc of seq.scenes) {
                            lines.push(`Scene ${sc.scene_number}: ${sc.scene_heading || sc.slugline || ''} — ${sc.narrative_action || ''}`);
                        }
                    }
                    sceneSummaries = lines.join('\n');
                }
            }

            // Is this a refine of a style this project owns, or a new style?
            //
            // The style library is GLOBAL: presets ship with the app and a style made
            // for one project can be selected by another. Overwriting on the strength of
            // "this project points at it" would let a refine here silently rewrite the
            // style another project is drafting with, or corrupt a bundled preset for
            // everyone. So in-place editing requires proof of ownership: a `project_id`
            // this server stamped into the front matter at generation time. Anything
            // without that stamp — every preset, every pre-existing style — falls
            // through to minting a new slug, which is the old behaviour and always safe.
            const previousSlug = projectData?.data?.stage7_style || null;
            let previousDirective = '';
            let ownsPreviousStyle = false;
            if (previousSlug && projectId && isValidSlug(previousSlug)) {
                // Through the store: a previous style the caller may not see reads as
                // absent, so the refine falls through to minting a new style — the
                // same safe fallthrough as every other "not ours" case below.
                const previous = await styleStore.tryReadStyle(previousSlug);
                if (previous?.directive) {
                    previousDirective = previous.directive;
                    const prevMeta = previous.meta;
                    const tier = String(prevMeta.tier).toLowerCase();
                    // Presets are shared library assets. TRAINED styles are excluded for a
                    // different reason: their directive is a DISTILLATION of a paired
                    // reference built from uploaded screenplays. Regenerating that directive
                    // from a chat brief would leave `paired_with` and `tier: trained`
                    // asserting a provenance the file no longer has — the artifact would
                    // claim to be derived from an analysis it had just been divorced from.
                    // Both fall through to minting a new style, which is the old behaviour.
                    // `editable` adds the Phase 3 rule on top: never rewrite a shared
                    // library style in place, whatever its tier line says.
                    ownsPreviousStyle = previous.editable
                        && tier !== 'preset'
                        && tier !== 'trained'
                        && String(prevMeta.project_id || '') === String(projectId);
                }
            }

            console.log(`Generating Stage 7 Style${projectId ? ` for project ${projectId}` : ' (standalone)'}${ownsPreviousStyle ? ` — refining ${previousSlug} in place` : ''}...`);
            const styleKnowledgeSeed = `${description || ''}\n${sceneSummaries}\n${conversationHistory.map(m => m.content).join('\n')}`;
            const sourcePacket = projectData
                ? buildSourceGenerationPacket(projectData, 7, styleKnowledgeSeed, { userMessage: description || '' })
                : null;
            const styleModelConfig = projectData
                ? getModelConfigWithSourcePacket(7, sourcePacket)
                : getModelConfig(7);
            const { result: rawStyleContent, usage } = await generateStyleFile({
                description: description || '',
                sceneSummaries,
                conversationHistory,
                previousDirective: ownsPreviousStyle ? previousDirective : ''
            }, styleModelConfig);

            // Parse the generated style to extract metadata
            const { meta: rawMeta } = parseStyleFile(rawStyleContent);
            const slug = ownsPreviousStyle
                ? previousSlug
                : await uniqueStyleSlug(rawMeta.slug || rawMeta.name || 'custom-style');

            // The slug is decided here, not by the model, so the front matter has to be
            // corrected to match: `uniqueStyleSlug` renames on collision and the model's
            // own `slug:` line then disagrees with the real filename. `project_id` is
            // what makes the next refine editable in place, and it must be server-stamped
            // — a model-authored ownership marker is not evidence of anything.
            // `created` is server-stamped for the same reason: the model has no clock
            // and invents plausible dates (a style generated 2026-08-09 arrived stamped
            // "2026-03-30"; presets carry "2024-05-24"). A refine keeps the original date.
            // `owner` (multi-user Phase 3) is the caller's email under a scoped identity
            // — it is what makes the style private to them; a refine keeps the original.
            const styleContent = stampStyleFrontMatter(rawStyleContent, {
                slug,
                created: ownsPreviousStyle
                    ? (parseStyleFile(previousDirective).meta.created || new Date().toISOString().slice(0, 10))
                    : new Date().toISOString().slice(0, 10),
                ...(projectId ? { project_id: String(projectId) } : {}),
                owner: ownsPreviousStyle
                    ? (parseStyleFile(previousDirective).meta.owner || styleStore.ownerStampForNewStyle())
                    : styleStore.ownerStampForNewStyle()
            });
            const { meta } = parseStyleFile(styleContent);

            // What actually changed, for the assistant to report instead of guessing.
            const styleReceipt = ownsPreviousStyle
                ? { ...diffStyleSections(previousDirective, styleContent), mode: 'refined-in-place', slug }
                : { mode: previousSlug ? 'new-style-created' : 'first-style-created', slug, changed: true };

            // Save as directive file (new naming convention)
            await atomicWriteFile(path.join(STYLES_DIR, `${slug}-directive.md`), styleContent);

            let snapshotEntries = [];
            // Update project if within project context
            if (projectData && filePath) {
                snapshotEntries = recordArtifactMutation(projectData, {
                    projectId,
                    stage: 7,
                    // Snapshot the directive TEXT, not the slug. Refining in place means
                    // the slug no longer changes, so a slug-only history would record
                    // "desert-standoff -> desert-standoff" and the previous wording — the
                    // only thing worth restoring — would be gone for good.
                    before: previousDirective || projectData.data?.stage7_style || null,
                    after: styleContent,
                    operation: ownsPreviousStyle ? 'revision' : 'generation',
                    note: description || ''
                });
                projectData.data = projectData.data || {};
                projectData.data.stage7_style = slug;
                stampGenerated(projectData, 'stage7_style');
                recordSourceGenerationUsage(projectData, sourcePacket, styleContent, 'generation');
                await writeJSONQueued(filePath, projectData);
                if (projectId) trackUsage(projectId, usage);
            }

            res.json({ slug, content: styleContent, meta, styleReceipt, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error('generate-stage7-style error:', error.message);
            sendApiError(res, error, 'Failed to generate style');
        }
    });

    // Preview a scene drafted in a specific style
    app.post('/api/preview-style-scene', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId, styleSlug, sceneIndex = 0 } = req.body;
            if (!isValidProjectId(projectId) || !isValidSlug(styleSlug)) throw new BadRequestError('Missing or invalid projectId or styleSlug');

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);

            // 404 for a style the caller may not see, before any model call.
            const { directive: styleContent } = await styleStore.readStyle(styleSlug);
            if (!styleContent) throw new NotFoundError(`Style "${styleSlug}" not found`);

            // Get the target scene
            const allScenes = [];
            for (const seq of (projectData.data?.stage6_scenes || [])) {
                if (seq.scenes) allScenes.push(...seq.scenes);
            }
            allScenes.sort((a, b) => a.scene_number - b.scene_number);
            const scene = allScenes[sceneIndex] || allScenes[0];
            if (!scene) throw new BadRequestError('No scenes found in project');

            const pitch = projectData.data?.stage1_pitch?.pitch;
            const projectContext = {
                synopsis: pitch?.synopsis || '',
                characters: normalizeStage3CharactersForPipeline(projectData.data?.stage3_characters || {})
            };
            const previewPacket = buildSourceGenerationPacket(projectData, 7, `${JSON.stringify(projectContext, null, 2)}\n${JSON.stringify(scene, null, 2)}`, { userMessage: 'Preview this scene in the selected style.' });

            // Use the Draft agent with style directives injected
            const draftSop = loadSkill('skill_stage8_draft');
            const prompt = `${draftSop}

${previewPacket.contextBlock ? `## PROJECT SOURCE CANON\n${previewPacket.contextBlock}\n` : ''}

## STYLE DIRECTIVES
Apply the following style to this scene:
${styleContent}

## PROJECT CONTEXT
SYNOPSIS: ${projectContext.synopsis || 'Not provided'}
CHARACTER PROFILES: ${JSON.stringify(projectContext.characters, null, 2)}

## SCENE BLUEPRINT
SCENE NUMBER: ${scene.scene_number}
SLUGLINE: ${scene.scene_heading || scene.slugline || ''}
NARRATIVE ACTION: ${scene.narrative_action || ''}
DRAMATURGICAL FUNCTION: ${scene.dramaturgical_function || ''}

## INSTRUCTIONS
Write a preview draft of this scene using the style directives above.
Output ONLY the raw Fountain-formatted text. No code blocks, no introductory text.`;

            const mc = getModelConfig(7);
            const response = await generateContent({
                model: mc.model, geminiApiKey: mc.geminiApiKey, anthropicApiKey: mc.anthropicApiKey,
                contents: prompt,
                config: { temperature: 0.7 }
            });

            recordSourceGenerationUsage(projectData, previewPacket, response.text, 'style_preview');
            await writeJSONQueued(filePath, projectData);
            trackUsage(projectId, response.usage);
            res.json({ sceneNumber: scene.scene_number, previewText: response.text, ...sourceResponseExtras(previewPacket) });
        } catch (error) {
            console.error('preview-style-scene error:', error.message);
            sendApiError(res, error, 'Failed to preview style scene');
        }
    });

    // List the styles the caller may use: the shared library plus their own.
    app.get('/api/styles', requireAuth, async (req, res) => {
        try {
            const styles = (await styleStore.listStyles()).map(({ slug, meta, hasReference, bundled, editable }) => ({
                slug,
                name: meta.name || slug,
                tonal_summary: meta.tonal_summary || '',
                references: meta.references || [],
                created: meta.created || '',
                tier: meta.tier || 'conversational',
                hasReference,
                // `bundled` = shared library, visible to everyone; `editable` = the caller
                // may PUT/DELETE it. The UI hides Edit/Delete when editable is false.
                bundled,
                editable
            }));
            res.json({ styles });
        } catch (error) {
            console.error('list styles error:', error.message);
            sendApiError(res, error, 'Failed to list styles');
        }
    });

    // Select an existing style for a project
    app.post('/api/select-style', requireAuth, async (req, res) => {
        try {
            const { projectId, styleSlug } = req.body;
            if (!isValidProjectId(projectId) || !isValidSlug(styleSlug)) throw new BadRequestError('Missing or invalid projectId or styleSlug');

            // Verify the style exists AND the caller may see it — a project must not
            // be able to point at another tenant's private style by slug.
            const { directive: styleContent } = await styleStore.readStyle(styleSlug);
            if (!styleContent) throw new NotFoundError(`Style "${styleSlug}" not found`);

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);

            projectData.data = projectData.data || {};
            projectData.data.stage7_style = styleSlug;
            stampGenerated(projectData, 'stage7_style');
            await writeJSONQueued(filePath, projectData);

            const { meta } = parseStyleFile(styleContent);
            res.json({ slug: styleSlug, content: styleContent, meta });
        } catch (error) {
            console.error('select-style error:', error.message);
            sendApiError(res, error, 'Failed to select style');
        }
    });

    // Generate a Tier 3 trained style from uploaded screenplay(s)
    app.post('/api/generate-trained-style', requireAuth, strictLimiter, upload.array('screenplayFiles', 5), async (req, res) => {
        try {
            const { projectId, styleName, conversationHistory: convRaw } = req.body;
            const conversationHistory = convRaw ? (safeParse(convRaw, []) || []) : [];

            // Extract text from uploaded screenplay files
            const screenplayTexts = [];
            const screenplayTitles = [];
            if (req.files?.length) {
                for (const file of req.files) {
                    const title = file.originalname.replace(/\.[^.]+$/, '');
                    screenplayTitles.push(title);
                    const attachment = uploadFileToAttachment(file);
                    const extractedText = normalizeSourceText(await extractAttachmentText(attachment));
                    if (extractedText) screenplayTexts.push(extractedText);
                }
            }

            if (screenplayTexts.length === 0) throw new BadRequestError('At least one screenplay file is required for trained style generation');

            let projectData = null;
            let filePath = null;
            let sourcePacket = null;
            if (projectId) {
                assertValidProjectId(projectId, 'Invalid projectId');
                filePath = getProjectFilePath(projectId);
                projectData = await readProjectJSONById(projectId, { invalidMessage: 'Invalid projectId' });
                const styleKnowledgeSeed = `${styleName || ''}\n${screenplayTitles.join('\n')}\n${conversationHistory.map(m => m.content).join('\n')}`;
                sourcePacket = buildSourceGenerationPacket(projectData, 7, styleKnowledgeSeed, { userMessage: styleName || 'Generate trained style.' });
            }

            console.log(`Generating Tier 3 trained style from ${screenplayTexts.length} screenplay(s)...`);
            const { reference, directive, usageList } = await generateTrainedStyle({
                styleName: styleName || '',
                screenplayTexts,
                screenplayTitles,
                conversationHistory
            }, sourcePacket ? getModelConfigWithSourcePacket(7, sourcePacket) : getModelConfig(7));

            // Extract slug from reference metadata
            const { meta: refMeta } = parseStyleFile(reference);
            const slug = await uniqueStyleSlug(refMeta.slug || refMeta.name || styleName || 'trained-style');

            // Same server-side stamping the conversational path does: the slug is decided
            // here (uniqueStyleSlug renames on collision, leaving the model's own `slug:`
            // line pointing at a filename that does not exist), and `project_id` is the
            // ownership marker that lets a later refine edit in place instead of minting
            // a duplicate. Without it a trained style is permanently un-refinable — safe,
            // since it falls through to creating a new style, but needlessly so.
            // `paired_with` has to follow the corrected slug or the directive points at
            // the wrong reference file.
            const stampFields = {
                slug,
                // Server clock, not the model's guess — see the conversational path.
                created: new Date().toISOString().slice(0, 10),
                ...(projectId ? { project_id: String(projectId) } : {}),
                // Phase 3: private to its creator. Stamped on BOTH files — the reference
                // is the analysis of the screenplays they uploaded, the more sensitive half.
                owner: styleStore.ownerStampForNewStyle()
            };
            const stampedReference = stampStyleFrontMatter(reference, stampFields);
            const stampedDirective = stampStyleFrontMatter(directive, { ...stampFields, paired_with: `${slug}-reference` });

            // Save both files atomically
            await atomicWriteFile(path.join(STYLES_DIR, `${slug}-reference.md`), stampedReference);
            await atomicWriteFile(path.join(STYLES_DIR, `${slug}-directive.md`), stampedDirective);

            // Update project if within project context
            if (projectData && filePath) {
                projectData.data = projectData.data || {};
                projectData.data.stage7_style = slug;
                stampGenerated(projectData, 'stage7_style');
                recordSourceGenerationUsage(projectData, sourcePacket, stampedDirective, 'trained_style_generation');
                // A trained style is a real style choice — clear the import-time skip so
                // the stage stops behaving as though the writer opted out of styling.
                projectData.data.stage7_style_skipped = false;
                await writeJSONQueued(filePath, projectData);
                trackUsage(projectId, usageList);
            }

            const { meta } = parseStyleFile(stampedDirective);
            res.json({ slug, content: stampedDirective, directive: stampedDirective, reference: stampedReference, meta, tier: 'trained', ...sourceResponseExtras(sourcePacket) });
        } catch (error) {
            console.error('generate-trained-style error:', error.message);
            sendApiError(res, error, 'Failed to generate trained style');
        }
    });

    // Get full style content (directive + reference if exists)
    app.get('/api/styles/:slug', requireAuth, async (req, res) => {
        try {
            const { slug } = req.params;
            if (!isValidSlug(slug)) throw new BadRequestError('Invalid slug');

            // 404 for absent AND for not-yours, indistinguishably (style store).
            const style = await styleStore.readStyle(slug);
            if (!style.directive) throw new NotFoundError(`Style "${slug}" not found`);
            const { directive, reference, meta, body, tier, bundled, editable } = style;

            res.json({ slug, directive, reference, meta, body, tier, bundled, editable });
        } catch (error) {
            console.error('get-style error:', error.message);
            sendApiError(res, error, 'Failed to load style');
        }
    });

    // Update a style's directive content.
    // 404 if the caller may not see it, 403 if it is a shared library style. The
    // store re-applies server-owned provenance (slug/owner/created/project_id) from
    // the file on disk — the client edits the body, never the ownership.
    app.put('/api/styles/:slug', requireAuth, async (req, res) => {
        try {
            const { slug } = req.params;
            const { content } = req.body;
            if (!isValidSlug(slug)) throw new BadRequestError('Invalid slug');
            if (!content) throw new BadRequestError('Missing content');

            const { meta } = await styleStore.writeDirective(slug, content, { atomicWriteFile });
            res.json({ slug, meta });
        } catch (error) {
            console.error('update-style error:', error.message);
            sendApiError(res, error, 'Failed to update style');
        }
    });

    // Delete a style (removes both directive and reference files). Same refusal
    // rules as PUT; a shared library style cannot be deleted by anyone signed in —
    // and would only come back at the next restart anyway (seedBundledStyles).
    app.delete('/api/styles/:slug', requireAuth, async (req, res) => {
        try {
            const { slug } = req.params;
            if (!isValidSlug(slug)) throw new BadRequestError('Invalid slug');

            await styleStore.deleteStyle(slug);
            res.json({ deleted: true, slug });
        } catch (error) {
            console.error('delete-style error:', error.message);
            sendApiError(res, error, 'Failed to delete style');
        }
    });
}

module.exports = {
    registerStyleRoutes
};
