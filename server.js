require('dotenv').config();
const express = require('express');
const { agent1Pitch } = require('./agents/agent_1_pitch');
const { agent1Refine } = require('./agents/agent_1_refine');

const app = express();
const PORT = process.env.PORT || 3000;

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(express.static('public'));
app.use(express.json());

// API route
app.post('/api/execute', upload.single('pdfFile'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const pdfFile = req.file;

        if (!prompt && !pdfFile) {
            return res.status(400).json({ error: "Prompt or PDF file is required" });
        }

        console.log("Generating pitch options...");
        const result = await agent1Pitch(prompt, pdfFile);
        res.json({ result });
    } catch (error) {
        console.error("Error executing agent:", error);
        res.status(500).json({ error: error.message || "An error occurred" });
    }
});

app.post('/api/refine-pitch', async (req, res) => {
    try {
        const { currentPitch, userNote } = req.body;
        if (!currentPitch || !userNote) {
            return res.status(400).json({ error: "Missing currentPitch or userNote" });
        }

        console.log("Revising pitch...");
        const result = await agent1Refine(JSON.stringify(currentPitch), userNote);
        res.json({ result });
    } catch (error) {
        console.error("Error executing refine agent:", error);
        res.status(500).json({ error: error.message || "An error occurred" });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
