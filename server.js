require('dotenv').config();
const express = require('express');
const { agent1Pitch } = require('./agents/agent_1_pitch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());

// API route
app.post('/api/execute', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: "Prompt is required" });
        }

        console.log("Generating pitch options...");
        const result = await agent1Pitch(prompt);
        res.json({ result });
    } catch (error) {
        console.error("Error executing agent:", error);
        res.status(500).json({ error: error.message || "An error occurred" });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
