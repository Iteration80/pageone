require('dotenv').config();
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { agent1Pitch } = require('./agents/agent_1_pitch');
const { agent1Refine } = require('./agents/agent_1_refine');
const { agent2Outline } = require('./agents/agent_2_outline');
const { agent3Characters } = require('./agents/agent_3_characters');

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
        const result = await agent1Pitch(prompt, pdfFile);
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
        const result = await agent1Refine(JSON.stringify(parsedPitch), userNote, pdfFile);
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
        const outlineData = await agent2Outline(stage1, parsedBeats, notes, pdfFile);

        // Save to Stage 2
        projectData.data = projectData.data || {};
        projectData.data.stage2_outline = outlineData;

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
        const characterData = await agent3Characters(pitchData, beatsData, parsedChars, notes, pdfFile);

        // Save to Stage 3
        projectData.data = projectData.data || {};
        projectData.data.stage3_characters = characterData;

        await fs.writeFile(filePath, JSON.stringify(projectData, null, 2));

        res.json({ result: characterData });
    } catch (error) {
        console.error('Character Gen Error:', error);
        res.status(500).json({ error: error.message || "Failed to generate characters" });
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
