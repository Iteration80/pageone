require('dotenv').config();
const { setGlobalDispatcher, Agent } = require('undici');
setGlobalDispatcher(new Agent({ headersTimeout: 300_000, bodyTimeout: 300_000 }));
const express = require('express');
const fs = require('fs/promises');
const path = require('path');

/** Extracts plain text from a chat attachment ({ name, mimeType, data: base64 }). */
async function extractAttachmentText(attachment) {
    if (!attachment?.data) return '';
    const buf = Buffer.from(attachment.data, 'base64');
    const name = (attachment.name || '').toLowerCase();
    const mime = (attachment.mimeType || '').toLowerCase();
    try {
        if (mime === 'text/plain' || name.endsWith('.txt')) {
            return buf.toString('utf8');
        }
        if (mime === 'application/pdf' || name.endsWith('.pdf')) {
            const pdfParse = require('pdf-parse');
            const parsed = await pdfParse(buf);
            return parsed.text;
        }
        if (name.endsWith('.docx') || mime.includes('wordprocessingml')) {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer: buf });
            return result.value;
        }
    } catch (e) {
        console.error('Attachment extraction error:', e.message);
    }
    return '';
}

// ─── Settings (BYOK + per-stage model config) ─────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, 'data', 'settings.json');
let appSettings = {};

async function loadSettings() {
    try {
        const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
        appSettings = JSON.parse(raw);
        console.log('Settings loaded from data/settings.json');
    } catch {
        appSettings = {}; // file doesn't exist yet — fall back to .env
    }
}

/** Returns the model + API keys to use for a given stage number (1–9). */
function getModelConfig(stageNum) {
    return {
        model: appSettings.stageModels?.[`stage${stageNum}`] || process.env.GEMINI_MODEL,
        geminiApiKey: appSettings.geminiApiKey || process.env.GEMINI_API_KEY,
        anthropicApiKey: appSettings.anthropicApiKey || process.env.ANTHROPIC_API_KEY
    };
}
/** Append API usage record to the project's apiUsage array. */
async function trackUsage(projectId, usageOrList) {
    if (!projectId || !usageOrList) return;
    try {
        const usages = Array.isArray(usageOrList) ? usageOrList : [usageOrList];
        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const raw = await fs.readFile(filePath, 'utf-8');
        const project = JSON.parse(raw);
        if (!project.data) project.data = {};
        if (!project.data.apiUsage) project.data.apiUsage = [];
        const now = Date.now();
        for (const u of usages) {
            if (!u || !u.model) continue;
            project.data.apiUsage.push({
                timestamp: now,
                model: u.model,
                inputTokens: u.inputTokens || 0,
                outputTokens: u.outputTokens || 0,
            });
        }
        await fs.writeFile(filePath, JSON.stringify(project, null, 2));
    } catch (err) {
        console.error('trackUsage error:', err.message);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

const {
    generatePitchDocx,
    generateBeatsDocx,
    generateScenesDocx,
    generateCoverageDocx,
    generateOutlineDocx,
    generateCharactersDocx,
    generateTreatmentDocx,
    generateDraftDocx,
    generateScreenplayPdf
} = require('./agents/export');

const { agent1Pitch } = require('./agents/agent_1_pitch');
const { agent1Refine } = require('./agents/agent_1_refine');
const { agent2Outline } = require('./agents/agent_2_outline');
const { agent3Characters } = require('./agents/agent_3_characters');
const { agent4Beats } = require('./agents/agent_4_beats');
const { agent5Treatment } = require('./agents/agent_5_treatment');
const { generateStage6Scenes } = require('./agents/agent_6_scenes');
const { reviseStage6Scenes } = require('./agents/agent_6_revise');
const { generateSceneDraft } = require('./agents/agent_8_draft');
const { humanizeDraft } = require('./agents/agent_humanizer');
const { agent8Coverage } = require('./agents/agent_9_coverage');
const { rewriteScene } = require('./agents/agent_10_rewrite');
const { generateStyleFile, parseStyleFile } = require('./agents/agent_7_style');
const { stampGenerated, stampRevised, buildSourceAuthorityBlock } = require('./utils/stageMetadata');

const STYLES_DIR = path.join(__dirname, 'data', 'styles');

/**
 * Load the style file for a project, if one is set and exists.
 * Returns { styleContent, styleWarning } where styleContent is the markdown
 * string (or null) and styleWarning is a UI-facing notice (or null).
 */
async function loadProjectStyle(projectData) {
    const slug = projectData.data?.stage7_style;
    if (!slug || slug === 'none') return { styleContent: null, styleWarning: null };
    try {
        const content = await fs.readFile(path.join(STYLES_DIR, `${slug}.md`), 'utf-8');
        return { styleContent: content, styleWarning: null };
    } catch {
        console.warn(`Style file "${slug}.md" not found — drafting without style directives.`);
        return { styleContent: null, styleWarning: `The style "${slug}" is no longer available. Drafting without style directives.` };
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const DATA_DIR = path.join(__dirname, 'data', 'projects');

// Initialization
async function initDb() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(STYLES_DIR, { recursive: true });
    } catch (err) {
        console.error("Failed to create data directory:", err);
    }
}
initDb();
loadSettings();

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '20mb' }));

// API route
app.post('/api/execute', upload.single('pdfFile'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const pdfFile = req.file;

        // Validation removed to allow random pitch generation if both are empty

        console.log("Generating pitch options...");
        const result = await agent1Pitch(prompt, pdfFile, getModelConfig(1));
        res.json({ result });
    } catch (error) {
        console.error("Error executing agent:", error);
        res.status(500).json({ error: error.message || "An error occurred" });
    }
});

app.post('/api/refine-pitch', upload.single('pdfFile'), async (req, res) => {
    try {
        const { currentPitch, userNote } = req.body || {};
        const pdfFile = req.file;

        if (!currentPitch || !userNote) {
            return res.status(400).json({ error: "Missing currentPitch or userNote" });
        }

        // currentPitch might be a string if sent via FormData
        const parsedPitch = typeof currentPitch === 'string' ? JSON.parse(currentPitch) : currentPitch;

        console.log("Revising pitch...");
        const result = await agent1Refine(JSON.stringify(parsedPitch), userNote, pdfFile, getModelConfig(1));
        res.json({ result });
    } catch (error) {
        console.error("Error executing refine agent:", error);
        res.status(500).json({ error: error.message || "An error occurred" });
    }
});

