require('dotenv').config();
const express = require('express');
const fs = require('fs/promises');
const path = require('path');

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
// ─────────────────────────────────────────────────────────────────────────────

const { agent1Pitch } = require('./agents/agent_1_pitch');
const { agent1Refine } = require('./agents/agent_1_refine');
const { agent2Outline } = require('./agents/agent_2_outline');
const { agent3Characters } = require('./agents/agent_3_characters');
const { agent4Beats } = require('./agents/agent_4_beats');
const { agent5Treatment } = require('./agents/agent_5_treatment');
const { generateStage6Scenes } = require('./agents/agent_6_scenes');
const { reviseStage6Scenes } = require('./agents/agent_6_revise');
const { generateSceneDraft } = require('./agents/agent_7_draft');
const { humanizeDraft } = require('./agents/agent_humanizer');
const { agent8Coverage } = require('./agents/agent_8_coverage');
const { rewriteScene } = require('./agents/agent_9_rewrite');
const { stampGenerated, stampRevised, buildSourceAuthorityBlock } = require('./utils/stageMetadata');

const app = express();
const PORT = process.env.PORT || 3000;

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const DATA_DIR = path.join(__dirname, 'data', 'projects');

// Initialization
async function initDb() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (err) {
        console.error("Failed to create data directory:", err);
    }
}
initDb();
loadSettings();

// Middleware
app.use(express.static('public'));
app.use(express.json());

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
        const outlineData = await agent2Outline(stage1, parsedBeats, notes, pdfFile, getModelConfig(2));

        // Save to Stage 2
        projectData.data = projectData.data || {};
        projectData.data.stage2_outline = outlineData;
        notes ? stampRevised(projectData, 'stage2_outline') : stampGenerated(projectData, 'stage2_outline');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

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
        const characterData = await agent3Characters(pitchData, beatsData, parsedChars, notes, pdfFile, getModelConfig(3));

        // Save to Stage 3
        projectData.data = projectData.data || {};
        projectData.data.stage3_characters = characterData;
        notes ? stampRevised(projectData, 'stage3_characters') : stampGenerated(projectData, 'stage3_characters');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

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
        const beatsResult = await agent4Beats(
            pitchData, beatsData, charsData, parsedCurrentBeats, notes, pdfFile,
            (label) => send({ type: 'progress', label }),
            getModelConfig(4)
        );

        console.log("Beats generated successfully. Beat sheet length:", beatsResult.hybrid_beat_sheet?.length || 0);

        projectData.data = projectData.data || {};
        projectData.data.stage4_beats = beatsResult;
        notes ? stampRevised(projectData, 'stage4_beats') : stampGenerated(projectData, 'stage4_beats');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

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
        const result = await agent5Treatment(
            pitchData, charactersData, beatsData, parsedTreatment, notes,
            (step, total, label) => send({ type: 'progress', step, total, label }),
            getModelConfig(5)
        );

        projectData.data = projectData.data || {};
        projectData.data.stage5_treatment = result;
        notes ? stampRevised(projectData, 'stage5_treatment') : stampGenerated(projectData, 'stage5_treatment');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

        send({ type: 'complete', result });
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

        const allSequences = await generateStage6Scenes(
            pitch, characters, beats, treatment,
            (current, total) => send({ type: 'progress', current, total }),
            sourceAuthorityBlock,
            getModelConfig(6)
        );

        projectData.data = projectData.data || {};
        projectData.data.stage6_scenes = allSequences;
        stampGenerated(projectData, 'stage6_scenes');
        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

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
        const updatedBlueprint = await reviseStage6Scenes(currentBlueprint, feedback, getModelConfig(6));

        projectData.data = projectData.data || {};
        projectData.data.stage6_scenes = updatedBlueprint;
        stampRevised(projectData, 'stage6_scenes');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

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

        console.log(`Generating draft for Scene ${sceneNumber}...`);
        const draftText = await generateSceneDraft(targetedScene, projectContext, null, getModelConfig(7));

        console.log(`Humanizing draft for Scene ${sceneNumber}...`);
        const humanizedText = await humanizeDraft(draftText);

        // Save both the raw draft and the humanized version
        targetedScene.draft_text = draftText;
        targetedScene.humanized_draft_text = humanizedText;

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

        res.json({ result: humanizedText });
    } catch (error) {
        console.error('Stage 7 Draft Generation Error:', error.message);
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

        console.log(`Revising draft for Scene ${sceneNumber}...`);
        const draftText = await generateSceneDraft(targetedScene, projectContext, feedback, getModelConfig(7));

        console.log(`Humanizing revised draft for Scene ${sceneNumber}...`);
        const humanizedText = await humanizeDraft(draftText);

        targetedScene.draft_text = draftText;
        targetedScene.humanized_draft_text = humanizedText;
        targetedScene.locked = false; // Unlock scene after revision

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

        res.json({ result: humanizedText });
    } catch (error) {
        console.error('Stage 7 Draft Revision Error:', error.message);
        res.status(500).json({ error: error.message || "Failed to revise scene draft" });
    }
});

// --- Stage 8: Coverage --- //

