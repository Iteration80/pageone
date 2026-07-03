function registerExportRoutes(app, deps) {
    const {
        requireAuth,
        readProjectJSONById,
        BadRequestError,
        sendApiError,
        generatePitchDocx,
        generateBeatsDocx,
        generateScenesDocx,
        generateCoverageDocx,
        generateOutlineDocx,
        generateCharactersDocx,
        generateTreatmentDocx,
        generateDraftDocx,
        generateScreenplayPdf,
        exportStageNumber,
        recordExportSnapshot,
        writeJSONQueued,
        getProjectFilePath
    } = deps;

    async function loadProjectData(projectId) {
        return readProjectJSONById(projectId, {
            invalidMessage: 'Invalid project ID',
            notFoundMessage: 'Project not found'
        });
    }

    // GET /api/export/docx/:projectId?stage=outline|characters|treatment|draft|coverage
    app.get('/api/export/docx/:projectId', requireAuth, async (req, res) => {
        try {
            const { projectId } = req.params;
            const stage = req.query.stage || 'coverage';
            const project = await loadProjectData(projectId);
            const data = project.data || {};
            const title = data.stage1_pitch?.pitch?.title || project.title || 'Untitled';
            const safeName = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();

            let buf, filename;

            if (stage === 'pitch') {
                const pitch = data.stage1_pitch?.pitch;
                if (!pitch) throw new BadRequestError('No pitch data found');
                buf = await generatePitchDocx(pitch);
                filename = `${safeName}_pitch.docx`;

            } else if (stage === 'coverage') {
                if (!data.stage8_coverage) throw new BadRequestError('No coverage data found');
                buf = await generateCoverageDocx(data.stage8_coverage);
                filename = `${safeName}_coverage.docx`;

            } else if (stage === 'outline') {
                const outline = data.stage2_outline?.outline;
                if (!outline) throw new BadRequestError('No outline data found');
                buf = await generateOutlineDocx(outline, title);
                filename = `${safeName}_outline.docx`;

            } else if (stage === 'characters') {
                const chars = data.stage3_characters?.characters;
                if (!chars || !chars.length) throw new BadRequestError('No character data found');
                buf = await generateCharactersDocx(chars, title);
                filename = `${safeName}_characters.docx`;

            } else if (stage === 'treatment') {
                if (!data.stage5_treatment) throw new BadRequestError('No treatment data found');
                buf = await generateTreatmentDocx(data.stage5_treatment, title);
                filename = `${safeName}_treatment.docx`;

            } else if (stage === 'beats') {
                const beats = data.stage4_beats || data.stage4_treatment;
                if (!beats?.hybrid_beat_sheet) throw new BadRequestError('No beat sheet data found');
                buf = await generateBeatsDocx(beats, title);
                filename = `${safeName}_beats.docx`;

            } else if (stage === 'scenes') {
                const seqs = data.stage6_scenes;
                if (!seqs || !seqs.length) throw new BadRequestError('No scene blueprint data found');
                const sequences = Array.isArray(seqs) ? seqs : (seqs.sequences || []);
                buf = await generateScenesDocx(sequences, title);
                filename = `${safeName}_scene_blueprint.docx`;

            } else if (stage === 'draft') {
                const scenes = (data.stage6_scenes || []).flatMap(seq => seq.scenes || []);
                const drafted = scenes.filter(s => s.draft_text || s.humanized_draft_text);
                if (!drafted.length) throw new BadRequestError('No drafted scenes found');
                buf = await generateDraftDocx(drafted, title);
                filename = `${safeName}_draft.docx`;

            } else if (stage === 'rewrite') {
                const working = data.stage9_rewrites?.working;
                if (!working) throw new BadRequestError('No rewrite data found');
                // Convert working object to scene-like array for draft export
                const fakescenes = Object.entries(working).map(([, txt]) => ({ humanized_draft_text: txt }));
                buf = await generateDraftDocx(fakescenes, title);
                filename = `${safeName}_rewrite.docx`;

            } else {
                throw new BadRequestError(`Unknown stage: ${stage}`);
            }

            const exportStage = exportStageNumber(stage);
            if (exportStage) {
                recordExportSnapshot(project, projectId, exportStage, `DOCX export: ${stage}`);
                await writeJSONQueued(getProjectFilePath(projectId), project);
            }

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(buf);
        } catch (err) {
            console.error('DOCX export error:', err);
            sendApiError(res, err, 'Export failed');
        }
    });

    // GET /api/export/pdf/:projectId?stage=draft|rewrite
    app.get('/api/export/pdf/:projectId', requireAuth, async (req, res) => {
        try {
            const { projectId } = req.params;
            const stage = req.query.stage || 'draft';
            const project = await loadProjectData(projectId);
            const data = project.data || {};
            const title = data.stage1_pitch?.pitch?.title || project.title || 'Untitled';
            const safeName = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();

            let scenes;
            if (stage === 'rewrite') {
                const working = data.stage9_rewrites?.working;
                if (!working) throw new BadRequestError('No rewrite data found');
                scenes = Object.entries(working)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .filter(([, txt]) => txt && txt.trim() !== '[SCENE DELETED]')
                    .map(([, txt]) => ({ humanized_draft_text: txt }));
            } else {
                scenes = (data.stage6_scenes || []).flatMap(seq => seq.scenes || []);
                scenes = scenes.filter(s => s.draft_text || s.humanized_draft_text);
            }

            if (!scenes.length) throw new BadRequestError('No scenes to export');

            const buf = await generateScreenplayPdf(scenes, title);
            const filename = `${safeName}_${stage}.pdf`;
            const exportStage = exportStageNumber(stage);
            if (exportStage) {
                recordExportSnapshot(project, projectId, exportStage, `PDF export: ${stage}`);
                await writeJSONQueued(getProjectFilePath(projectId), project);
            }

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(buf);
        } catch (err) {
            console.error('PDF export error:', err);
            sendApiError(res, err, 'Export failed');
        }
    });
}

module.exports = {
    registerExportRoutes
};