app.post('/api/generate-outline', upload.single('pdfFile'), async (req, res) => {
    try {
        const { projectId, currentBeats, notes } = req.body;
        const pdfFile = req.file;

        if (!projectId) {
            return res.status(400).json({ error: "Missing projectId" });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        const stage1 = projectData.data?.stage1_pitch?.pitch;
        if (!stage1) {
            return res.status(400).json({ error: "Project has no finalized Stage 1 Pitch" });
        }

        const parsedBeats = currentBeats ? (typeof currentBeats === 'string' ? JSON.parse(currentBeats) : currentBeats) : null;

        console.log("Generating Stage 2 Outline...");
        const { result: outlineData, usage } = await agent2Outline(stage1, parsedBeats, notes, pdfFile, getModelConfig(2));

        // Save to Stage 2
        projectData.data = projectData.data || {};
        projectData.data.stage2_outline = outlineData;
        notes ? stampRevised(projectData, 'stage2_outline') : stampGenerated(projectData, 'stage2_outline');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, usage);

        res.json({ result: outlineData });
    } catch (error) {
        console.error('Outline Gen Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/generate-characters', upload.single('pdfFile'), async (req, res) => {
    try {
        const { projectId, currentCharacters, notes } = req.body;
        const pdfFile = req.file;

        if (!projectId) {
            return res.status(400).json({ error: "Missing projectId" });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        const pitchData = projectData.data?.stage1_pitch?.pitch;
        const beatsData = projectData.data?.stage2_outline?.outline;

        if (!pitchData || !beatsData) {
            return res.status(400).json({ error: "Project requires Stage 1 Pitch and Stage 2 Outline to generate Characters" });
        }

        const parsedChars = currentCharacters ? (typeof currentCharacters === 'string' ? JSON.parse(currentCharacters) : currentCharacters) : null;

        console.log("Generating Stage 3 Characters...");
        const { result: characterData, usage } = await agent3Characters(pitchData, beatsData, parsedChars, notes, pdfFile, getModelConfig(3));

        // Save to Stage 3
        projectData.data = projectData.data || {};
        projectData.data.stage3_characters = characterData;
        notes ? stampRevised(projectData, 'stage3_characters') : stampGenerated(projectData, 'stage3_characters');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, usage);

        res.json({ result: characterData });
    } catch (error) {
        console.error('Character Gen Error:', error);
        res.status(500).json({ error: error.message || "Failed to generate characters" });
    }
});

app.post('/api/generate-stage4-beats', upload.single('pdfFile'), async (req, res) => {
    const { projectId, currentBeats, notes } = req.body || {};
    const pdfFile = req.file;

    if (!projectId) {
        return res.status(400).json({ error: "Missing projectId" });
    }

    const filePath = path.join(DATA_DIR, `${projectId}.json`);
    let projectData;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        projectData = JSON.parse(content);
    } catch (err) {
        return res.status(404).json({ error: "Project not found" });
    }

    const pitchData = projectData.data?.stage1_pitch?.pitch;
    const beatsData = projectData.data?.stage2_outline?.outline;
    const charsData = projectData.data?.stage3_characters?.characters;

    if (!pitchData || !beatsData || !charsData) {
        return res.status(400).json({ error: "Project requires Stages 1-3 to generate Beats" });
    }

    const parsedCurrentBeats = currentBeats ? (typeof currentBeats === 'string' ? JSON.parse(currentBeats) : currentBeats) : null;

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        console.log("Generating Stage 4 Beats...");
        const { result: beatsResult, usage } = await agent4Beats(
            pitchData, beatsData, charsData, parsedCurrentBeats, notes, pdfFile,
            (label) => send({ type: 'progress', label }),
            getModelConfig(4)
        );

        console.log("Beats generated successfully. Beat sheet length:", beatsResult.hybrid_beat_sheet?.length || 0);

        projectData.data = projectData.data || {};
        projectData.data.stage4_beats = beatsResult;
        notes ? stampRevised(projectData, 'stage4_beats') : stampGenerated(projectData, 'stage4_beats');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, usage);

        send({ type: 'complete', result: beatsResult });
    } catch (error) {
        console.error('Stage 4 Beats Gen Error:', error.message);
        send({ type: 'error', message: error.message || 'Failed to generate beats' });
    } finally {
        res.end();
    }
});

app.post('/api/generate-stage5-treatment', upload.single('pdfFile'), async (req, res) => {
    const { projectId } = req.body || {};
    if (!projectId) {
        return res.status(400).json({ error: "Missing projectId" });
    }

    const filePath = path.join(DATA_DIR, `${projectId}.json`);
    let projectData;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        projectData = JSON.parse(content);
    } catch (err) {
        return res.status(404).json({ error: "Project not found" });
    }

    const pitchData = projectData.data?.stage1_pitch?.pitch;
    const charactersData = projectData.data?.stage3_characters?.characters;
    const beatsData = projectData.data?.stage4_beats?.hybrid_beat_sheet;

    const { notes, currentTreatment } = req.body;
    const parsedTreatment = currentTreatment ? JSON.parse(currentTreatment) : null;

    if (!pitchData || !charactersData || !beatsData) {
        return res.status(400).json({ error: "Project requires Stages 1, 3, and 4 to generate Treatment" });
    }

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        console.log("Generating Stage 5 Chained Treatment...");
        const { result: treatmentResult, usageList } = await agent5Treatment(
            pitchData, charactersData, beatsData, parsedTreatment, notes,
            (step, total, label) => send({ type: 'progress', step, total, label }),
            getModelConfig(5)
        );

        projectData.data = projectData.data || {};
        projectData.data.stage5_treatment = treatmentResult;
        notes ? stampRevised(projectData, 'stage5_treatment') : stampGenerated(projectData, 'stage5_treatment');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, usageList);

        send({ type: 'complete', result: treatmentResult });
    } catch (error) {
        console.error('Stage 5 Treatment Gen Error:', error.message);
        send({ type: 'error', message: error.message || 'Failed to generate treatment' });
    } finally {
        res.end();
    }
});

app.post('/api/generate-stage6-scenes', async (req, res) => {
    const { projectId } = req.body;
    if (!projectId) {
        return res.status(400).json({ error: "Missing projectId" });
    }

    const filePath = path.join(DATA_DIR, `${projectId}.json`);
    let projectData;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        projectData = JSON.parse(content);
    } catch (err) {
        return res.status(404).json({ error: "Project not found" });
    }

    const pitch = projectData.data?.stage1_pitch?.pitch;
    const characters = projectData.data?.stage3_characters?.characters;
    const beats = projectData.data?.stage4_beats?.hybrid_beat_sheet;
    const treatment = projectData.data?.stage5_treatment;

    if (!pitch || !characters || !beats || !treatment) {
        return res.status(400).json({ error: "Project requires Stages 1, 3, 4, and 5 to generate Scene Blueprint" });
    }

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        console.log("Generating Stage 6 Scene Blueprint (Sequential Chain)...");
        const sourceAuthorityBlock = buildSourceAuthorityBlock(projectData, 'stage6_scenes');
        if (sourceAuthorityBlock) {
            console.log("Stage 6: upstream revisions detected, injecting source authority block.");
        }

        const { result: allSequences, usageList } = await generateStage6Scenes(
            pitch, characters, beats, treatment,
            (current, total) => send({ type: 'progress', current, total }),
            sourceAuthorityBlock,
            getModelConfig(6)
        );

        projectData.data = projectData.data || {};
        projectData.data.stage6_scenes = allSequences;
        stampGenerated(projectData, 'stage6_scenes');
        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, usageList);

        send({ type: 'complete', result: allSequences });
    } catch (error) {
        console.error('Stage 6 Scene Gen Error:', error.message);
        send({ type: 'error', message: error.message || "Failed to generate scene blueprint" });
    } finally {
        res.end();
    }
});