app.post('/api/generate-coverage', async (req, res) => {
    try {
        const { projectId } = req.body;
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
            return res.status(400).json({ error: "Stage 7 must be approved before generating coverage" });
        }

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

        const fullScriptText = allScenes
            .map(s => (s.humanized_draft_text || s.draft_text || '').trim())
            .filter(Boolean)
            .join('\n\n');

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
        const coverageResult = await agent8Coverage(fullScriptText, projectContext, getModelConfig(8));

        projectData.data = projectData.data || {};
        projectData.data.stage8_coverage = coverageResult;
        stampGenerated(projectData, 'stage8_coverage');

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

        res.json({ result: coverageResult });
    } catch (error) {
        console.error('Stage 8 Coverage Error:', error.message);
        res.status(500).json({ error: error.message || "Failed to generate coverage" });
    }
});

// --- Stage 9: Rewrite Routes --- //

// Initialize stage9_rewrites from Stage 7 humanized text
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
        const { projectId, stageId, messages = [], sceneNumber } = req.body;
        if (!projectId || !stageId) return res.status(400).json({ error: 'Missing projectId or stageId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        const stageNames = {
            1: 'Pitch Generation', 2: 'Outline', 3: 'Characters',
            4: 'Beats', 5: 'Treatment', 6: 'Scene Blueprint', 7: 'Draft'
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
                const scenes = [];
                for (const seq of (projectData.data?.stage6_scenes || [])) {
                    if (seq.scenes) scenes.push(...seq.scenes);
                }
                const scene = scenes.find(s => s.scene_number === sceneNumber) || scenes[0];
                stageData = scene
                    ? `Scene ${scene.scene_number}: ${scene.scene_heading || scene.slugline || ''}\n${scene.humanized_draft_text || scene.draft_text || ''}`
                    : 'No scene selected.';
                break;
            }
            default: return res.status(400).json({ error: `Unknown stageId: ${stageId}` });
        }

        // Build prior-stage conversation context
        const savedConversations = projectData.data?.conversations || {};
        const priorStageNames = { 1: 'Pitch', 2: 'Outline', 3: 'Characters', 4: 'Beats', 5: 'Treatment', 6: 'Scene Blueprint', 7: 'Draft' };
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
        const { projectId, messages = [], isInit = false } = req.body;
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
            ...macroTodo.map((t, i) => ({ label: `MACRO ${i + 1}`, task: t.task || t, done: i < priorityIdx })),
            ...microTodo.map((t, i) => ({ label: `MICRO ${i + 1}`, task: t.task || t, done: (macroTodo.length + i) < priorityIdx })),
        ];
        const priorityList = allPriorities.map(p => `${p.done ? '[DONE]' : '[OPEN]'} ${p.label}: ${p.task}`).join('\n');
        const contextBlock = `## PROJECT: ${title}\n\n## STAGE 8 PRIORITIES\n${priorityList}\n\n## FULL SCREENPLAY (current working draft)\n${fullScript}`;

        // Build conversation as a single prompt string
        let conversationPrompt = contextBlock + '\n\n---\n\n';
        if (isInit) {
            conversationPrompt += '[The writer has just entered the rewrite stage. Open the conversation by presenting the priorities and asking what they would like to address.]';
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

        // Persist stage 9 conversation
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

        const fullScript = allScenes
            .map(s => `## SCENE ${s.scene_number} — ${s.scene_heading || s.slugline || ''}\n${working[s.scene_number] || s.humanized_draft_text || s.draft_text || ''}`)
            .join('\n\n---\n\n');

        const plannerSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_stage9_planner.md'), 'utf8');
        const feedbackSection = userFeedback ? `\n\n## WRITER NOTES ON SCOPE\n${userFeedback}` : '';
        const contextSection = conversationContext ? `\n\n## BRAINSTORM CONTEXT\n${conversationContext}` : '';
        const prompt = `## PROJECT\nTitle: ${title}\n\n## REWRITE TASK\n${priorityTask}${feedbackSection}${contextSection}\n\n## FULL SCREENPLAY\n${fullScript}`;

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

        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: {
                systemInstruction: plannerSop,
                temperature: 0.2,
                responseMimeType: 'application/json',
                responseSchema: plannerSchema,
            },
        });

        const plan = JSON.parse(response.text);
        console.log(`Stage 9 plan: ${plan.affected_scenes.length} scenes affected.`);
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

        console.log(`Stage 9: rewriting ${scopedScenes.length} scene(s) for task: "${priorityTask.slice(0, 60)}..."`);

        const results = await Promise.allSettled(
            scopedScenes.map(s => {
                const sceneText = working[s.scene_number] || s.humanized_draft_text || s.draft_text || '';
                return rewriteScene(sceneText, priorityTask, {
                    title,
                    sceneNumber: s.scene_number,
                    slugline: s.slugline || s.scene_heading || '',
                }, '', getModelConfig(9)).then(proposed => ({ scene_number: s.scene_number, original_text: sceneText, proposed_text: proposed }));
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

        res.json({ scenes });
    } catch (error) {
        console.error('rewrite-for-priority error:', error.message);
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

        const proposed_text = await rewriteScene(currentText, priorityTask, { title, sceneNumber }, userFeedback, getModelConfig(9));
        res.json({ proposed_text });
    } catch (error) {
        console.error('rewrite-scene-feedback error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Mark Stage 9 as approved/finalized
app.post('/api/finalize-stage9', async (req, res) => {
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
        console.error('finalize-stage9 error:', error.message);
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

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
