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
        normalizeStage3CharactersForPipeline
    } = deps;

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

            console.log(`Generating Stage 7 Style${projectId ? ` for project ${projectId}` : ' (standalone)'}...`);
            const styleKnowledgeSeed = `${description || ''}\n${sceneSummaries}\n${conversationHistory.map(m => m.content).join('\n')}`;
            const sourcePacket = projectData
                ? buildSourceGenerationPacket(projectData, 7, styleKnowledgeSeed, { userMessage: description || '' })
                : null;
            const styleModelConfig = projectData
                ? getModelConfigWithSourcePacket(7, sourcePacket)
                : getModelConfig(7);
            const { result: styleContent, usage } = await generateStyleFile({
                description: description || '',
                sceneSummaries,
                conversationHistory
            }, styleModelConfig);

            // Parse the generated style to extract metadata
            const { meta } = parseStyleFile(styleContent);
            const slug = await uniqueStyleSlug(meta.slug || meta.name || 'custom-style');

            // Save as directive file (new naming convention)
            await atomicWriteFile(path.join(STYLES_DIR, `${slug}-directive.md`), styleContent);

            let snapshotEntries = [];
            // Update project if within project context
            if (projectData && filePath) {
                snapshotEntries = recordArtifactMutation(projectData, {
                    projectId,
                    stage: 7,
                    before: projectData.data?.stage7_style || null,
                    after: slug,
                    operation: 'generation',
                    note: description || ''
                });
                projectData.data = projectData.data || {};
                projectData.data.stage7_style = slug;
                stampGenerated(projectData, 'stage7_style');
                recordSourceGenerationUsage(projectData, sourcePacket, styleContent, 'generation');
                await writeJSONQueued(filePath, projectData);
                if (projectId) trackUsage(projectId, usage);
            }

            res.json({ slug, content: styleContent, meta, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(sourcePacket) });
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

            // Load style file — try new naming first, fall back to legacy
            let styleContent;
            try {
                styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}-directive.md`), 'utf-8');
            } catch {
                try {
                    styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf-8');
                } catch {
                    throw new NotFoundError(`Style "${styleSlug}" not found`);
                }
            }

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

    // List all available styles
    app.get('/api/styles', requireAuth, async (req, res) => {
        try {
            let files;
            try { files = await fs.readdir(STYLES_DIR); } catch { files = []; }

            // Group files by slug: [slug]-directive.md, [slug]-reference.md, or legacy [slug].md
            const styleMap = new Map(); // slug -> { directiveFile, referenceFile }
            for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const tieredMatch = file.match(/^(.+?)-(directive|reference)\.md$/);
                if (tieredMatch) {
                    const [, slug, type] = tieredMatch;
                    if (!styleMap.has(slug)) styleMap.set(slug, {});
                    styleMap.get(slug)[type === 'directive' ? 'directiveFile' : 'referenceFile'] = file;
                } else {
                    // Legacy single-file style
                    const slug = file.replace(/\.md$/, '');
                    if (!styleMap.has(slug)) styleMap.set(slug, {});
                    styleMap.get(slug).directiveFile = file;
                }
            }

            const styles = [];
            for (const [slug, entry] of styleMap) {
                // Read the directive (primary metadata source)
                const metaFile = entry.directiveFile || entry.referenceFile;
                if (!metaFile) continue;
                try {
                    const raw = await fs.readFile(path.join(STYLES_DIR, metaFile), 'utf-8');
                    const { meta } = parseStyleFile(raw);
                    styles.push({
                        slug,
                        name: meta.name || slug,
                        tonal_summary: meta.tonal_summary || '',
                        references: meta.references || [],
                        created: meta.created || '',
                        tier: meta.tier || 'conversational',
                        hasReference: !!entry.referenceFile
                    });
                } catch {
                    styles.push({ slug, name: slug, tonal_summary: '', references: [], created: '', tier: 'conversational', hasReference: false });
                }
            }
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

            // Verify style exists — try new naming first, fall back to legacy
            let styleContent = null;
            try {
                styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}-directive.md`), 'utf-8');
            } catch {
                try {
                    styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf-8');
                } catch {
                    throw new NotFoundError(`Style "${styleSlug}" not found`);
                }
            }

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

            // Save both files atomically
            await atomicWriteFile(path.join(STYLES_DIR, `${slug}-reference.md`), reference);
            await atomicWriteFile(path.join(STYLES_DIR, `${slug}-directive.md`), directive);

            // Update project if within project context
            if (projectData && filePath) {
                projectData.data = projectData.data || {};
                projectData.data.stage7_style = slug;
                stampGenerated(projectData, 'stage7_style');
                recordSourceGenerationUsage(projectData, sourcePacket, directive, 'trained_style_generation');
                await writeJSONQueued(filePath, projectData);
                trackUsage(projectId, usageList);
            }

            const { meta } = parseStyleFile(directive);
            res.json({ slug, content: directive, directive, reference, meta, tier: 'trained', ...sourceResponseExtras(sourcePacket) });
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
            let directive = null, reference = null;

            // Try new naming first, fall back to legacy
            try {
                directive = await fs.readFile(path.join(STYLES_DIR, `${slug}-directive.md`), 'utf-8');
            } catch {
                try {
                    directive = await fs.readFile(path.join(STYLES_DIR, `${slug}.md`), 'utf-8');
                } catch {
                    throw new NotFoundError(`Style "${slug}" not found`);
                }
            }

            // Load reference if it exists (Tier 3 only)
            try {
                reference = await fs.readFile(path.join(STYLES_DIR, `${slug}-reference.md`), 'utf-8');
            } catch { /* no reference = Tier 2 */ }

            const { meta, body } = parseStyleFile(directive);
            const tier = reference ? 'trained' : (meta.tier || 'conversational');

            res.json({ slug, directive, reference, meta, body, tier });
        } catch (error) {
            console.error('get-style error:', error.message);
            sendApiError(res, error, 'Failed to load style');
        }
    });

    // Update a style's directive content
    app.put('/api/styles/:slug', requireAuth, async (req, res) => {
        try {
            const { slug } = req.params;
            const { content } = req.body;
            if (!isValidSlug(slug)) throw new BadRequestError('Invalid slug');
            if (!content) throw new BadRequestError('Missing content');

            // Verify the file exists first
            let filePath;
            try {
                filePath = path.join(STYLES_DIR, `${slug}-directive.md`);
                await fs.access(filePath);
            } catch {
                try {
                    filePath = path.join(STYLES_DIR, `${slug}.md`);
                    await fs.access(filePath);
                } catch {
                    throw new NotFoundError(`Style "${slug}" not found`);
                }
            }

            await atomicWriteFile(filePath, content);
            const { meta } = parseStyleFile(content);
            res.json({ slug, meta });
        } catch (error) {
            console.error('update-style error:', error.message);
            sendApiError(res, error, 'Failed to update style');
        }
    });

    // Delete a style (removes both directive and reference files)
    app.delete('/api/styles/:slug', requireAuth, async (req, res) => {
        try {
            const { slug } = req.params;
            if (!isValidSlug(slug)) throw new BadRequestError('Invalid slug');
            let deleted = false;

            // Delete all possible files for this slug
            for (const suffix of ['-directive.md', '-reference.md', '.md']) {
                try {
                    await fs.unlink(path.join(STYLES_DIR, `${slug}${suffix}`));
                    deleted = true;
                } catch { /* file doesn't exist, that's fine */ }
            }

            if (!deleted) throw new NotFoundError('Style not found');
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