app.post('/api/revise-stage6', async (req, res) => {
    try {
        const { projectId, feedback } = req.body;
        if (!projectId || !feedback) {
            return res.status(400).json({ error: "Missing projectId or feedback" });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        const currentBlueprint = projectData.data?.stage6_scenes;
        if (!currentBlueprint) {
            return res.status(400).json({ error: "No current Stage 6 blueprint found to revise" });
        }

        console.log("Revising Stage 6 Scene Blueprint...");
        const { result: updatedBlueprint, usage } = await reviseStage6Scenes(currentBlueprint, feedback, getModelConfig(6));

        projectData.data = projectData.data || {};
        projectData.data.stage6_scenes = updatedBlueprint;
        stampRevised(projectData, 'stage6_scenes');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, usage);

        res.json({ result: updatedBlueprint });
    } catch (error) {
        console.error('Stage 6 Revision Error:', error.message);
        res.status(500).json({ error: error.message || "Failed to revise scene blueprint" });
    }
});

app.post('/api/generate-draft', async (req, res) => {
    try {
        const { projectId, sceneNumber } = req.body;
        if (!projectId || sceneNumber === undefined) {
            return res.status(400).json({ error: "Missing projectId or sceneNumber" });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        if (!projectData.data || !projectData.data.stage6_scenes) {
            return res.status(400).json({ error: "Stage 6 Scene Blueprint not found" });
        }

        // Find the scene in the sequences
        let targetedScene = null;
        for (const sequence of projectData.data.stage6_scenes) {
            const scene = sequence.scenes.find(s => s.scene_number === parseInt(sceneNumber));
            if (scene) {
                targetedScene = scene;
                break;
            }
        }

        if (!targetedScene) {
            return res.status(404).json({ error: `Scene ${sceneNumber} not found in blueprint` });
        }

        const missingFields = ['scene_heading', 'narrative_action', 'dramaturgical_function'].filter(f => !targetedScene[f]);
        if (missingFields.length > 0) {
            return res.status(400).json({ error: `Scene ${sceneNumber} is missing required fields: ${missingFields.join(', ')}` });
        }

        const projectContext = {
            synopsis: projectData.data.stage1_pitch?.pitch?.synopsis || "",
            characters: projectData.data.stage3_characters?.characters || []
        };

        const { styleContent, styleWarning } = await loadProjectStyle(projectData);
        console.log(`Generating draft for Scene ${sceneNumber}...`);
        const { result: draftText, usage: draftUsage } = await generateSceneDraft(targetedScene, projectContext, null, getModelConfig(7), styleContent);

        console.log(`Humanizing draft for Scene ${sceneNumber}...`);
        const { result: humanizedText, usage: humanizeUsage } = await humanizeDraft(draftText);

        // Save both the raw draft and the humanized version
        targetedScene.draft_text = draftText;
        targetedScene.humanized_draft_text = humanizedText;

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, [draftUsage, humanizeUsage].filter(Boolean));

        res.json({ result: humanizedText, ...(styleWarning && { styleWarning }) });
    } catch (error) {
        console.error('Stage 8 Draft Generation Error:', error.message);
        res.status(500).json({ error: error.message || "Failed to generate scene draft" });
    }
});

app.post('/api/revise-draft', async (req, res) => {
    try {
        const { projectId, sceneNumber, feedback } = req.body;
        if (!projectId || sceneNumber === undefined || !feedback) {
            return res.status(400).json({ error: "Missing projectId, sceneNumber, or feedback" });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        if (!projectData.data?.stage6_scenes) {
            return res.status(400).json({ error: "Stage 6 Scene Blueprint not found" });
        }

        let targetedScene = null;
        for (const sequence of projectData.data.stage6_scenes) {
            const scene = sequence.scenes.find(s => s.scene_number === parseInt(sceneNumber));
            if (scene) { targetedScene = scene; break; }
        }

        if (!targetedScene) {
            return res.status(404).json({ error: `Scene ${sceneNumber} not found in blueprint` });
        }

        const missingFields = ['scene_heading', 'narrative_action', 'dramaturgical_function'].filter(f => !targetedScene[f]);
        if (missingFields.length > 0) {
            return res.status(400).json({ error: `Scene ${sceneNumber} is missing required fields: ${missingFields.join(', ')}` });
        }

        const projectContext = {
            synopsis: projectData.data.stage1_pitch?.pitch?.synopsis || "",
            characters: projectData.data.stage3_characters?.characters || []
        };

        const { styleContent, styleWarning } = await loadProjectStyle(projectData);
        console.log(`Revising draft for Scene ${sceneNumber}...`);
        const { result: draftText, usage: draftUsage } = await generateSceneDraft(targetedScene, projectContext, feedback, getModelConfig(7), styleContent);

        console.log(`Humanizing revised draft for Scene ${sceneNumber}...`);
        const { result: humanizedText, usage: humanizeUsage } = await humanizeDraft(draftText);

        targetedScene.draft_text = draftText;
        targetedScene.humanized_draft_text = humanizedText;
        targetedScene.locked = false; // Unlock scene after revision

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, [draftUsage, humanizeUsage].filter(Boolean));

        res.json({ result: humanizedText, ...(styleWarning && { styleWarning }) });
    } catch (error) {
        console.error('Stage 8 Draft Revision Error:', error.message);
        res.status(500).json({ error: error.message || "Failed to revise scene draft" });
    }
});

// --- Stage 9: Coverage --- //

app.post('/api/generate-coverage', async (req, res) => {
    try {
        const { projectId, source } = req.body;
        if (!projectId) return res.status(400).json({ error: "Missing projectId" });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        if (!projectData.data?.stage7_approved) {
            return res.status(400).json({ error: "Stage 8 Draft must be approved before generating coverage" });
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
                return res.status(400).json({ error: "No scene blueprint found" });
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
            return res.status(400).json({ error: "No draft text found in scenes. Generate scene drafts first." });
        }

        const pitch = projectData.data?.stage1_pitch?.pitch;
        const projectContext = {
            title:    pitch?.title || projectData.title || 'Untitled',
            genre:    pitch?.genre || '',
            logline:  pitch?.logline || '',
            synopsis: pitch?.synopsis || '',
            characters: projectData.data?.stage3_characters?.characters || []
        };

        console.log(`Generating Stage 8 Coverage for project ${projectId}...`);
        const { result: coverageResult, usageList } = await agent8Coverage(fullScriptText, projectContext, getModelConfig(8));

        projectData.data = projectData.data || {};
        projectData.data.stage8_coverage = coverageResult;
        stampGenerated(projectData, 'stage8_coverage');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, usageList);

        res.json({ result: coverageResult });
    } catch (error) {
        console.error('Stage 8 Coverage Error:', error.message);
        res.status(500).json({ error: error.message || "Failed to generate coverage" });
    }
});

// --- Stage 10: Rewrite Routes --- //

