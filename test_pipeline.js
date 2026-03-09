require('dotenv').config();
const { agent1Pitch } = require('./agents/agent_1_pitch');
const { agent2Outline } = require('./agents/agent_2_outline');
const { agent3Characters } = require('./agents/agent_3_characters');

// ANSI Color Codes
const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m"
};

async function runDiagnostic() {
    console.log(`${colors.cyan}--- Starting Pipeline Diagnostic Test ---${colors.reset}\n`);

    let mockPitch = null;
    let mockBeats = null;

    // --- STEP 1: Stage 1 Pitch ---
    try {
        console.log(`${colors.yellow}Testing Stage 1: Pitch Generation...${colors.reset}`);
        const result = await agent1Pitch("A sci-fi noir about a detective who can see 5 seconds into the future.", null);

        if (result && result.pitch_options && result.pitch_options.length > 0) {
            mockPitch = result.pitch_options[0];
            console.log(`${colors.green}✅ Stage 1 Passed: Generated ${result.pitch_options.length} options.${colors.reset}`);
            // console.log(JSON.stringify(mockPitch, null, 2));
        } else {
            throw new Error("Invalid Stage 1 response format (missing pitch_options).");
        }
    } catch (err) {
        console.error(`${colors.red}❌ Stage 1 Failed: ${err.message}${colors.reset}`);
        process.exit(1);
    }

    // --- STEP 2: Stage 2 Beats ---
    try {
        console.log(`\n${colors.yellow}Testing Stage 2: Beat Sheet Generation...${colors.reset}`);
        const result = await agent2Outline(mockPitch, null, null, null);

        if (result && result.outline && result.outline.act_1) {
            mockBeats = result.outline;
            console.log(`${colors.green}✅ Stage 2 Passed: 8-Sequence Outline generated.${colors.reset}`);
        } else {
            throw new Error("Invalid Stage 2 response format (missing outline structure).");
        }
    } catch (err) {
        console.error(`${colors.red}❌ Stage 2 Failed: ${err.message}${colors.reset}`);
        process.exit(1);
    }

    // --- STEP 3: Stage 3 Characters ---
    try {
        console.log(`\n${colors.yellow}Testing Stage 3: Character Development...${colors.reset}`);
        const result = await agent3Characters(mockPitch, mockBeats, null, null, null);

        if (result && result.characters && result.characters.length > 0) {
            const firstChar = result.characters[0];
            // Verify new brief_summary field
            if (firstChar.brief_summary) {
                console.log(`${colors.green}✅ Stage 3 Passed: ${result.characters.length} characters generated with brief summaries.${colors.reset}`);
            } else {
                console.warn(`${colors.yellow}⚠️  Stage 3 Warning: Characters generated but 'brief_summary' field is missing.${colors.reset}`);
            }
        } else {
            throw new Error("Invalid Stage 3 response format (missing characters array).");
        }
    } catch (err) {
        console.error(`${colors.red}❌ Stage 3 Failed: ${err.message}${colors.reset}`);
        process.exit(1);
    }

    console.log(`\n${colors.cyan}--- Pipeline Diagnostic Complete: ALL STAGES PASSED ---${colors.reset}`);
}

runDiagnostic().catch(err => {
    console.error(`\n${colors.red}FATAL ERROR: ${err.message}${colors.reset}`);
    process.exit(1);
});