// Initialize stage9_rewrites from Stage 8 humanized text
app.post('/api/init-stage9', async (req, res) => {
    try {
        const { projectId, reset } = req.body;
        if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

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
            projectData.data.stage9_rewrites.priority_idx = 0;
            projectData.data.stage9_rewrites.approved = false;
            await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
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
        projectData.data.stage9_rewrites = stage9;
        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

        res.json({
            stage9_rewrites: stage9,
            macro_todo: projectData.data.stage8_coverage?.macro_todo || [],
            micro_todo:  projectData.data.stage8_coverage?.micro_todo  || [],
        });
    } catch (error) {
        console.error('init-stage9 error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// General-purpose brainstorm: stages 1–7 chat assistant
app.post('/api/brainstorm', async (req, res) => {
    try {
        const { projectId, stageId, messages = [], sceneNumber, attachment } = req.body;
        if (!projectId || !stageId) return res.status(400).json({ error: 'Missing projectId or stageId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        const stageNames = {
            1: 'Pitch Generation', 2: 'Outline', 3: 'Characters',
            4: 'Beats', 5: 'Treatment', 6: 'Scene Blueprint',
            7: 'Style', 8: 'Draft', 9: 'Coverage', 10: 'Rewrite'
        };

        let stageData;
        switch (stageId) {
            case 1: stageData = JSON.stringify(projectData.data?.stage1_pitch?.pitch || {}, null, 2); break;
            case 2: stageData = JSON.stringify(projectData.data?.stage2_outline?.outline || [], null, 2); break;
            case 3: stageData = JSON.stringify(projectData.data?.stage3_characters?.characters || [], null, 2); break;
            case 4: stageData = JSON.stringify(projectData.data?.stage4_beats || [], null, 2); break;
            case 5: {
                const t = projectData.data?.stage5_treatment || {};
                stageData = [t.act_1, t.act_2a, t.act_2b, t.act_3].filter(Boolean).join('\n\n---\n\n');
                break;
            }
            case 6: stageData = JSON.stringify(projectData.data?.stage6_scenes || [], null, 2); break;
            case 7: {
                // Style stage — provide current style file content if one exists
                const styleSlug = projectData.data?.stage7_style;
                if (styleSlug) {
                    try {
                        const styleContent = require('fs').readFileSync(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf8');
                        stageData = `Current style file (${styleSlug}):\n${styleContent}`;
                    } catch { stageData = 'No style file loaded yet.'; }
                } else {
                    stageData = 'No style selected yet. Help the writer define their style.';
                }
                // Include scene summaries for context-aware suggestions
                const s6 = projectData.data?.stage6_scenes || [];
                if (s6.length > 0) {
                    const sceneSummaries = [];
                    for (const seq of s6) {
                        if (seq.scenes) for (const sc of seq.scenes) {
                            sceneSummaries.push(`Scene ${sc.scene_number}: ${sc.scene_heading || sc.slugline || ''} — ${sc.narrative_action || ''}`);
                        }
                    }
                    if (sceneSummaries.length) stageData += `\n\nStory scenes for context:\n${sceneSummaries.join('\n')}`;
                }
                break;
            }
            case 8: {
                // Draft stage — load scene text for chat context
                const draftScenes = [];
                for (const seq of (projectData.data?.stage6_scenes || [])) {
                    if (seq.scenes) draftScenes.push(...seq.scenes);
                }
                const draftScene = draftScenes.find(s => s.scene_number === sceneNumber) || draftScenes[0];
                stageData = draftScene
                    ? `Scene ${draftScene.scene_number}: ${draftScene.scene_heading || draftScene.slugline || ''}\n${draftScene.humanized_draft_text || draftScene.draft_text || ''}`
                    : 'No scene selected.';
                break;
            }
            default: return res.status(400).json({ error: `Unknown stageId: ${stageId}` });
        }

        // Build prior-stage conversation context
        const savedConversations = projectData.data?.conversations || {};
        const priorStageNames = { 1: 'Pitch', 2: 'Outline', 3: 'Characters', 4: 'Beats', 5: 'Treatment', 6: 'Scene Blueprint', 7: 'Style', 8: 'Draft', 9: 'Coverage', 10: 'Rewrite' };
        let priorContext = '';
        for (let s = 1; s < stageId; s++) {
            const prior = savedConversations[`stage${s}`];
            if (prior?.length) {
                priorContext += `\n--- Stage ${s} (${priorStageNames[s]}) Conversations ---\n`;
                for (const m of prior.slice(-20)) {
                    priorContext += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}\n`;
                }
            }
        }

        let conversationPrompt = `## PROJECT: ${title}\n\n## STAGE ${stageId} — ${stageNames[stageId]}\n${stageData}\n\n---\n\n`;
        if (priorContext) conversationPrompt += `## PREVIOUS STAGE CONVERSATIONS\n${priorContext}\n---\n\n`;
        if (attachment) {
            const fileText = await extractAttachmentText(attachment);
            if (fileText?.trim()) conversationPrompt += `## ATTACHED FILE: ${attachment.name}\n${fileText.trim()}\n\n---\n\n`;
        }
        for (const msg of messages) {
            conversationPrompt += `${msg.role === 'user' ? 'WRITER' : 'YOU'}: ${msg.content}\n\n`;
        }
        conversationPrompt += 'Continue the conversation as the editorial assistant.';

        const brainstormSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_brainstorm.md'), 'utf8');
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: conversationPrompt,
            config: {
                systemInstruction: brainstormSop,
                temperature: 0.7,
                responseMimeType: 'application/json',
                responseSchema: { type: 'object', properties: { message: { type: 'string' }, suggest_plan: { type: 'boolean' }, execute_immediately: { type: 'boolean' } }, required: ['message', 'suggest_plan', 'execute_immediately'] },
            },
        });
        const result = JSON.parse(response.text);
        console.log(`Brainstorm stage${stageId}: suggest_plan=${result.suggest_plan} execute_immediately=${result.execute_immediately}`);
        const brainstormUsage = {
            model: 'gemini-3-flash-preview',
            inputTokens: response.usageMetadata?.promptTokenCount || 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        };
        trackUsage(projectId, brainstormUsage);

        // Persist the full conversation (current session + new exchange) to project file
        try {
            const stageKey = `stage${stageId}`;
            const convos = projectData.data.conversations || {};
            convos[stageKey] = [...messages, { role: 'assistant', content: result.message }];
            projectData.data.conversations = convos;
            await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        } catch (saveErr) {
            console.error('Failed to persist conversation:', saveErr.message);
        }

        res.json(result);
    } catch (error) {
        console.error('brainstorm error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Conversational brainstorm: editorial assistant helps writer clarify rewrite direction
app.post('/api/brainstorm-rewrite', async (req, res) => {
    try {
        const { projectId, messages = [], isInit = false, attachment } = req.body;
        if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';
        const coverage = projectData.data?.stage8_coverage;
        const macroTodo = coverage?.macro_todo || [];
        const microTodo = coverage?.micro_todo || [];
        const priorityIdx = projectData.data?.stage9_rewrites?.priority_idx ?? 0;

        const stage6Scenes = projectData.data?.stage6_scenes || [];
        const allScenes = [];
        for (const seq of stage6Scenes) { if (seq.scenes) allScenes.push(...seq.scenes); }
        allScenes.sort((a, b) => a.scene_number - b.scene_number);
        const working = projectData.data?.stage9_rewrites?.working || {};
        const fullScript = allScenes
            .map(s => `## SCENE ${s.scene_number} — ${s.scene_heading || s.slugline || ''}\n${working[s.scene_number] || s.humanized_draft_text || s.draft_text || ''}`)
            .join('\n\n---\n\n');

        const allPriorities = [
            ...macroTodo.map((t, i) => ({ label: `MACRO TO-DO P${i + 1}`, task: t.task || t, done: i < priorityIdx })),
            ...microTodo.map((t, i) => ({ label: `MICRO TO-DO P${i + 1}`, task: t.task || t, done: (macroTodo.length + i) < priorityIdx })),
        ];
        const priorityList = allPriorities.map(p => `${p.done ? '[DONE]' : '[OPEN]'} ${p.label}: ${p.task}`).join('\n');
        const characters = projectData.data?.stage3_characters?.characters || [];
        const charSummary = characters.length > 0
            ? characters.map(c => `${c.name} (${c.role}): ${c.brief_summary || ''}`).join('\n')
            : '';
        const charBlock = charSummary ? `\n\n## CHARACTERS\n${charSummary}` : '';
        const contextBlock = `## PROJECT: ${title}${charBlock}\n\n## STAGE 9 PRIORITIES\n${priorityList}\n\n## FULL SCREENPLAY (current working draft)\n${fullScript}`;

        // Build conversation as a single prompt string
        let conversationPrompt = contextBlock + '\n\n---\n\n';
        if (attachment && !isInit) {
            const fileText = await extractAttachmentText(attachment);
            if (fileText?.trim()) conversationPrompt += `## ATTACHED FILE: ${attachment.name}\n${fileText.trim()}\n\n---\n\n`;
        }
        if (isInit) {
            // Check for character change context (from Stage 3 re-approval → Stage 10 flow)
            const charChangeCtx = projectData.data?.characterChangeContext;
            if (charChangeCtx) {
                conversationPrompt += `[The writer just updated character profiles in Stage 3 and chose to send the changes directly to the rewrite stage. Here are the specific changes:\n${charChangeCtx}\n\nAcknowledge these character changes, briefly explain how they might affect the current draft (which scenes/moments would be most impacted), and ask if the writer wants to generate a rewrite plan focused on implementing these character updates across the screenplay. Keep it conversational and concise.]`;
                // Clear the flag so it doesn't re-trigger
                delete projectData.data.characterChangeContext;
                await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
            } else {
            const doneCount = allPriorities.filter(p => p.done).length;
            if (doneCount > 0) {
                const nextPriority = allPriorities.find(p => !p.done);
                conversationPrompt += `[The writer just completed ${doneCount} of ${allPriorities.length} rewrite priorities and approved the changes. ${nextPriority ? `The next priority is: ${nextPriority.label}: ${nextPriority.task}. Briefly acknowledge progress (mention the count, e.g. "${doneCount} of ${allPriorities.length} done"), then present the next priority using its exact label and task text. Move straight into discussing what this priority involves and which scenes are likely affected. Do NOT re-list all priorities.` : 'All priorities have been addressed.'}]`;
            } else {
                conversationPrompt += '[The writer has just entered the rewrite stage. Present the coverage priorities EXACTLY as listed below — use the same labels (MACRO TO-DO P1, P2... and MICRO TO-DO P1, P2...) and the same task descriptions verbatim. Group them under MACRO TO-DO and MICRO TO-DO headings. Mark completed items as done. Then ask the writer which priority they\'d like to tackle first.]';
            }
            }
        } else {
            for (const msg of messages) {
                const label = msg.role === 'user' ? 'WRITER' : 'YOU';
                conversationPrompt += `${label}: ${msg.content}\n\n`;
            }
            conversationPrompt += 'Continue the conversation as the editorial assistant.';
        }

        const brainstormSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_brainstorm.md'), 'utf8');
        const brainstormSchema = {
            type: 'object',
            properties: {
                message: { type: 'string' },
                suggest_plan: { type: 'boolean' }
            },
            required: ['message', 'suggest_plan']
        };

        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: conversationPrompt,
            config: {
                systemInstruction: brainstormSop,
                temperature: 0.7,
                responseMimeType: 'application/json',
                responseSchema: brainstormSchema,
            },
        });

        const result = JSON.parse(response.text);
        console.log(`Brainstorm: suggest_plan=${result.suggest_plan}`);
        const brainstormUsage = {
            model: 'gemini-3-flash-preview',
            inputTokens: response.usageMetadata?.promptTokenCount || 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        };
        trackUsage(projectId, brainstormUsage);

        // Persist stage 10 conversation (data key stays stage9 — don't rename data keys)
        if (!isInit) {
            try {
                const convos = projectData.data.conversations || {};
                convos['stage9'] = [...messages, { role: 'assistant', content: result.message }];
                projectData.data.conversations = convos;
                await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
            } catch (saveErr) {
                console.error('Failed to persist rewrite conversation:', saveErr.message);
            }
        }

        res.json(result);
    } catch (error) {
        console.error('brainstorm-rewrite error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Audit scope: which scenes does this task affect?
app.post('/api/plan-rewrite', async (req, res) => {
    try {
        const { projectId, priorityTask, userFeedback, conversationContext } = req.body;
        if (!projectId || !priorityTask) return res.status(400).json({ error: 'Missing projectId or priorityTask' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        const working = projectData.data?.stage9_rewrites?.working || {};
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        const stage6Scenes = projectData.data?.stage6_scenes || [];
        const allScenes = [];
        for (const seq of stage6Scenes) { if (seq.scenes) allScenes.push(...seq.scenes); }
        allScenes.sort((a, b) => a.scene_number - b.scene_number);

        // Send scene headings only — the planner just needs to know which scenes exist
        const sceneList = allScenes
            .map(s => `SCENE ${s.scene_number} — ${s.scene_heading || s.slugline || ''}`)
            .join('\n');

        const plannerSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_stage10_planner.md'), 'utf8');
        const feedbackSection = userFeedback ? `\n\n## WRITER NOTES ON SCOPE\n${userFeedback}` : '';
        // Trim conversation context to last ~4000 chars to keep prompt manageable
        const trimmedContext = conversationContext && conversationContext.length > 4000
            ? '...\n' + conversationContext.slice(-4000)
            : conversationContext;
        const contextSection = trimmedContext ? `\n\n## BRAINSTORM CONTEXT\n${trimmedContext}` : '';
        const characters = projectData.data?.stage3_characters?.characters || [];
        const charBlock = characters.length > 0
            ? `\n\n## CHARACTERS\n${characters.map(c => `${c.name} (${c.role}): arc=${c.arc?.direction || 'unknown'}, drive=${c.arc?.core_drive || 'unknown'}`).join('\n')}`
            : '';
        const { styleContent: plannerStyleContent } = await loadProjectStyle(projectData);
        const styleNote = plannerStyleContent
            ? `\n\n## STYLE CONTEXT\nThis project has a writing style set. The rewrite agent will maintain this style during execution. Do not treat the style itself as a problem to fix — it is an intentional choice. Only flag style-related issues if the rewrite task explicitly raises them.`
            : '';
        const prompt = `## PROJECT\nTitle: ${title}${charBlock}${styleNote}\n\n## REWRITE TASK\n${priorityTask}${feedbackSection}${contextSection}\n\n## SCENE LIST\n${sceneList}`;

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

        const { generateContent } = require('./agents/ai-client');
        const modelCfg = getModelConfig(9);
        console.log(`plan-rewrite: model=${modelCfg.model}, prompt=${prompt.length} chars, context=${(trimmedContext||'').length} chars`);

        const t0 = Date.now();
        const response = await generateContent({
            model: modelCfg.model,
            geminiApiKey: modelCfg.geminiApiKey,
            anthropicApiKey: modelCfg.anthropicApiKey,
            contents: prompt,
            config: {
                systemInstruction: plannerSop,
                temperature: 0.2,
                responseMimeType: 'application/json',
                responseSchema: plannerSchema,
            },
        });
        console.log(`plan-rewrite succeeded in ${((Date.now()-t0)/1000).toFixed(1)}s`);

        const plan = JSON.parse(response.text);
        console.log(`Stage 10 plan: ${plan.affected_scenes.length} scenes affected.`);
        if (response.usage) trackUsage(projectId, response.usage);
        res.json(plan);
    } catch (error) {
        console.error('plan-rewrite error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Run the rewrite agent only on planned (affected) scenes
app.post('/api/rewrite-for-priority', async (req, res) => {
    try {
        const { projectId, priorityTask, affectedSceneNumbers } = req.body;
        if (!projectId || !priorityTask) return res.status(400).json({ error: 'Missing projectId or priorityTask' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

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

        const { styleContent } = await loadProjectStyle(projectData);
        console.log(`Stage 10: rewriting ${scopedScenes.length} scene(s) for task: "${priorityTask.slice(0, 60)}..."`);

        const results = await Promise.allSettled(
            scopedScenes.map(s => {
                const sceneText = working[s.scene_number] || s.humanized_draft_text || s.draft_text || '';
                return rewriteScene(sceneText, priorityTask, {
                    title,
                    sceneNumber: s.scene_number,
                    slugline: s.slugline || s.scene_heading || '',
                }, '', getModelConfig(9), styleContent).then(({ result: proposed, usage }) => ({ scene_number: s.scene_number, original_text: sceneText, proposed_text: proposed, usage }));
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
        trackUsage(projectId, usages);

        res.json({ scenes });
    } catch (error) {
        console.error('rewrite-for-priority error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Rewrite a single scene for a planned priority task
app.post('/api/rewrite-single-scene', async (req, res) => {
    try {
        const { projectId, sceneNumber, priorityTask, plannedChange } = req.body;
        if (!projectId || !sceneNumber || !priorityTask) {
            return res.status(400).json({ error: 'Missing projectId, sceneNumber, or priorityTask' });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        const working = projectData.data?.stage9_rewrites?.working || {};
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        // Find scene metadata from stage 6
        const stage6Scenes = projectData.data?.stage6_scenes || [];
        let sceneMeta = null;
        for (const seq of stage6Scenes) {
            if (seq.scenes) {
                sceneMeta = seq.scenes.find(s => s.scene_number === sceneNumber);
                if (sceneMeta) break;
            }
        }

        const sceneText = working[sceneNumber] || sceneMeta?.humanized_draft_text || sceneMeta?.draft_text || '';
        const slugline = sceneMeta?.slugline || sceneMeta?.scene_heading || '';

        // Short-circuit: if the plan says to delete/remove/omit this scene, skip the LLM
        const deletionPattern = /\b(delete|remove|omit|cut|eliminate)\b.*\b(scene|entirely|completely)\b/i;
        if (plannedChange && deletionPattern.test(plannedChange)) {
            console.log(`Stage 10: deleting scene ${sceneNumber} (per plan)`);
            // Persist deletion to disk immediately
            const stage9 = projectData.data.stage9_rewrites || {};
            stage9.pending = stage9.pending || {};
            stage9.pending[sceneNumber] = '';
            await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
            return res.json({ scene_number: sceneNumber, original_text: sceneText, proposed_text: '', modified: true });
        }

        const { styleContent } = await loadProjectStyle(projectData);
        console.log(`Stage 10: rewriting scene ${sceneNumber} for task: "${priorityTask.slice(0, 60)}..."`);

        // Build character context for this scene
        const characters = projectData.data?.stage3_characters?.characters || [];
        const charProfiles = characters.length > 0
            ? characters.map(c => {
                const dp = c._deep_profile || {};
                return `${c.name} (${c.role}): voice=${c.voice_and_behavior?.voice_tag || 'unknown'}, pressure=${c.voice_and_behavior?.pressure_tag || 'unknown'}${dp.dialogue_fingerprint ? `\nDialogue rules: ${dp.dialogue_fingerprint}` : ''}`;
            }).join('\n\n')
            : '';

        const { result: proposed, usage } = await rewriteScene(
            sceneText, priorityTask,
            { title, sceneNumber, slugline, characters: charProfiles },
            plannedChange || '',
            getModelConfig(9),
            styleContent
        );

        const modified = proposed.trim() !== sceneText.trim();

        // Persist pending rewrite to disk immediately so it survives page refresh
        if (modified) {
            const stage9 = projectData.data.stage9_rewrites || {};
            stage9.pending = stage9.pending || {};
            stage9.pending[sceneNumber] = proposed;
            await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        }

        trackUsage(projectId, usage);
        res.json({ scene_number: sceneNumber, original_text: sceneText, proposed_text: proposed, modified });
    } catch (error) {
        console.error('rewrite-single-scene error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Save approved pending changes and advance priority index
app.post('/api/approve-rewrite-priority', async (req, res) => {
    try {
        const { projectId, pendingScenes, newPriorityIdx } = req.body;
        if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        const stage9 = projectData.data?.stage9_rewrites || { working: {}, priority_idx: 0, approved: false };
        if (pendingScenes) {
            for (const [sceneNum, text] of Object.entries(pendingScenes)) {
                stage9.working[sceneNum] = text;
            }
        }
        stage9.pending = {};  // Clear pending — now merged into working
        stage9.priority_idx = newPriorityIdx;
        projectData.data.stage9_rewrites = stage9;
        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

        res.json({ stage9_rewrites: stage9 });
    } catch (error) {
        console.error('approve-rewrite-priority error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Rewrite a single scene using the priority task + user feedback
app.post('/api/rewrite-scene-feedback', async (req, res) => {
    try {
        const { projectId, sceneNumber, priorityTask, userFeedback, currentText } = req.body;
        if (!projectId || !priorityTask || !currentText) return res.status(400).json({ error: 'Missing required fields' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        const { result: proposed_text, usage } = await rewriteScene(currentText, priorityTask, { title, sceneNumber }, userFeedback, getModelConfig(9));
        trackUsage(projectId, usage);
        res.json({ proposed_text });
    } catch (error) {
        console.error('rewrite-scene-feedback error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Mark Stage 10 as approved/finalized
app.post('/api/finalize-stage10', async (req, res) => {
    try {
        const { projectId } = req.body;
        if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        if (projectData.data?.stage9_rewrites) {
            projectData.data.stage9_rewrites.approved = true;
        }
        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        res.json({ success: true });
    } catch (error) {
        console.error('finalize-stage10 error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- Stage 7: Style Routes --- //

// Generate a style skill file from chat/form input
app.post('/api/generate-stage7-style', upload.array('sampleFiles', 5), async (req, res) => {
    try {
        const { projectId, mode, description, formData: formDataRaw, conversationHistory: convRaw } = req.body;
        if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        const formData = formDataRaw ? (typeof formDataRaw === 'string' ? JSON.parse(formDataRaw) : formDataRaw) : null;
        const conversationHistory = convRaw ? (typeof convRaw === 'string' ? JSON.parse(convRaw) : convRaw) : [];

        // Extract text from uploaded sample files
        const sampleTexts = [];
        if (req.files?.length) {
            for (const file of req.files) {
                const ext = (file.originalname || '').split('.').pop().toLowerCase();
                if (ext === 'pdf') {
                    const pdfParse = require('pdf-parse');
                    const parsed = await pdfParse(file.buffer);
                    sampleTexts.push(parsed.text);
                } else {
                    sampleTexts.push(file.buffer.toString('utf-8'));
                }
            }
        }

        // Build scene summaries for context
        let sceneSummaries = '';
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

        console.log(`Generating Stage 7 Style for project ${projectId} (mode: ${mode || 'chat'})...`);
        const { result: styleContent, usage } = await generateStyleFile({
            description: description || '',
            formData,
            sampleTexts,
            sceneSummaries,
            conversationHistory
        }, getModelConfig(7));

        // Parse the generated style to extract metadata
        const { meta } = parseStyleFile(styleContent);
        const slug = (meta.name || formData?.name || 'custom-style')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        // Save style file
        await fs.writeFile(path.join(STYLES_DIR, `${slug}.md`), styleContent);

        // Update project
        projectData.data = projectData.data || {};
        projectData.data.stage7_style = slug;
        stampGenerated(projectData, 'stage7_style');
        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));
        trackUsage(projectId, usage);

        res.json({ slug, content: styleContent, meta });
    } catch (error) {
        console.error('generate-stage7-style error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Preview a scene drafted in a specific style
app.post('/api/preview-style-scene', async (req, res) => {
    try {
        const { projectId, styleSlug, sceneIndex = 0 } = req.body;
        if (!projectId || !styleSlug) return res.status(400).json({ error: 'Missing projectId or styleSlug' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        // Load style file
        let styleContent;
        try {
            styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf-8');
        } catch {
            return res.status(404).json({ error: `Style "${styleSlug}" not found` });
        }

        // Get the target scene
        const allScenes = [];
        for (const seq of (projectData.data?.stage6_scenes || [])) {
            if (seq.scenes) allScenes.push(...seq.scenes);
        }
        allScenes.sort((a, b) => a.scene_number - b.scene_number);
        const scene = allScenes[sceneIndex] || allScenes[0];
        if (!scene) return res.status(400).json({ error: 'No scenes found in project' });

        const pitch = projectData.data?.stage1_pitch?.pitch;
        const projectContext = {
            synopsis: pitch?.synopsis || '',
            characters: projectData.data?.stage3_characters?.characters || []
        };

        // Use the Draft agent with style directives injected
        const draftSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_stage8_draft.md'), 'utf8');
        const prompt = `${draftSop}

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

        const { generateContent } = require('./agents/ai-client');
        const mc = getModelConfig(7);
        const response = await generateContent({
            model: mc.model, geminiApiKey: mc.geminiApiKey, anthropicApiKey: mc.anthropicApiKey,
            contents: prompt,
            config: { temperature: 0.7 }
        });

        trackUsage(projectId, response.usage);
        res.json({ sceneNumber: scene.scene_number, previewText: response.text });
    } catch (error) {
        console.error('preview-style-scene error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// List all available styles
app.get('/api/styles', async (req, res) => {
    try {
        let files;
        try { files = await fs.readdir(STYLES_DIR); } catch { files = []; }
        const styles = [];
        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const slug = file.replace(/\.md$/, '');
            try {
                const raw = await fs.readFile(path.join(STYLES_DIR, file), 'utf-8');
                const { meta } = parseStyleFile(raw);
                styles.push({ slug, name: meta.name || slug, tonal_summary: meta.tonal_summary || '', references: meta.references || [], created: meta.created || '' });
            } catch {
                styles.push({ slug, name: slug, tonal_summary: '', references: [], created: '' });
            }
        }
        res.json({ styles });
    } catch (error) {
        console.error('list styles error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Select an existing style for a project
app.post('/api/select-style', async (req, res) => {
    try {
        const { projectId, styleSlug } = req.body;
        if (!projectId || !styleSlug) return res.status(400).json({ error: 'Missing projectId or styleSlug' });

        // Verify style exists
        try {
            await fs.access(path.join(STYLES_DIR, `${styleSlug}.md`));
        } catch {
            return res.status(404).json({ error: `Style "${styleSlug}" not found` });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        projectData.data = projectData.data || {};
        projectData.data.stage7_style = styleSlug;
        stampGenerated(projectData, 'stage7_style');
        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

        // Load and return the style content
        const styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf-8');
        const { meta } = parseStyleFile(styleContent);
        res.json({ slug: styleSlug, content: styleContent, meta });
    } catch (error) {
        console.error('select-style error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- Settings Routes --- //

app.get('/api/settings', (req, res) => {
    res.json({
        geminiApiKey: appSettings.geminiApiKey ? '***' : '',
        anthropicApiKey: appSettings.anthropicApiKey ? '***' : '',
        stageModels: appSettings.stageModels || {}
    });
});

app.post('/api/settings', async (req, res) => {
    try {
        const { geminiApiKey, anthropicApiKey, stageModels } = req.body;
        // Only update keys that were actually changed (don't overwrite with masked placeholder)
        if (geminiApiKey && geminiApiKey !== '***') appSettings.geminiApiKey = geminiApiKey;
        if (anthropicApiKey && anthropicApiKey !== '***') appSettings.anthropicApiKey = anthropicApiKey;
        if (stageModels) appSettings.stageModels = stageModels;

        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
        await fs.writeFile(SETTINGS_PATH, JSON.stringify(appSettings, null, 2));
        res.json({ ok: true });
    } catch (err) {
        console.error('Failed to save settings:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Project Management Routes --- //

// GET all projects
app.get('/api/projects', async (req, res) => {
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
        res.status(500).json({ error: "Failed to load projects" });
    }
});

// GET single project
app.get('/api/projects/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const filePath = path.join(DATA_DIR, `${id}.json`);

        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: "Project not found" });
        }

        const content = await fs.readFile(filePath, 'utf-8');
        res.json(JSON.parse(content));
    } catch (error) {
        console.error("Error reading project:", error);
        res.status(500).json({ error: "Failed to load project details" });
    }
});

// POST new project
app.post('/api/projects', async (req, res) => {
    try {
        const id = Date.now().toString();
        const newProject = {
            id,
            title: "New Project",
            data: {}
        };

        const filePath = path.join(DATA_DIR, `${id}.json`);
        await fs.writeFile(filePath, JSON.stringify(newProject, null, 2));

        res.status(201).json(newProject);
    } catch (error) {
        console.error("Error creating project:", error);
        res.status(500).json({ error: "Failed to create project" });
    }
});

// POST import script → create project with Stage 6/7 pre-populated
app.post('/api/import-script', upload.single('scriptFile'), async (req, res) => {
    try {
        const { parseFountain, parseFdx, parsePdfScript, buildStage6FromScenes } = require('./utils/script-import');
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

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
            return res.status(400).json({ error: `Unsupported file type: .${ext}. Use .fountain, .fdx, or .pdf` });
        }

        if (!parsed.scenes || parsed.scenes.length === 0) {
            return res.status(400).json({ error: 'No scenes found in the uploaded file' });
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
        await fs.writeFile(filePath, JSON.stringify(newProject, null, 2));

        console.log(`Imported script "${title}": ${parsed.scenes.length} scenes, ${stage6Scenes.length} sequences`);
        res.status(201).json({ projectId: id, title, sceneCount: parsed.scenes.length, sequenceCount: stage6Scenes.length });
    } catch (error) {
        console.error('Import script error:', error);
        res.status(500).json({ error: error.message || 'Failed to import script' });
    }
});

// PUT update project
app.put('/api/projects/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const filePath = path.join(DATA_DIR, `${id}.json`);

        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: "Project not found" });
        }

        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        // Ensure nested .data is merged properly rather than completely overwritten
        let mergedData = projectData.data || {};
        if (updates.data) {
            mergedData = { ...mergedData, ...updates.data };
        }

        const updatedProject = { ...projectData, ...updates, data: mergedData };

        // If the client signals a stage was revised, stamp staleness on downstream stages
        if (updates.stampRevisedStage) {
            stampRevised(updatedProject, updates.stampRevisedStage);
            delete updatedProject.stampRevisedStage; // Don't persist the flag itself
        }

        await fs.writeFile(filePath, JSON.stringify(updatedProject, null, 2));

        res.json(updatedProject);
    } catch (error) {
        console.error("Error updating project:", error);
        res.status(500).json({ error: "Failed to update project" });
    }
});

// DELETE project
app.delete('/api/projects/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const filePath = path.join(DATA_DIR, `${id}.json`);

        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: "Project not found" });
        }

        await fs.unlink(filePath);
        res.json({ success: true });
    } catch (error) {
        console.error("Error deleting project:", error);
        res.status(500).json({ error: "Failed to delete project" });
    }
});

// ─── Export Endpoints ─────────────────────────────────────────────────────────

async function loadProjectData(projectId) {
    const filePath = path.join(DATA_DIR, `${projectId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
}

// GET /api/export/docx/:projectId?stage=outline|characters|treatment|draft|coverage
app.get('/api/export/docx/:projectId', async (req, res) => {
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
            if (!pitch) return res.status(400).json({ error: 'No pitch data found' });
            buf = await generatePitchDocx(pitch);
            filename = `${safeName}_pitch.docx`;

        } else if (stage === 'coverage') {
            if (!data.stage8_coverage) return res.status(400).json({ error: 'No coverage data found' });
            buf = await generateCoverageDocx(data.stage8_coverage);
            filename = `${safeName}_coverage.docx`;

        } else if (stage === 'outline') {
            const outline = data.stage2_outline?.outline;
            if (!outline) return res.status(400).json({ error: 'No outline data found' });
            buf = await generateOutlineDocx(outline, title);
            filename = `${safeName}_outline.docx`;

        } else if (stage === 'characters') {
            const chars = data.stage3_characters?.characters;
            if (!chars || !chars.length) return res.status(400).json({ error: 'No character data found' });
            buf = await generateCharactersDocx(chars, title);
            filename = `${safeName}_characters.docx`;

        } else if (stage === 'treatment') {
            if (!data.stage5_treatment) return res.status(400).json({ error: 'No treatment data found' });
            buf = await generateTreatmentDocx(data.stage5_treatment, title);
            filename = `${safeName}_treatment.docx`;

        } else if (stage === 'beats') {
            const beats = data.stage4_beats || data.stage4_treatment;
            if (!beats?.hybrid_beat_sheet) return res.status(400).json({ error: 'No beat sheet data found' });
            buf = await generateBeatsDocx(beats, title);
            filename = `${safeName}_beats.docx`;

        } else if (stage === 'scenes') {
            const seqs = data.stage6_scenes;
            if (!seqs || !seqs.length) return res.status(400).json({ error: 'No scene blueprint data found' });
            const sequences = Array.isArray(seqs) ? seqs : (seqs.sequences || []);
            buf = await generateScenesDocx(sequences, title);
            filename = `${safeName}_scene_blueprint.docx`;

        } else if (stage === 'draft') {
            const scenes = (data.stage6_scenes || []).flatMap(seq => seq.scenes || []);
            const drafted = scenes.filter(s => s.draft_text || s.humanized_draft_text);
            if (!drafted.length) return res.status(400).json({ error: 'No drafted scenes found' });
            buf = await generateDraftDocx(drafted, title);
            filename = `${safeName}_draft.docx`;

        } else if (stage === 'rewrite') {
            const working = data.stage9_rewrites?.working;
            if (!working) return res.status(400).json({ error: 'No rewrite data found' });
            // Convert working object to scene-like array for draft export
            const fakescenes = Object.entries(working).map(([, txt]) => ({ humanized_draft_text: txt }));
            buf = await generateDraftDocx(fakescenes, title);
            filename = `${safeName}_rewrite.docx`;

        } else {
            return res.status(400).json({ error: `Unknown stage: ${stage}` });
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
    } catch (err) {
        console.error('DOCX export error:', err);
        res.status(500).json({ error: err.message || 'Export failed' });
    }
});

// GET /api/export/pdf/:projectId?stage=draft|rewrite
app.get('/api/export/pdf/:projectId', async (req, res) => {
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
            if (!working) return res.status(400).json({ error: 'No rewrite data found' });
            scenes = Object.entries(working)
                .sort(([a], [b]) => Number(a) - Number(b))
                .filter(([, txt]) => txt && txt.trim() !== '[SCENE DELETED]')
                .map(([, txt]) => ({ humanized_draft_text: txt }));
        } else {
            scenes = (data.stage6_scenes || []).flatMap(seq => seq.scenes || []);
            scenes = scenes.filter(s => s.draft_text || s.humanized_draft_text);
        }

        if (!scenes.length) return res.status(400).json({ error: 'No scenes to export' });

        const buf = await generateScreenplayPdf(scenes, title);
        const filename = `${safeName}_${stage}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
    } catch (err) {
        console.error('PDF export error:', err);
        res.status(500).json({ error: err.message || 'Export failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
